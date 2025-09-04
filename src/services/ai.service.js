// src/services/ai.service.js - Completely Fixed JSON Parsing with Proper Variable Scoping

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

  // Analyze code and provide review comments
  async analyzeCode(pullRequestData) {
    const prompt = getCodeReviewPrompt(pullRequestData);
    logger.debug('Generated AI prompt:', { prompt });

    let response;
    if (this.provider === 'gemini') {
      response = await this.callGemini(prompt);
    } else if (this.provider === 'openai') {
      response = await this.callOpenAI(prompt);
    } else {
      throw new Error(`Invalid AI provider: ${this.provider}`);
    }

    if (!response || !isValidJSON(response)) {
      logger.error('Invalid or empty AI response, retrying...');
      const retries = 3;
      for (let i = 0; i < retries; i++) {
        logger.info(`Retrying AI call... (${i + 1}/${retries})`);
        response = this.provider === 'gemini' ? await this.callGemini(prompt) : await this.callOpenAI(prompt);
        if (response && isValidJSON(response)) {
          break;
        }
      }
      if (!response || !isValidJSON(response)) {
        logger.error('Failed to get a valid JSON response from AI after multiple retries.');
        throw new Error('Failed to get a valid JSON response from AI.');
      }
    }

    const analysis = JSON.parse(response);
    analysis.timestamp = new Date().toISOString();
    return analysis;
  }

  // Call Gemini API
  async callGemini(prompt) {
    return await retryWithBackoff(async () => {
      const result = await this.geminiModel.generateContent({
        contents: [{ role: "user", parts: [{ text: prompt }] }],
      });
      return result.response.text();
    });
  }

  // Call OpenAI API
  async callOpenAI(prompt) {
    return await retryWithBackoff(async () => {
      const completion = await this.openai.chat.completions.create({
        model: config.ai.openai.model,
        messages: [{ role: 'user', content: prompt }],
      });
      return completion.choices[0].message.content;
    });
  }
  
  // NOTE: The AI service should be prompted to return a JSON object with a structure like this:
  // {
  //   "reviewSummary": "A concise summary of the overall review.",
  //   "detailedFindings": [
  //     {
  //       "file": "src/utils/logger.js",
  //       "line": 15,
  //       "issue": "The logger configuration is verbose and might impact performance in production.",
  //       "severity": "MINOR",
  //       "category": "CODE_SMELL",
  //       "suggestion": "Remove the `prettyPrint()` format in production mode to reduce log size and processing overhead."
  //     }
  //   ]
  // }
  // The 'suggestion' field is what will be used to create the threaded code suggestion.

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

  // Helper method to check AI service health
  async checkHealth() {
    try {
      logger.info('Checking AI service health...');
      const response = await this.analyzeCode({
        diff: 'function test() { const a = 1; }',
        title: 'Health Check',
        files: [{ filename: 'test.js', patch: '@@ -1,1 +1,1 @@\n-function test() { const a = 1; }\n+function test() { const a = 2; }' }],
        pullRequestInfo: { title: 'Health Check', body: 'Test PR' }
      });
      logger.info('AI service health check successful.');
      return true;
    } catch (error) {
      logger.error('AI service health check failed:', error);
      return false;
    }
  }

}

module.exports = new AIService();
