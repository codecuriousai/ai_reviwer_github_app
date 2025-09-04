// src/services/ai.service.js - Completely Fixed JSON Parsing with Proper Variable Scoping

const OpenAI = require('openai');
const { GoogleGenerativeAI } = require('@google/generative-ai');
const config = require('../config/config');
const logger = require('../utils/logger');
const { getCodeReviewPrompt, getFixSuggestionPrompt } = require('../prompts/prompts');
const { retryWithBackoff, sanitizeForAI, isValidJSON } = require('../utils/helpers');

class AIService {
  constructor() {
    this.provider = config.ai.provider;
    this.initializeProviders();
  }

  // Initialize AI providers
  initializeProviders() {
    try {
      if (this.provider === 'openai' || config.ai.openai.apiKey) {
        this.openai = new OpenAI({
          apiKey: config.ai.openai.apiKey,
        });
        logger.info('OpenAI client initialized');
      }

      if (this.provider === 'gemini' || config.ai.gemini.apiKey) {
        this.gemini = new GoogleGenerativeAI(config.ai.gemini.apiKey);
        this.geminiModel = this.gemini.getGenerativeModel({ 
          model: config.ai.gemini.model 
        });
        logger.info('Gemini client initialized');
      }
    } catch (error) {
      logger.error('Error initializing AI providers:', error);
      throw new Error('Failed to initialize AI providers');
    }
  }

  // Main function to analyze pull request
  async analyzePullRequest(prData, existingComments = []) {
    try {
      logger.info(`Starting AI analysis for PR #${prData.pr.number}`);

      // Prepare data for analysis
      const analysisData = this.prepareAnalysisData(prData, existingComments);
      const prompt = getCodeReviewPrompt(analysisData, existingComments);
      
      // Perform analysis with retry logic
      let rawResponse;
      try {
        rawResponse = await retryWithBackoff(async () => {
          if (this.provider === 'openai') {
            return await this.analyzeWithOpenAI(prompt);
          } else if (this.provider === 'gemini') {
            return await this.analyzeWithGemini(prompt);
          } else {
            throw new Error(`Unsupported AI provider: ${this.provider}`);
          }
        });
      } catch (aiError) {
        logger.error('AI provider error:', aiError);
        return this.createErrorFallbackAnalysis(`AI Provider Error: ${aiError.message}`);
      }

      // Validate and parse response
      let parsedAnalysis;
      try {
        parsedAnalysis = this.parseAnalysisResponse(rawResponse);
      } catch (parseError) {
        logger.error('Response parsing error:', parseError);
        return this.createErrorFallbackAnalysis(`Parsing Error: ${parseError.message}`);
      }

      // Enhance analysis with PR context
      const enhancedAnalysis = this.enhanceAnalysisWithContext(parsedAnalysis, prData, existingComments);
      
      // Generate code suggestions for each finding
      for (const finding of enhancedAnalysis.detailedFindings) {
        if (finding.file !== 'AI_PARSING_ERROR' && finding.file !== 'AI_SERVICE_ERROR') {
          try {
            const fileContent = prData.files.find(f => f.filename === finding.file)?.content || '';
            const fileSnippet = this.getLineContent(fileContent, finding.line);
            const fixSuggestion = await this.generateFixSuggestion(fileSnippet, finding.issue, finding.line);
            finding.suggestion = fixSuggestion;
          } catch (error) {
            logger.error(`Failed to generate fix suggestion for finding in ${finding.file}:${finding.line}:`, error);
            finding.suggestion = 'Unable to generate a specific code fix. Please review manually.';
          }
        }
      }

      logger.info(`AI analysis completed. Found ${enhancedAnalysis.automatedAnalysis.totalIssues} issues`);
      return enhancedAnalysis;
      
    } catch (error) {
      logger.error('Critical error in AI analysis:', error);
      return this.createErrorFallbackAnalysis(`Critical Error: ${error.message}`);
    }
  }

  // NEW: Helper function to get a snippet of code around a specific line
  getLineContent(fullContent, lineNumber, contextLines = 3) {
    if (!fullContent) return '';
    const lines = fullContent.split('\n');
    const start = Math.max(0, lineNumber - 1 - contextLines);
    const end = Math.min(lines.length, lineNumber + contextLines);
    return lines.slice(start, end).join('\n');
  }

