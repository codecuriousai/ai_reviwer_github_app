// src/services/ai.service.js - Fixed JSON Parsing Issues

const OpenAI = require('openai');
const { GoogleGenerativeAI } = require('@google/generative-ai');
const config = require('../config/config');
const logger = require('../utils/logger');
const { getCodeReviewPrompt } = require('../prompts/prompts');
const { retryWithBackoff, sanitizeForAI, isValidJSON, cleanJSONResponse } = require('../utils/helpers');

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

      console.log('=== AI ANALYSIS INPUT DEBUG ===');
      console.log('PR Data:', JSON.stringify({
        pr: prData.pr,
        fileCount: prData.files?.length || 0,
        commentCount: existingComments?.length || 0
      }, null, 2));
      console.log('=== END INPUT DEBUG ===');

      // Prepare data for analysis
      const analysisData = this.prepareAnalysisData(prData, existingComments);
      const prompt = getCodeReviewPrompt(analysisData, existingComments);
      
      // Perform analysis with retry logic
      const analysis = await retryWithBackoff(async () => {
        if (this.provider === 'openai') {
          return await this.analyzeWithOpenAI(prompt);
        } else if (this.provider === 'gemini') {
          return await this.analyzeWithGemini(prompt);
        } else {
          throw new Error(`Unsupported AI provider: ${this.provider}`);
        }
      });

       // CONSOLE LOG: Debug raw AI response
      console.log('=== RAW AI RESPONSE ===');
      console.log('Response length:', rawResponse.length);
      console.log('Raw response:', rawResponse);
      console.log('=== END RAW RESPONSE ===');

      // Validate and parse response
      const parsedAnalysis = this.parseAnalysisResponse(analysis);
      
      // CONSOLE LOG: Debug parsed analysis
      console.log('=== PARSED ANALYSIS ===');
      console.log('Parsed analysis:', JSON.stringify(parsedAnalysis, null, 2));
      console.log('=== END PARSED ANALYSIS ===');

      // Enhance analysis with PR context
      const enhancedAnalysis = this.enhanceAnalysisWithContext(parsedAnalysis, prData, existingComments);
      
      // CONSOLE LOG: Debug final analysis
      console.log('=== FINAL ENHANCED ANALYSIS ===');
      console.log('Enhanced analysis:', JSON.stringify(enhancedAnalysis, null, 2));
      console.log('=== END FINAL ANALYSIS ===');
      

      logger.info(`AI analysis completed. Found ${enhancedAnalysis.automatedAnalysis.totalIssues} issues`);
      return enhancedAnalysis;
    } catch (error) {
      logger.error('Error in AI analysis:', error);
      throw new Error(`AI analysis failed: ${error.message}`);
    }
  }

  // Prepare data for AI analysis with safe property access
  prepareAnalysisData(prData, existingComments) {
    // Safely extract data with fallbacks
    const pr = prData.pr || prData || {};
    const files = prData.files || [];
    const diff = prData.diff || '';
    
    // Sanitize and truncate data for AI processing
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
      })),
      diff: truncatedDiff,
      comments: existingComments || [],
    };
  }

  // OpenAI analysis - FIXED: Better JSON handling
  async analyzeWithOpenAI(prompt) {
    try {
      logger.info('Sending request to OpenAI');
      
      const response = await this.openai.chat.completions.create({
        model: config.ai.openai.model,
        messages: [
          {
            role: 'system',
            content: `You are an expert code reviewer specializing in SonarQube standards. 
            
CRITICAL: You MUST respond with ONLY valid JSON in the exact format specified. 
Do not include any markdown formatting, code blocks, or additional text.
Your response must start with { and end with }.
            
Focus on providing a comprehensive analysis in a single structured response.`,
          },
          {
            role: 'user',
            content: prompt,
          },
        ],
        max_tokens: config.ai.openai.maxTokens,
        temperature: config.ai.openai.temperature,
        response_format: { type: 'json_object' }, // Force JSON response
      });

      const content = response.choices[0].message.content.trim();
      logger.info(`OpenAI response received (${content.length} characters)`);
      
      // Log first 200 chars for debugging
      logger.debug('OpenAI response preview:', content.substring(0, 200));
      
      return content;
    } catch (error) {
      logger.error('OpenAI API error:', error);
      
      if (error.status === 429) {
        throw new Error('OpenAI rate limit exceeded. Please try again later.');
      } else if (error.status === 401) {
        throw new Error('Invalid OpenAI API key.');
      } else if (error.status >= 500) {
        throw new Error('OpenAI service unavailable. Please try again later.');
      }
      
      throw new Error(`OpenAI analysis failed: ${error.message}`);
    }
  }

  // Gemini analysis - FIXED: Better JSON handling
  async analyzeWithGemini(prompt) {
    try {
      logger.info('Sending request to Gemini');
      
      const enhancedPrompt = `${prompt}

CRITICAL INSTRUCTIONS:
- Respond ONLY with valid JSON
- Do not include any markdown formatting (no \`\`\`json blocks)
- Do not include any additional text before or after the JSON
- Your response must start with { and end with }
- Ensure all strings are properly escaped
- Make sure all required fields are present`;
      
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
      let content = response.text().trim();
      
      logger.info(`Gemini response received (${content.length} characters)`);
      logger.debug('Gemini response preview:', content.substring(0, 200));
      
      return content;
    } catch (error) {
      logger.error('Gemini API error:', error);
      
      if (error.message.includes('quota')) {
        throw new Error('Gemini quota exceeded. Please try again later.');
      } else if (error.message.includes('authentication')) {
        throw new Error('Invalid Gemini API key.');
      }
      
      throw new Error(`Gemini analysis failed: ${error.message}`);
    }
  }

  // FIXED: Enhanced JSON parsing with better error handling
  parseAnalysisResponse(responseText) {
    try {
      logger.debug('Parsing AI response:', responseText.substring(0, 300));
      
      // Clean response text
      let cleanedResponse = responseText.trim();
      
      // Remove markdown code blocks if present
      cleanedResponse = cleanedResponse.replace(/```json\s*/g, '').replace(/```\s*/g, '');
      
      // Remove any text before the first {
      const firstBraceIndex = cleanedResponse.indexOf('{');
      if (firstBraceIndex > 0) {
        cleanedResponse = cleanedResponse.substring(firstBraceIndex);
      }
      
      // Remove any text after the last }
      const lastBraceIndex = cleanedResponse.lastIndexOf('}');
      if (lastBraceIndex >= 0 && lastBraceIndex < cleanedResponse.length - 1) {
        cleanedResponse = cleanedResponse.substring(0, lastBraceIndex + 1);
      }
      
      // Additional cleaning for common issues
      cleanedResponse = cleanedResponse
        .replace(/\n\s*\/\/.*/g, '') // Remove single-line comments
        .replace(/\/\*[\s\S]*?\*\//g, '') // Remove multi-line comments
        .replace(/,\s*}/g, '}') // Remove trailing commas
        .replace(/,\s*]/g, ']'); // Remove trailing commas in arrays
      
      // Validate JSON format
      if (!cleanedResponse.startsWith('{') || !cleanedResponse.endsWith('}')) {
        throw new Error(`Response doesn't appear to be JSON object. Starts with: '${cleanedResponse.substring(0, 20)}', Ends with: '${cleanedResponse.slice(-20)}'`);
      }
      
      // Test JSON validity
      if (!isValidJSON(cleanedResponse)) {
        throw new Error('Cleaned response is not valid JSON');
      }
      
      const analysis = JSON.parse(cleanedResponse);
      
      // Validate required fields
      this.validateAnalysisStructure(analysis);
      
      logger.info('Successfully parsed AI analysis response');
      return analysis;
      
    } catch (parseError) {
      logger.error('Error parsing AI response:', parseError);
      logger.error('Raw response (first 500 chars):', responseText.substring(0, 500));
      logger.error('Cleaned response (first 500 chars):', cleanedResponse ? cleanedResponse.substring(0, 500) : 'undefined');
      
      // Return fallback structure with specific error details
      return this.getFallbackAnalysis(`JSON parsing failed: ${parseError.message}. Response preview: ${responseText.substring(0, 100)}`);
    }
  }

  // FIXED: More robust structure validation
  validateAnalysisStructure(analysis) {
    const requiredFields = {
      'prInfo': 'object',
      'automatedAnalysis': 'object',
      'humanReviewAnalysis': 'object',
      'reviewAssessment': 'string',
      'recommendation': 'string'
    };
    
    // Check required top-level fields
    for (const [field, expectedType] of Object.entries(requiredFields)) {
      if (!analysis[field]) {
        throw new Error(`Missing required field: ${field}`);
      }
      if (typeof analysis[field] !== expectedType) {
        throw new Error(`Field '${field}' should be ${expectedType}, got ${typeof analysis[field]}`);
      }
    }
    
    // Validate nested structures with defaults
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

    if (!Array.isArray(analysis.detailedFindings)) {
      analysis.detailedFindings = [];
    }

    // FIXED: Normalize detailedFindings properties
    if (analysis.detailedFindings && analysis.detailedFindings.length > 0) {
      analysis.detailedFindings = analysis.detailedFindings.map(finding => {
        // Console log each finding for debugging
        console.log('Raw finding from AI:', JSON.stringify(finding, null, 2));
        
        // Normalize property names - AI might use different names
        const normalizedFinding = {
          file: finding.file || finding.filename || finding.fileName || 'unknown-file',
          line: finding.line || finding.lineNumber || finding.lineNum || 1,
          issue: finding.issue || finding.description || finding.message || finding.title || 'No description',
          severity: finding.severity || finding.level || 'INFO',
          category: finding.category || finding.type || finding.kind || 'CODE_SMELL',
          suggestion: finding.suggestion || finding.fix || finding.recommendation || finding.solution || 'No suggestion provided'
        };
        
        // Ensure severity is uppercase and valid
        normalizedFinding.severity = normalizedFinding.severity.toString().toUpperCase();
        if (!['BLOCKER', 'CRITICAL', 'MAJOR', 'MINOR', 'INFO'].includes(normalizedFinding.severity)) {
          normalizedFinding.severity = 'INFO';
        }
        
        // Ensure category is uppercase and valid
        normalizedFinding.category = normalizedFinding.category.toString().toUpperCase();
        if (!['BUG', 'VULNERABILITY', 'SECURITY_HOTSPOT', 'CODE_SMELL'].includes(normalizedFinding.category)) {
          normalizedFinding.category = 'CODE_SMELL';
        }
        
        console.log('Normalized finding:', JSON.stringify(normalizedFinding, null, 2));
        return normalizedFinding;
      });
    }


    // Ensure numeric fields are numbers
    analysis.automatedAnalysis.totalIssues = Number(analysis.automatedAnalysis.totalIssues) || 0;
    analysis.automatedAnalysis.technicalDebtMinutes = Number(analysis.automatedAnalysis.technicalDebtMinutes) || 0;

    // Validate review assessment options
    const validAssessments = ['PROPERLY REVIEWED', 'NOT PROPERLY REVIEWED', 'REVIEW REQUIRED'];
    if (!validAssessments.includes(analysis.reviewAssessment)) {
      logger.warn(`Invalid reviewAssessment: ${analysis.reviewAssessment}, defaulting to REVIEW REQUIRED`);
      analysis.reviewAssessment = 'REVIEW REQUIRED';
    }

    logger.debug('Analysis structure validation passed');
  }

  // Enhance analysis with PR context
  enhanceAnalysisWithContext(analysis, prData, existingComments) {
    // Ensure prInfo is populated with actual data
    analysis.prInfo = {
      prId: prData.pr.number,
      title: prData.pr.title,
      repository: prData.pr.repository,
      author: prData.pr.author,
      reviewers: prData.reviewers || [],
      url: prData.pr.url,
    };

    // Enhance human review analysis with actual comment data
    analysis.humanReviewAnalysis = {
      reviewComments: existingComments.length,
      issuesAddressedByReviewers: this.countIssuesInComments(existingComments),
      securityIssuesCaught: this.countSecurityIssuesInComments(existingComments),
      codeQualityIssuesCaught: this.countCodeQualityIssuesInComments(existingComments),
    };

    // Set review assessment based on analysis
    if (existingComments.length === 0) {
      analysis.reviewAssessment = 'REVIEW REQUIRED';
    } else if (analysis.automatedAnalysis.totalIssues > analysis.humanReviewAnalysis.issuesAddressedByReviewers) {
      analysis.reviewAssessment = 'NOT PROPERLY REVIEWED';
    } else {
      analysis.reviewAssessment = 'PROPERLY REVIEWED';
    }

    return analysis;
  }

  // FIXED: Enhanced fallback analysis with better error context
  getFallbackAnalysis(errorMessage) {
    logger.info('Creating fallback analysis due to parsing error');
    
    return {
      prInfo: {
        prId: 'unknown',
        title: 'AI Analysis Error',
        repository: 'unknown/unknown',
        author: 'unknown',
        reviewers: [],
        url: '#'
      },
      automatedAnalysis: {
        totalIssues: 1,
        severityBreakdown: {
          blocker: 0,
          critical: 0,
          major: 1,
          minor: 0,
          info: 0
        },
        categories: {
          bugs: 0,
          vulnerabilities: 0,
          securityHotspots: 0,
          codeSmells: 1
        },
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
        file: 'AI_ANALYSIS_ERROR',
        line: 1,
        issue: `AI analysis parsing error: ${errorMessage}`,
        severity: 'MAJOR',
        category: 'CODE_SMELL',
        suggestion: 'Check AI service configuration, API keys, and ensure the AI model is responding with valid JSON format'
      }],
      recommendation: 'Fix AI analysis configuration to get proper code review feedback. Verify API keys, check network connectivity, and ensure the AI service is responding with properly formatted JSON.'
    };
  }

  // Check AI service health
  async checkHealth() {
    try {
      const testPrompt = `Respond with this exact JSON and nothing else: {"status": "OK", "test": true}`;
      
      if (this.provider === 'openai') {
        const response = await this.openai.chat.completions.create({
          model: config.ai.openai.model,
          messages: [{ role: 'user', content: testPrompt }],
          max_tokens: 50,
          response_format: { type: 'json_object' },
        });
        
        const content = response.choices[0].message.content.trim();
        const parsed = JSON.parse(content);
        return parsed.status === 'OK';
        
      } else if (this.provider === 'gemini') {
        const result = await this.geminiModel.generateContent(testPrompt);
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

  // Count issues mentioned in human review comments
  countIssuesInComments(comments) {
    const issueKeywords = [
      'bug', 'issue', 'problem', 'error', 'fix', 'wrong', 'incorrect', 
      'security', 'vulnerability', 'risk', 'unsafe', 'dangerous'
    ];
    
    let issueCount = 0;
    comments.forEach(comment => {
      const body = comment.body.toLowerCase();
      issueKeywords.forEach(keyword => {
        if (body.includes(keyword)) {
          issueCount++;
        }
      });
    });
    
    return Math.min(issueCount, comments.length); // Cap at number of comments
  }

  // Count security issues in comments
  countSecurityIssuesInComments(comments) {
    const securityKeywords = [
      'security', 'vulnerability', 'exploit', 'injection', 'xss', 'csrf',
      'authentication', 'authorization', 'encryption', 'password', 'token'
    ];
    
    let securityCount = 0;
    comments.forEach(comment => {
      const body = comment.body.toLowerCase();
      if (securityKeywords.some(keyword => body.includes(keyword))) {
        securityCount++;
      }
    });
    
    return securityCount;
  }

  // Count code quality issues in comments
  countCodeQualityIssuesInComments(comments) {
    const qualityKeywords = [
      'refactor', 'clean', 'readable', 'maintainable', 'complex', 'duplicate',
      'naming', 'structure', 'design', 'pattern', 'smell'
    ];
    
    let qualityCount = 0;
    comments.forEach(comment => {
      const body = comment.body.toLowerCase();
      if (qualityKeywords.some(keyword => body.includes(keyword))) {
        qualityCount++;
      }
    });
    
    return qualityCount;
  }
}

module.exports = new AIService();