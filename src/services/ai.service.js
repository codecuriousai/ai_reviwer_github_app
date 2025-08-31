// src/services/ai.service.js - Updated for Single Comment Format

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
      
      // Enhance analysis with PR context
      const enhancedAnalysis = this.enhanceAnalysisWithContext(parsedAnalysis, prData, existingComments);
      
      logger.info(`AI analysis completed. Found ${enhancedAnalysis.automatedAnalysis.totalIssues} issues`);
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
      ? sanitizedDiff.substring(0, 8000) + '\n... [truncated for analysis]' 
      : sanitizedDiff;

    return {
      pr: {
        ...pr,
        diff: truncatedDiff,
        files: files.map(file => ({
          filename: file.filename,
          status: file.status,
          additions: file.additions,
          deletions: file.deletions,
          changes: file.changes,
        })),
      },
      comments: existingComments,
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
            content: 'You are an expert code reviewer specializing in SonarQube standards. Always respond with valid JSON in the exact format specified. Focus on providing a comprehensive analysis in a single structured response.',
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
      // Clean response text
      let cleanedResponse = responseText.trim();
      
      // Remove markdown code blocks if present
      cleanedResponse = cleanedResponse.replace(/```json\n?/g, '').replace(/```\n?/g, '');
      
      // Try to find JSON in the response
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
      logger.error('Raw response preview:', responseText.substring(0, 500));
      
      // Return fallback structure
      return this.getFallbackAnalysis(error.message);
    }
  }

  // Validate analysis structure for new format
  validateAnalysisStructure(analysis) {
    const requiredFields = ['prInfo', 'automatedAnalysis', 'humanReviewAnalysis', 'reviewAssessment', 'recommendation'];
    
    for (const field of requiredFields) {
      if (!analysis[field]) {
        throw new Error(`Missing required field: ${field}`);
      }
    }
    
    // Validate nested structures
    if (!analysis.automatedAnalysis.severityBreakdown) {
      throw new Error('Missing severityBreakdown in automatedAnalysis');
    }
    
    if (!analysis.automatedAnalysis.categories) {
      throw new Error('Missing categories in automatedAnalysis');
    }

    if (!Array.isArray(analysis.detailedFindings)) {
      analysis.detailedFindings = [];
    }
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

  // Get fallback analysis for new format
  getFallbackAnalysis(errorMessage) {
    return {
      prInfo: {
        prId: 'unknown',
        title: 'Error in analysis',
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
        issue: `AI analysis failed: ${errorMessage}`,
        severity: 'MAJOR',
        category: 'CODE_SMELL',
        suggestion: 'Please check AI service configuration and try again'
      }],
      recommendation: 'Fix AI analysis configuration to get proper code review feedback. Check API keys, network connectivity, and service availability.'
    };
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

  // Convert legacy analysis format to new format (if needed)
  convertLegacyAnalysis(legacyAnalysis, prData, existingComments) {
    // If analysis is already in new format, return as-is
    if (legacyAnalysis.prInfo && legacyAnalysis.automatedAnalysis) {
      return legacyAnalysis;
    }

    // Convert old format to new format
    const issues = legacyAnalysis.issues || [];
    
    // Map severity levels
    const severityMap = {
      'CRITICAL': 'critical',
      'HIGH': 'major', 
      'MEDIUM': 'minor',
      'LOW': 'info',
      'INFO': 'info'
    };

    // Count severity levels
    const severityBreakdown = {
      blocker: issues.filter(i => i.severity === 'BLOCKER').length,
      critical: issues.filter(i => i.severity === 'CRITICAL').length,
      major: issues.filter(i => i.severity === 'HIGH').length,
      minor: issues.filter(i => i.severity === 'MEDIUM' || i.severity === 'LOW').length,
      info: issues.filter(i => i.severity === 'INFO').length,
    };

    // Count categories
    const categories = {
      bugs: issues.filter(i => i.type === 'BUG').length,
      vulnerabilities: issues.filter(i => i.type === 'VULNERABILITY').length,
      securityHotspots: issues.filter(i => i.type === 'SECURITY_HOTSPOT').length,
      codeSmells: issues.filter(i => i.type === 'CODE_SMELL').length,
    };

    // Calculate technical debt
    const technicalDebtMinutes = issues.reduce((total, issue) => {
      const effortMap = { 'TRIVIAL': 5, 'EASY': 15, 'MEDIUM': 60, 'HARD': 240 };
      return total + (effortMap[issue.effort] || 30);
    }, 0);

    return {
      prInfo: {
        prId: prData.pr.number,
        title: prData.pr.title,
        repository: prData.pr.repository,
        author: prData.pr.author,
        reviewers: prData.reviewers || [],
        url: prData.pr.url,
      },
      automatedAnalysis: {
        totalIssues: issues.length,
        severityBreakdown,
        categories,
        technicalDebtMinutes,
      },
      humanReviewAnalysis: {
        reviewComments: existingComments.length,
        issuesAddressedByReviewers: this.countIssuesInComments(existingComments),
        securityIssuesCaught: this.countSecurityIssuesInComments(existingComments),
        codeQualityIssuesCaught: this.countCodeQualityIssuesInComments(existingComments),
      },
      reviewAssessment: this.assessReviewQuality(issues, existingComments),
      detailedFindings: issues.map(issue => ({
        file: issue.file || 'unknown',
        line: issue.line || 1,
        issue: issue.description || issue.title,
        severity: issue.severity,
        category: issue.type,
        suggestion: issue.suggestion || 'No suggestion provided'
      })),
      recommendation: this.generateRecommendation(issues, existingComments)
    };
  }

  // Assess review quality
  assessReviewQuality(issues, comments) {
    if (comments.length === 0) {
      return 'REVIEW REQUIRED';
    }
    
    const criticalIssues = issues.filter(i => ['BLOCKER', 'CRITICAL'].includes(i.severity)).length;
    const issuesCaught = this.countIssuesInComments(comments);
    
    if (criticalIssues > issuesCaught) {
      return 'NOT PROPERLY REVIEWED';
    } else if (issuesCaught >= Math.ceil(issues.length * 0.7)) {
      return 'PROPERLY REVIEWED';
    } else {
      return 'NOT PROPERLY REVIEWED';
    }
  }

  // Generate recommendation based on analysis
  generateRecommendation(issues, comments) {
    const criticalIssues = issues.filter(i => ['BLOCKER', 'CRITICAL'].includes(i.severity)).length;
    const securityIssues = issues.filter(i => i.type === 'VULNERABILITY').length;
    
    if (comments.length === 0) {
      return 'This PR requires human review. Please assign reviewers to examine the code changes, especially focusing on security and critical functionality.';
    } else if (criticalIssues > 0) {
      return `Critical issues were found that require immediate attention. Reviewers should focus on ${criticalIssues} critical issue(s) before approval.`;
    } else if (securityIssues > 0) {
      return `Security vulnerabilities detected. Please have a security-focused review before merging.`;
    } else if (issues.length > comments.length) {
      return 'Additional code quality issues were found. Consider a more thorough review focusing on maintainability and best practices.';
    } else {
      return 'The review appears comprehensive. Good job on thorough code examination.';
    }
  }

  // Helper methods from previous implementation
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
    
    return Math.min(issueCount, comments.length);
  }

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