  // Generate a code fix suggestion using AI
  async generateFixSuggestion(fileSnippet, issueDescription, lineNumber) {
    const prompt = getFixSuggestionPrompt(fileSnippet, issueDescription, lineNumber);
    let rawResponse;

    try {
      rawResponse = await retryWithBackoff(async () => {
        if (this.provider === 'openai') {
          return await this.analyzeWithOpenAI(prompt);
        } else if (this.provider === 'gemini') {
          return await this.analyzeWithGemini(prompt);
        } else {
          throw new Error(`Unsupported AI provider: ${this.provider}`);
        }
      });

      const parsed = JSON.parse(rawResponse);
      return parsed.suggestion || 'No specific fix suggestion provided.';
    } catch (error) {
      logger.error('Error generating fix suggestion:', error);
      return 'Failed to generate a specific fix suggestion.';
    }
  }

  // Prepare data for AI analysis with safe property access
  prepareAnalysisData(prData, existingComments) {
    const pr = prData.pr || prData || {};
    const files = prData.files || [];
    const diff = prData.diff || '';
    
    const sanitizedDiff = diff ? sanitizeForAI(diff) : 'No diff available';
    const truncatedDiff = sanitizedDiff.length > 8000 
      ? sanitizedDiff.substring(0, 8000) + '\n... [truncated for analysis]' 
      : sanitizedDiff;

    return {
      pr: {
        number: pr.number || 0,
        title: pr.title || 'No title',
        description: pr.description || 'No description',
        author: pr.author || 'unknown',
        repository: pr.repository || 'owner/repo',
        targetBranch: pr.targetBranch || 'unknown',
        sourceBranch: pr.sourceBranch || 'unknown',
        additions: pr.additions || 0,
        deletions: pr.deletions || 0,
        url: pr.url || '#',
      },
      files: files.map(file => ({
        filename: file.filename || 'unknown',
        status: file.status || 'unknown',
        additions: file.additions || 0,
        deletions: file.deletions || 0,
        changes: file.changes || 0,
        content: file.content || '' // Include file content for fix suggestions
      })),
      diff: truncatedDiff,
      comments: existingComments || [],
    };
  }

  // OpenAI analysis
  async analyzeWithOpenAI(prompt) {
    try {
      logger.info('Sending request to OpenAI');
      
      const response = await this.openai.chat.completions.create({
        model: config.ai.openai.model,
        messages: [
          {
            role: 'system',
            content: `You are an expert code reviewer. You MUST respond with ONLY valid JSON in the exact format specified. Do not include markdown formatting or additional text.`,
          },
          {
            role: 'user',
            content: prompt,
          },
        ],
        max_tokens: config.ai.openai.maxTokens,
        temperature: config.ai.openai.temperature,
        response_format: { type: 'json_object' },
      });

      const content = response.choices[0].message.content.trim();
      logger.info(`OpenAI response received (${content.length} characters)`);
      
      return content;
    } catch (error) {
      logger.error('OpenAI API error:', error);
      throw new Error(`OpenAI failed: ${error.message}`);
    }
  }

  // Gemini analysis
  async analyzeWithGemini(prompt) {
    try {
      logger.info('Sending request to Gemini');
      
      const enhancedPrompt = `${prompt}\n\nIMPORTANT: Respond ONLY with valid JSON. No markdown formatting.`;
      
      const result = await this.geminiModel.generateContent({
        contents: [{
          role: 'user',
          parts: [{ text: enhancedPrompt }],
        }],
        generationConfig: {
          maxOutputTokens: config.ai.gemini.maxTokens,
          temperature: config.ai.gemini.temperature,
        },
      });

      const response = await result.response;
      const content = response.text().trim();
      
      logger.info(`Gemini response received (${content.length} characters)`);
      
      return content;
    } catch (error) {
      logger.error('Gemini API error:', error);
      throw new Error(`Gemini failed: ${error.message}`);
    }
  }

