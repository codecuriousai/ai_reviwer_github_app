const OpenAI = require('openai');
const { GoogleGenerativeAI } = require('@google/generative-ai');
const config = require('../config/config');
const logger = require('../utils/logger');
const { getCodeReviewPrompt } = require('../prompts/prompts');
const { retryWithBackoff, sanitizeForAI, isValidJSON } = require('../utils/helpers');

class AIService {
  constructor() {
    this.provider = config.ai.provider;
    this.initializeProviders();
  }

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

  // Main function to analyze pull request with enhanced error handling
  async analyzePullRequest(prData, existingComments = []) {
    try {
      logger.info(`Starting AI analysis for PR #${prData.pr.number}`);

      // Prepare data for analysis with safe property access
      const analysisData = this.prepareAnalysisData(prData, existingComments);
      const prompt = getCodeReviewPrompt(analysisData, existingComments);
      
      // Perform analysis with multiple retry attempts
      const analysis = await retryWithBackoff(async () => {
        if (this.provider === 'openai') {
          return await this.analyzeWithOpenAI(prompt);
        } else if (this.provider === 'gemini') {
          return await this.analyzeWithGemini(prompt);
        } else {
          throw new Error(`Unsupported AI provider: ${this.provider}`);
        }
      }, 3, 2000); // 3 retries with 2 second base delay

      // Enhanced parsing with better error handling
      const parsedAnalysis = this.parseAnalysisResponse(analysis, prData);
      
      // Enhance analysis with PR context
      const enhancedAnalysis = this.enhanceAnalysisWithContext(parsedAnalysis, prData, existingComments);
      
      logger.info(`AI analysis completed successfully. Found ${enhancedAnalysis.automatedAnalysis.totalIssues} issues`);
      return enhancedAnalysis;
    } catch (error) {
      logger.error('Error in AI analysis:', error);
      throw new Error(`AI analysis failed: ${error.message}`);
    }
  }

