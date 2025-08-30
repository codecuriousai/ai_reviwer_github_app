// src/services/ai.service.js - Complete Implementation

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
      const analysis = await retryWithBackoff(async () => {
        if (this.provider === 'openai') {
          return await this.analyzeWithOpenAI(prompt);
        } else if (this.provider === 'gemini') {
          return await this.analyzeWithGemini(prompt);
        } else {
          throw new Error(`Unsupported AI provider: ${this.provider}`);
        }
      });

      // Validate and parse response
      const parsedAnalysis = this.parseAnalysisResponse(analysis);
      
      // Enhance analysis with additional context
      const enhancedAnalysis = this.enhanceAnalysis(parsedAnalysis, prData);
      
      logger.info(`AI analysis completed. Found ${enhancedAnalysis.summary.totalIssues} issues`);
      return enhancedAnalysis;
    } catch (error) {
      logger.error('Error in AI analysis:', error);
      throw new Error(`AI analysis failed: ${error.message}`);
    }
  }

  // Prepare data for AI analysis
  prepareAnalysisData(prData, existingComments) {
    const { pr, files, diff } = prData;
    
    // Sanitize and truncate data for AI processing
    const sanitizedDiff = sanitizeForAI(diff);
    const truncatedDiff = sanitizedDiff.length > 8000 
      ? sanitizedDiff.substring(0, 8000) + '\n... [truncated]' 
      : sanitizedDiff;

    return {
      title: sanitizeForAI(pr.title),
      description: sanitizeForAI(pr.description).substring(0, 500),
      author: pr.author,
      targetBranch: pr.targetBranch,
      sourceBranch: pr.sourceBranch,
      filesChanged: files.length,
      diff: truncatedDiff,
      files: files.map(file => ({
        filename: file.filename,
        status: file.status,
        additions: file.additions,
        deletions: file.deletions,
        changes: file.changes,
      })),
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
            content: 'You are an expert code reviewer specializing in SonarQube standards. Always respond with valid JSON in the exact format specified.',
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

  // Gemini analysis
  async analyzeWithGemini(prompt) {
    try {
      logger.info('Sending request to Gemini');
      
      const enhancedPrompt = prompt + '\n\nIMPORTANT: Respond ONLY with valid JSON. Do not include any markdown formatting or additional text.';
      
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

  // Parse and validate AI response
  parseAnalysisResponse(responseText) {
    try {
      // Clean response text (remove markdown formatting if present)
      let cleanedResponse = responseText.trim();
      
      // Remove markdown code blocks if present
      cleanedResponse = cleanedResponse.replace(/```json\n?/g, '').replace(/```\n?/g, '');
      
      // Try to find JSON in the response if it contains other text
      const jsonMatch = cleanedResponse.match(/\{[\s\S]*\}/);
      if (jsonMatch) {
        cleanedResponse = jsonMatch[0];
      }
      
      if (!isValidJSON(cleanedResponse)) {
        throw new Error('Response is not valid JSON');
      }
      
      const analysis = JSON.parse(cleanedResponse);
      
      // Validate required fields
      this.validateAnalysisStructure(analysis);
      
      return analysis;
    } catch (error) {
      logger.error('Error parsing AI response:', error);
      logger.error('Raw response:', responseText.substring(0, 500));
      
      // Return fallback structure
      return this.getFallbackAnalysis(error.message);
    }
  }

  // Validate analysis structure
  validateAnalysisStructure(analysis) {
    const requiredFields = ['summary', 'issues'];
    const requiredSummaryFields = ['totalIssues', 'overallRating', 'recommendApproval'];
    
    for (const field of requiredFields) {
      if (!analysis[field]) {
        throw new Error(`Missing required field: ${field}`);
      }
    }
    
    for (const field of requiredSummaryFields) {
      if (analysis.summary[field] === undefined) {
        throw new Error(`Missing required summary field: ${field}`);
      }
    }
    
    if (!Array.isArray(analysis.issues)) {
      throw new Error('Issues must be an array');
    }

    // Validate issue structure
    analysis.issues.forEach((issue, index) => {
      const requiredIssueFields = ['type', 'severity', 'title', 'description'];
      for (const field of requiredIssueFields) {
        if (!issue[field]) {
          logger.warn(`Issue ${index} missing field: ${field}`);
        }
      }
    });
  }

  // Enhance analysis with additional context
  enhanceAnalysis(analysis, prData) {
    // Add file-specific context
    analysis.issues = analysis.issues.map(issue => {
      if (issue.file) {
        const fileData = prData.files.find(f => f.filename === issue.file);
        if (fileData) {
          issue.fileContext = {
            additions: fileData.additions,
            deletions: fileData.deletions,
            status: fileData.status,
          };
        }
      }
      return issue;
    });

    // Add complexity assessment
    analysis.complexity = {
      filesChanged: prData.files.length,
      totalChanges: prData.pr.additions + prData.pr.deletions,
      riskLevel: this.calculateRiskLevel(prData),
    };

    // Enhance reviewer coverage if not present
    if (!analysis.reviewerCoverage) {
      analysis.reviewerCoverage = {
        issuesFoundByReviewer: prData.comments.length,
        issuesMissedByReviewer: analysis.summary.totalIssues,
        additionalIssuesFound: analysis.summary.totalIssues,
        reviewQuality: prData.comments.length > 0 ? 'ADEQUATE' : 'INSUFFICIENT',
      };
    }

    return analysis;
  }

  // Calculate risk level based on PR data
  calculateRiskLevel(prData) {
    const { pr, files } = prData;
    const totalChanges = pr.additions + pr.deletions;
    const filesChanged = files.length;
    
    if (totalChanges > 500 || filesChanged > 10) {
      return 'HIGH';
    } else if (totalChanges > 100 || filesChanged > 5) {
      return 'MEDIUM';
    }
    return 'LOW';
  }

  // Get fallback analysis when parsing fails
  getFallbackAnalysis(errorMessage) {
    return {
      summary: {
        totalIssues: 1,
        criticalIssues: 0,
        highIssues: 1,
        mediumIssues: 0,
        lowIssues: 0,
        overallRating: 'NEEDS_IMPROVEMENT',
        recommendApproval: false,
      },
      issues: [{
        file: 'AI_ANALYSIS_ERROR',
        line: 1,
        type: 'CODE_SMELL',
        severity: 'HIGH',
        title: 'AI Analysis Error',
        description: `Failed to parse AI response: ${errorMessage}. This might be due to API limits, invalid response format, or service unavailability.`,
        suggestion: 'Please check the AI service configuration, API keys, and quotas. Try again in a few minutes.',
        sonarRule: 'N/A',
      }],
      reviewerCoverage: {
        issuesFoundByReviewer: 0,
        issuesMissedByReviewer: 0,
        additionalIssuesFound: 1,
        reviewQuality: 'INSUFFICIENT',
      },
      recommendations: [
        'Fix AI analysis configuration to get proper code review.',
        'Verify API keys and service availability.',
        'Check network connectivity and API quotas.',
      ],
    };
  }

  // Analyze specific code patterns
  async analyzeCodePatterns(code, analysisType = 'security') {
    try {
      const prompts = require('../prompts/prompts');
      let prompt;
      
      switch (analysisType) {
        case 'security':
          prompt = prompts.securityAnalysisPrompt;
          break;
        case 'performance':
          prompt = prompts.performanceAnalysisPrompt;
          break;
        case 'maintainability':
          prompt = prompts.maintainabilityPrompt;
          break;
        default:
          prompt = prompts.codeReviewPrompt;
      }

      const sanitizedCode = sanitizeForAI(code);
      prompt += `\n\nCODE TO ANALYZE:\n${sanitizedCode}`;

      if (this.provider === 'openai') {
        return await this.analyzeWithOpenAI(prompt);
      } else {
        return await this.analyzeWithGemini(prompt);
      }
    } catch (error) {
      logger.error(`Error in ${analysisType} analysis:`, error);
      throw error;
    }
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

  // Get token usage statistics
  getUsageStats() {
    return {
      provider: this.provider,
      requestsToday: 0, // Implement actual tracking
      tokensUsed: 0,    // Implement actual tracking
    };
  }

  // Batch analyze multiple files
  async batchAnalyzeFiles(files, prContext) {
    const results = [];
    
    // Process files in chunks to avoid API limits
    const chunkSize = 3;
    for (let i = 0; i < files.length; i += chunkSize) {
      const chunk = files.slice(i, i + chunkSize);
      
      const chunkPromises = chunk.map(async (file) => {
        try {
          return await this.analyzeCodePatterns(file.patch, 'comprehensive');
        } catch (error) {
          logger.error(`Error analyzing file ${file.filename}:`, error);
          return this.getFallbackAnalysis(`Failed to analyze ${file.filename}`);
        }
      });
      
      const chunkResults = await Promise.all(chunkPromises);
      results.push(...chunkResults);
      
      // Small delay between chunks to respect rate limits
      if (i + chunkSize < files.length) {
        await new Promise(resolve => setTimeout(resolve, 1000));
      }
    }
    
    return results;
  }
}

module.exports = new AIService();