  // COMPLETELY REWRITTEN: Safe JSON parsing with proper error handling
  parseAnalysisResponse(responseText) {
    // Initialize variables at the top to avoid scoping issues
    let originalResponse = '';
    let cleanedResponse = '';
    let parseError = null;
    
    try {
      // Validate input
      if (!responseText || typeof responseText !== 'string') {
        throw new Error('Invalid response: empty or non-string response received from AI');
      }

      originalResponse = responseText;
      cleanedResponse = responseText.trim();
      
      logger.debug('Starting to parse AI response', { 
        originalLength: originalResponse.length,
        preview: originalResponse.substring(0, 200)
      });

      // Step 1: Remove markdown formatting
      cleanedResponse = cleanedResponse.replace(/```json\s*/g, '');
      cleanedResponse = cleanedResponse.replace(/```\s*/g, '');
      
      // Step 2: Find JSON boundaries
      const firstBraceIndex = cleanedResponse.indexOf('{');
      const lastBraceIndex = cleanedResponse.lastIndexOf('}');
      
      if (firstBraceIndex === -1 || lastBraceIndex === -1) {
        throw new Error(`No valid JSON object found in response. First brace at: ${firstBraceIndex}, Last brace at: ${lastBraceIndex}`);
      }
      
      // Extract JSON portion
      cleanedResponse = cleanedResponse.substring(firstBraceIndex, lastBraceIndex + 1);
      
      // Step 3: Clean common JSON issues
      cleanedResponse = cleanedResponse
        .replace(/\n\s*\/\/.*/g, '') // Remove comments
        .replace(/\/\*[\s\S]*?\*\//g, '') // Remove multi-line comments
        .replace(/,(\s*[}\]])/g, '$1'); // Remove trailing commas
      
      logger.debug('Cleaned response for parsing', { 
        cleanedLength: cleanedResponse.length,
        preview: cleanedResponse.substring(0, 200)
      });

      // Step 4: Validate JSON format
      if (!cleanedResponse.startsWith('{') || !cleanedResponse.endsWith('}')) {
        throw new Error(`Invalid JSON boundaries after cleaning. Starts: '${cleanedResponse.substring(0, 10)}', Ends: '${cleanedResponse.slice(-10)}'`);
      }

      // Step 5: Parse JSON
      let analysis;
      try {
        analysis = JSON.parse(cleanedResponse);
      } catch (jsonError) {
        throw new Error(`JSON.parse failed: ${jsonError.message}. Cleaned response: ${cleanedResponse.substring(0, 500)}`);
      }

      // Step 6: Validate structure
      this.validateAndNormalizeAnalysis(analysis);
      
      logger.info('Successfully parsed and validated AI analysis response');
      return analysis;

    } catch (error) {
      parseError = error;
      logger.error('Failed to parse AI response', {
        error: error.message,
        originalResponseLength: originalResponse.length,
        cleanedResponseLength: cleanedResponse.length,
        originalPreview: originalResponse.substring(0, 300),
        cleanedPreview: cleanedResponse.substring(0, 300)
      });

      // Return fallback analysis with detailed error info
      return this.createParsingErrorFallback(error.message, originalResponse, cleanedResponse);
    }
  }

  // Validate and normalize analysis structure
  validateAndNormalizeAnalysis(analysis) {
    // Check required top-level fields
    const requiredFields = ['prInfo', 'automatedAnalysis', 'humanReviewAnalysis', 'reviewAssessment', 'recommendation'];
    
    for (const field of requiredFields) {
      if (!analysis[field]) {
        // Create default structure if missing
        analysis[field] = this.getDefaultFieldValue(field);
        logger.warn(`Missing required field '${field}', using default value`);
      }
    }

    // Normalize automatedAnalysis
    if (!analysis.automatedAnalysis.severityBreakdown) {
      analysis.automatedAnalysis.severityBreakdown = {
        blocker: 0, critical: 0, major: 0, minor: 0, info: 0
      };
    }
    
    if (!analysis.automatedAnalysis.categories) {
      analysis.automatedAnalysis.categories = {
        bugs: 0, vulnerabilities: 0, securityHotspots: 0, codeSmells: 0
      };
    }

    // Normalize detailedFindings
    if (!Array.isArray(analysis.detailedFindings)) {
      analysis.detailedFindings = [];
    }

    // Normalize each finding
    analysis.detailedFindings = analysis.detailedFindings.map((finding, index) => {
      return {
        file: String(finding.file || finding.filename || `unknown-file-${index}`),
        line: Number(finding.line || finding.lineNumber || 1),
        issue: String(finding.issue || finding.description || finding.message || 'No description provided'),
        severity: this.normalizeSeverity(finding.severity || finding.level),
        category: this.normalizeCategory(finding.category || finding.type),
        suggestion: String(finding.suggestion || finding.fix || finding.recommendation || 'No suggestion provided')
      };
    });

    // Ensure numeric fields
    analysis.automatedAnalysis.totalIssues = Number(analysis.automatedAnalysis.totalIssues) || 0;
    analysis.automatedAnalysis.technicalDebtMinutes = Number(analysis.automatedAnalysis.technicalDebtMinutes) || 0;

    // Validate review assessment
    const validAssessments = ['PROPERLY REVIEWED', 'NOT PROPERLY REVIEWED', 'REVIEW REQUIRED'];
    if (!validAssessments.includes(analysis.reviewAssessment)) {
      analysis.reviewAssessment = 'REVIEW REQUIRED';
    }
  }

  // Get default value for missing fields
  getDefaultFieldValue(fieldName) {
    const defaults = {
      prInfo: {
        prId: 'unknown',
        title: 'Unknown',
        repository: 'unknown/unknown',
        author: 'unknown',
        reviewers: [],
        url: '#'
      },
      automatedAnalysis: {
        totalIssues: 0,
        severityBreakdown: { blocker: 0, critical: 0, major: 0, minor: 0, info: 0 },
        categories: { bugs: 0, vulnerabilities: 0, securityHotspots: 0, codeSmells: 0 },
        technicalDebtMinutes: 0
      },
      humanReviewAnalysis: {
        reviewComments: 0,
        issuesAddressedByReviewers: 0,
        securityIssuesCaught: 0,
        codeQualityIssuesCaught: 0
      },
      reviewAssessment: 'REVIEW REQUIRED',
      recommendation: 'Unable to generate recommendation due to parsing issues',
      detailedFindings: []
    };

    return defaults[fieldName] || null;
  }

  // Normalize severity values
  normalizeSeverity(severity) {
    const severityStr = String(severity || 'INFO').toUpperCase();
    const validSeverities = ['BLOCKER', 'CRITICAL', 'MAJOR', 'MINOR', 'INFO'];
    return validSeverities.includes(severityStr) ? severityStr : 'INFO';
  }

  // Normalize category values
  normalizeCategory(category) {
    const categoryStr = String(category || 'CODE_SMELL').toUpperCase();
    const validCategories = ['BUG', 'VULNERABILITY', 'SECURITY_HOTSPOT', 'CODE_SMELL'];
    return validCategories.includes(categoryStr) ? categoryStr : 'CODE_SMELL';
  }

  // Create parsing error fallback
  createParsingErrorFallback(errorMessage, originalResponse, cleanedResponse) {
    return {
      prInfo: {
        prId: 'parsing-error',
        title: 'AI Response Parsing Error',
        repository: 'unknown/unknown',
        author: 'unknown',
        reviewers: [],
        url: '#'
      },
      automatedAnalysis: {
        totalIssues: 1,
        severityBreakdown: { blocker: 0, critical: 0, major: 1, minor: 0, info: 0 },
        categories: { bugs: 0, vulnerabilities: 0, securityHotspots: 0, codeSmells: 1 },
        technicalDebtMinutes: 15
      },
      humanReviewAnalysis: {
        reviewComments: 0,
        issuesAddressedByReviewers: 0,
        securityIssuesCaught: 0,
        codeQualityIssuesCaught: 0
      },
      reviewAssessment: 'REVIEW REQUIRED',
      detailedFindings: [{
        file: 'AI_PARSING_ERROR',
        line: 1,
        issue: `Failed to parse AI response: ${errorMessage}`,
        severity: 'MAJOR',
        category: 'CODE_SMELL',
        suggestion: `Check AI service configuration. Original response length: ${originalResponse.length}, Cleaned length: ${cleanedResponse.length}. Review server logs for full details.`
      }],
      recommendation: `AI response parsing failed: ${errorMessage}. Please check AI provider configuration, API keys, and network connectivity. See server logs for detailed debugging information.`
    };
  }

  // Create general error fallback
  createErrorFallbackAnalysis(errorMessage) {
    return {
      prInfo: {
        prId: 'error',
        title: 'AI Analysis Error',
        repository: 'unknown/unknown',
        author: 'unknown',
        reviewers: [],
        url: '#'
      },
      automatedAnalysis: {
        totalIssues: 1,
        severityBreakdown: { blocker: 0, critical: 1, major: 0, minor: 0, info: 0 },
        categories: { bugs: 0, vulnerabilities: 0, securityHotspots: 0, codeSmells: 1 },
        technicalDebtMinutes: 30
      },
      humanReviewAnalysis: {
        reviewComments: 0,
        issuesAddressedByReviewers: 0,
        securityIssuesCaught: 0,
        codeQualityIssuesCaught: 0
      },
      reviewAssessment: 'REVIEW REQUIRED',
      detailedFindings: [{
        file: 'AI_SERVICE_ERROR',
        line: 1,
        issue: `AI analysis service error: ${errorMessage}`,
        severity: 'CRITICAL',
        category: 'CODE_SMELL',
        suggestion: 'Check AI service configuration, API keys, and ensure the service is available. Review application logs for detailed error information.'
      }],
      recommendation: `AI analysis encountered an error: ${errorMessage}. Please verify configuration and try again.`
    };
  }

  // Enhance analysis with PR context
  enhanceAnalysisWithContext(analysis, prData, existingComments) {
    // Safely enhance prInfo
    if (analysis.prInfo && prData.pr) {
      analysis.prInfo.prId = prData.pr.number;
      analysis.prInfo.title = prData.pr.title;
      analysis.prInfo.repository = prData.pr.repository;
      analysis.prInfo.author = prData.pr.author;
      analysis.prInfo.url = prData.pr.url;
      analysis.prInfo.reviewers = prData.reviewers || [];
    }

    // Enhance human review analysis
    if (analysis.humanReviewAnalysis) {
      analysis.humanReviewAnalysis.reviewComments = existingComments.length;
      analysis.humanReviewAnalysis.issuesAddressedByReviewers = this.countIssuesInComments(existingComments);
      analysis.humanReviewAnalysis.securityIssuesCaught = this.countSecurityIssuesInComments(existingComments);
      analysis.humanReviewAnalysis.codeQualityIssuesCaught = this.countCodeQualityIssuesInComments(existingComments);
    }

    return analysis;
  }

  // Check AI service health
  async checkHealth() {
    try {
      const testPrompt = `{"status": "OK", "test": true}`;
      
      if (this.provider === 'openai' && this.openai) {
        const response = await this.openai.chat.completions.create({
          model: config.ai.openai.model,
          messages: [{ role: 'user', content: `Return exactly: ${testPrompt}` }],
          max_tokens: 50,
          response_format: { type: 'json_object' },
        });
        
        const content = response.choices[0].message.content.trim();
        const parsed = JSON.parse(content);
        return parsed.status === 'OK';
        
      } else if (this.provider === 'gemini' && this.geminiModel) {
        const result = await this.geminiModel.generateContent(`Return exactly: ${testPrompt}`);
        const response = await result.response;
        const content = response.text().trim();
        const parsed = JSON.parse(content);
        return parsed.status === 'OK';
      }
      
      return false;
    } catch (error) {
      logger.error('AI health check failed:', error);
      return false;
    }
  }

  // Helper methods for comment analysis
  countIssuesInComments(comments) {
    if (!Array.isArray(comments)) return 0;
    
    const issueKeywords = ['bug', 'issue', 'problem', 'error', 'fix', 'wrong'];
    let count = 0;
    
    comments.forEach(comment => {
      if (comment.body) {
        const body = comment.body.toLowerCase();
        if (issueKeywords.some(keyword => body.includes(keyword))) {
          count++;
        }
      }
    });
    
    return count;
  }

  countSecurityIssuesInComments(comments) {
    if (!Array.isArray(comments)) return 0;
    
    const securityKeywords = ['security', 'vulnerability', 'exploit', 'injection'];
    let count = 0;
    
    comments.forEach(comment => {
      if (comment.body) {
        const body = comment.body.toLowerCase();
        if (securityKeywords.some(keyword => body.includes(keyword))) {
          count++;
        }
      }
    });
    
    return count;
  }

  countCodeQualityIssuesInComments(comments) {
    if (!Array.isArray(comments)) return 0;
    
    const qualityKeywords = ['refactor', 'clean', 'maintainable', 'complex'];
    let count = 0;
    
    comments.forEach(comment => {
      if (comment.body) {
        const body = comment.body.toLowerCase();
        if (qualityKeywords.some(keyword => body.includes(keyword))) {
          count++;
        }
      }
    });
    
    return count;
  }
}

module.exports = new AIService();