  // Prepare data with comprehensive null safety
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
      })),
      diff: truncatedDiff,
      comments: existingComments || [],
    };
  }

  // Enhanced OpenAI analysis with better prompt engineering
  async analyzeWithOpenAI(prompt) {
    try {
      logger.info('Sending request to OpenAI');
      
      const response = await this.openai.chat.completions.create({
        model: config.ai.openai.model,
        messages: [
          {
            role: 'system',
            content: 'You are an expert code reviewer specializing in SonarQube standards. You MUST respond with valid JSON in the exact format specified. Do not include any text outside the JSON structure.',
          },
          {
            role: 'user',
            content: prompt + '\n\nIMPORTANT: Respond with ONLY valid JSON. No markdown, no explanations, just the JSON object in the specified format.',
          },
        ],
        max_tokens: config.ai.openai.maxTokens,
        temperature: config.ai.openai.temperature,
        response_format: { type: 'json_object' },
      });

      const content = response.choices[0].message.content;
      logger.info(`OpenAI response received (${content.length} characters)`);
      
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

  // Enhanced Gemini analysis
  async analyzeWithGemini(prompt) {
    try {
      logger.info('Sending request to Gemini');
      
      const enhancedPrompt = prompt + '\n\nCRITICAL: You must respond with ONLY valid JSON in the exact format specified. Do not include markdown formatting, explanations, or any text outside the JSON structure. Start your response with { and end with }.';
      
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
      const content = response.text();
      
      logger.info(`Gemini response received (${content.length} characters)`);
      
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

  // Enhanced JSON parsing with multiple fallback strategies
  parseAnalysisResponse(responseText, prData) {
    try {
      let cleanedResponse = responseText.trim();
      
      // Remove markdown code blocks
      cleanedResponse = cleanedResponse.replace(/```json\n?/g, '').replace(/```\n?/g, '');
      
      // Remove any text before first { and after last }
      const firstBrace = cleanedResponse.indexOf('{');
      const lastBrace = cleanedResponse.lastIndexOf('}');
      
      if (firstBrace !== -1 && lastBrace !== -1 && lastBrace > firstBrace) {
        cleanedResponse = cleanedResponse.substring(firstBrace, lastBrace + 1);
      }
      
      // Validate JSON
      if (!isValidJSON(cleanedResponse)) {
        throw new Error('Response is not valid JSON after cleaning');
      }
      
      const analysis = JSON.parse(cleanedResponse);
      
      // Validate structure
      this.validateAnalysisStructure(analysis);
      
      logger.info('AI response parsed successfully');
      return analysis;
    } catch (error) {
      logger.error('Error parsing AI response:', error);
      logger.error('Raw response preview:', responseText.substring(0, 500) + '...');
      
      // Create a valid fallback analysis
      return this.createValidFallbackAnalysis(prData, error.message);
    }
  }

  // Create properly structured fallback analysis
  createValidFallbackAnalysis(prData, errorMessage) {
    const pr = prData.pr || {};
    
    return {
      prInfo: {
        prId: pr.number || 0,
        title: pr.title || 'Unknown',
        repository: pr.repository || 'unknown/unknown',
        author: pr.author || 'unknown',
        reviewers: [],
        url: pr.url || '#',
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
        reviewComments: prData.comments ? prData.comments.length : 0,
        issuesAddressedByReviewers: 0,
        securityIssuesCaught: 0,
        codeQualityIssuesCaught: 0
      },
      reviewAssessment: 'REVIEW REQUIRED',
      detailedFindings: [{
        file: 'AI_ANALYSIS_ERROR',
        line: 1,
        issue: `AI analysis failed: ${errorMessage}. This could be due to API limits, service unavailability, or response format issues.`,
        severity: 'MAJOR',
        category: 'CODE_SMELL',
        suggestion: 'Please try running the analysis again. If the error persists, check AI service configuration or contact administrator.'
      }],
      recommendation: `AI analysis could not be completed due to: ${errorMessage}. Manual code review is recommended. Please try again or contact support.`
    };
  }

  // Validate analysis structure
  validateAnalysisStructure(analysis) {
    const requiredFields = ['prInfo', 'automatedAnalysis', 'humanReviewAnalysis', 'reviewAssessment', 'recommendation'];
    
    for (const field of requiredFields) {
      if (!analysis[field]) {
        throw new Error(`Missing required field: ${field}`);
      }
    }
    
    // Validate nested structures with defaults
    if (!analysis.automatedAnalysis.severityBreakdown) {
      analysis.automatedAnalysis.severityBreakdown = { blocker: 0, critical: 0, major: 0, minor: 0, info: 0 };
    }
    
    if (!analysis.automatedAnalysis.categories) {
      analysis.automatedAnalysis.categories = { bugs: 0, vulnerabilities: 0, securityHotspots: 0, codeSmells: 0 };
    }

    if (!Array.isArray(analysis.detailedFindings)) {
      analysis.detailedFindings = [];
    }

    // Ensure all required automatedAnalysis fields exist
    if (typeof analysis.automatedAnalysis.totalIssues !== 'number') {
      analysis.automatedAnalysis.totalIssues = analysis.detailedFindings.length;
    }

    if (typeof analysis.automatedAnalysis.technicalDebtMinutes !== 'number') {
      analysis.automatedAnalysis.technicalDebtMinutes = analysis.automatedAnalysis.totalIssues * 15; // Estimate
    }
  }

  // Enhance analysis with actual PR context
  enhanceAnalysisWithContext(analysis, prData, existingComments) {
    // Ensure prInfo has actual data
    analysis.prInfo = {
      prId: prData.pr.number,
      title: prData.pr.title,
      repository: prData.pr.repository,
      author: prData.pr.author,
      reviewers: prData.reviewers || [],
      url: prData.pr.url,
    };

    // Calculate actual human review metrics
    const comments = existingComments || [];
    analysis.humanReviewAnalysis = {
      reviewComments: comments.length,
      issuesAddressedByReviewers: this.countIssuesInComments(comments),
      securityIssuesCaught: this.countSecurityIssuesInComments(comments),
      codeQualityIssuesCaught: this.countCodeQualityIssuesInComments(comments),
    };

    // Set proper review assessment
    if (comments.length === 0) {
      analysis.reviewAssessment = 'REVIEW REQUIRED';
    } else {
      const criticalIssues = analysis.automatedAnalysis.severityBreakdown.critical + analysis.automatedAnalysis.severityBreakdown.blocker;
      const issuesCaught = analysis.humanReviewAnalysis.issuesAddressedByReviewers;
      
      if (criticalIssues > issuesCaught) {
        analysis.reviewAssessment = 'NOT PROPERLY REVIEWED';
      } else if (issuesCaught >= Math.ceil(analysis.automatedAnalysis.totalIssues * 0.7)) {
        analysis.reviewAssessment = 'PROPERLY REVIEWED';
      } else {
        analysis.reviewAssessment = 'NOT PROPERLY REVIEWED';
      }
    }

    return analysis;
  }

  // Count issues mentioned in comments
  countIssuesInComments(comments) {
    const issueKeywords = ['bug', 'issue', 'problem', 'error', 'fix', 'wrong', 'incorrect'];
    let count = 0;
    
    comments.forEach(comment => {
      const body = (comment.body || '').toLowerCase();
      if (issueKeywords.some(keyword => body.includes(keyword))) {
        count++;
      }
    });
    
    return Math.min(count, comments.length);
  }

  // Count security issues in comments
  countSecurityIssuesInComments(comments) {
    const securityKeywords = ['security', 'vulnerability', 'exploit', 'injection', 'xss', 'csrf', 'auth'];
    let count = 0;
    
    comments.forEach(comment => {
      const body = (comment.body || '').toLowerCase();
      if (securityKeywords.some(keyword => body.includes(keyword))) {
        count++;
      }
    });
    
    return count;
  }

  // Count code quality issues in comments
  countCodeQualityIssuesInComments(comments) {
    const qualityKeywords = ['refactor', 'clean', 'readable', 'complex', 'duplicate', 'naming', 'structure'];
    let count = 0;
    
    comments.forEach(comment => {
      const body = (comment.body || '').toLowerCase();
      if (qualityKeywords.some(keyword => body.includes(keyword))) {
        count++;
      }
    });
    
    return count;
  }

  // Check AI service health
  async checkHealth() {
    try {
      const testPrompt = 'Respond with "OK" if you can process this message.';
      
      if (this.provider === 'openai') {
        const response = await this.openai.chat.completions.create({
          model: config.ai.openai.model,
          messages: [{ role: 'user', content: testPrompt }],
          max_tokens: 10,
        });
        return response.choices[0].message.content.includes('OK');
      } else if (this.provider === 'gemini') {
        const result = await this.geminiModel.generateContent(testPrompt);
        const response = await result.response;
        return response.text().includes('OK');
      }
      
      return false;
    } catch (error) {
      logger.error('AI health check failed:', error);
      return false;
    }
  }
}

module.exports = new AIService();