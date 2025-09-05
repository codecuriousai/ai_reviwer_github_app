// src/services/ai.service.js - Completely Fixed JSON Parsing with Proper Variable Scoping

const OpenAI = require('openai');
const { GoogleGenerativeAI } = require('@google/generative-ai');
const config = require('../config/config');
const logger = require('../utils/logger');
const { getCodeReviewPrompt } = require('../prompts/prompts');
const { buildFixSuggestionPrompt, buildMergeReadinessPrompt } = require('../prompts/enhanced-prompts');
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

      logger.info(`AI analysis completed. Found ${enhancedAnalysis.automatedAnalysis.totalIssues} issues`);
      return enhancedAnalysis;

    } catch (error) {
      logger.error('Critical error in AI analysis:', error);
      return this.createErrorFallbackAnalysis(`Critical Error: ${error.message}`);
    }
  }

  // NEW: Generate specific code fix suggestions for a finding
  async generateCodeFixSuggestion(finding, fileContent, prData) {
    try {
      logger.info(`Generating code fix suggestion for ${finding.file}:${finding.line}`, {
        issue: finding.issue,
        severity: finding.severity
      });

      const prompt = buildFixSuggestionPrompt(finding, fileContent);

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
        logger.error('AI provider error for fix suggestion:', aiError);
        return this.createErrorFixSuggestion(finding, `AI Provider Error: ${aiError.message}`);
      }

      // Parse the fix suggestion response
      let fixSuggestion;
      try {
        fixSuggestion = this.parseFixSuggestionResponse(rawResponse);
      } catch (parseError) {
        logger.error('Fix suggestion parsing error:', parseError);
        return this.createErrorFixSuggestion(finding, `Parsing Error: ${parseError.message}`);
      }

      logger.info(`Code fix suggestion generated successfully for ${finding.file}:${finding.line}`);
      return fixSuggestion;

    } catch (error) {
      logger.error('Critical error generating fix suggestion:', error);
      return this.createErrorFixSuggestion(finding, `Critical Error: ${error.message}`);
    }
  }

  // NEW: Assess merge readiness based on all available data
  async assessMergeReadiness(prData, aiFindings, reviewComments, currentStatus) {
    try {
      logger.info(`Assessing merge readiness for PR #${prData.pr?.number}`, {
        aiFindings: aiFindings?.length || 0,
        reviewComments: reviewComments?.length || 0
      });

      const prompt = buildMergeReadinessPrompt(prData, aiFindings, reviewComments, currentStatus);

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
        logger.error('AI provider error for merge readiness:', aiError);
        return this.createErrorMergeAssessment(`AI Provider Error: ${aiError.message}`);
      }

      // Parse the merge readiness response
      let mergeAssessment;
      try {
        mergeAssessment = this.parseMergeReadinessResponse(rawResponse);
      } catch (parseError) {
        logger.error('Merge readiness parsing error:', parseError);
        return this.createErrorMergeAssessment(`Parsing Error: ${parseError.message}`);
      }

      logger.info(`Merge readiness assessment completed: ${mergeAssessment.status}`);
      return mergeAssessment;

    } catch (error) {
      logger.error('Critical error assessing merge readiness:', error);
      return this.createErrorMergeAssessment(`Critical Error: ${error.message}`);
    }
  }

  // NEW: Parse fix suggestion response
  parseFixSuggestionResponse(responseText) {
    let originalResponse = '';
    let cleanedResponse = '';

    try {
      if (!responseText || typeof responseText !== 'string') {
        throw new Error('Invalid response: empty or non-string response received from AI');
      }

      originalResponse = responseText;
      cleanedResponse = responseText.trim();

      // Step 1: Remove markdown formatting
      cleanedResponse = cleanedResponse.replace(/```json\s*/g, '');
      cleanedResponse = cleanedResponse.replace(/```\s*/g, '');

      // Step 2: Find JSON boundaries
      const firstBraceIndex = cleanedResponse.indexOf('{');
      const lastBraceIndex = cleanedResponse.lastIndexOf('}');

      if (firstBraceIndex === -1 || lastBraceIndex === -1) {
        throw new Error('No valid JSON object found in fix suggestion response');
      }

      cleanedResponse = cleanedResponse.substring(firstBraceIndex, lastBraceIndex + 1);

      // Step 3: Parse JSON
      const fixSuggestion = JSON.parse(cleanedResponse);

      // Validate required fields
      this.validateFixSuggestion(fixSuggestion);

      logger.info('Successfully parsed fix suggestion response');
      return fixSuggestion;

    } catch (error) {
      logger.error('Failed to parse fix suggestion response', {
        error: error.message,
        originalResponseLength: originalResponse.length,
        cleanedResponseLength: cleanedResponse.length
      });
      throw error;
    }
  }

  // NEW: Parse merge readiness response
  parseMergeReadinessResponse(responseText) {
    let originalResponse = '';
    let cleanedResponse = '';

    try {
      if (!responseText || typeof responseText !== 'string') {
        throw new Error('Invalid response: empty or non-string response received from AI');
      }

      originalResponse = responseText;
      cleanedResponse = responseText.trim();

      // Step 1: Remove markdown formatting
      cleanedResponse = cleanedResponse.replace(/```json\s*/g, '');
      cleanedResponse = cleanedResponse.replace(/```\s*/g, '');

      // Step 2: Find JSON boundaries
      const firstBraceIndex = cleanedResponse.indexOf('{');
      const lastBraceIndex = cleanedResponse.lastIndexOf('}');

      if (firstBraceIndex === -1 || lastBraceIndex === -1) {
        throw new Error('No valid JSON object found in merge readiness response');
      }

      cleanedResponse = cleanedResponse.substring(firstBraceIndex, lastBraceIndex + 1);

      // Step 3: Parse JSON
      const mergeAssessment = JSON.parse(cleanedResponse);

      // Validate required fields
      this.validateMergeAssessment(mergeAssessment);

      logger.info('Successfully parsed merge readiness response');
      return mergeAssessment;

    } catch (error) {
      logger.error('Failed to parse merge readiness response', {
        error: error.message,
        originalResponseLength: originalResponse.length,
        cleanedResponseLength: cleanedResponse.length
      });
      throw error;
    }
  }

  // NEW: Validate fix suggestion structure
  validateFixSuggestion(fixSuggestion) {
    const requiredFields = ['file', 'line', 'issue', 'severity', 'category', 'suggested_fix', 'explanation'];
    
    for (const field of requiredFields) {
      if (!fixSuggestion[field]) {
        throw new Error(`Missing required field '${field}' in fix suggestion`);
      }
    }

    // Normalize fields
    fixSuggestion.line = Number(fixSuggestion.line) || 1;
    fixSuggestion.current_code = String(fixSuggestion.current_code || '');
    fixSuggestion.suggested_fix = String(fixSuggestion.suggested_fix || '');
    fixSuggestion.explanation = String(fixSuggestion.explanation || '');
    fixSuggestion.additional_considerations = String(fixSuggestion.additional_considerations || '');
    fixSuggestion.estimated_effort = String(fixSuggestion.estimated_effort || '15 minutes');
    fixSuggestion.confidence = String(fixSuggestion.confidence || 'medium');
  }

  // NEW: Validate merge assessment structure
  validateMergeAssessment(mergeAssessment) {
    const requiredFields = ['status', 'reason', 'recommendation'];
    
    for (const field of requiredFields) {
      if (!mergeAssessment[field]) {
        throw new Error(`Missing required field '${field}' in merge assessment`);
      }
    }

    // Validate status
    const validStatuses = ['READY_FOR_MERGE', 'NOT_READY_FOR_MERGE', 'REVIEW_REQUIRED'];
    if (!validStatuses.includes(mergeAssessment.status)) {
      mergeAssessment.status = 'REVIEW_REQUIRED';
    }

    // Normalize fields
    mergeAssessment.outstanding_issues = mergeAssessment.outstanding_issues || [];
    mergeAssessment.review_quality_assessment = mergeAssessment.review_quality_assessment || {};
    mergeAssessment.merge_readiness_score = Number(mergeAssessment.merge_readiness_score) || 50;
    mergeAssessment.confidence = String(mergeAssessment.confidence || 'medium');
  }

  // NEW: Create error fix suggestion fallback
  createErrorFixSuggestion(originalFinding, errorMessage) {
    return {
      file: originalFinding.file,
      line: originalFinding.line,
      issue: originalFinding.issue,
      severity: originalFinding.severity,
      category: originalFinding.category,
      current_code: '// Unable to retrieve current code',
      suggested_fix: '// Unable to generate fix suggestion due to AI error',
      explanation: `Error generating fix suggestion: ${errorMessage}`,
      additional_considerations: 'Manual review required due to AI service error. Check logs for details.',
      estimated_effort: 'Unknown',
      confidence: 'low',
      error: true,
      error_message: errorMessage
    };
  }

  // NEW: Create error merge assessment fallback
  createErrorMergeAssessment(errorMessage) {
    return {
      status: 'REVIEW_REQUIRED',
      reason: `Unable to assess merge readiness due to AI service error: ${errorMessage}`,
      recommendation: 'Manual review required. Check AI service logs and configuration.',
      outstanding_issues: [{
        type: 'SYSTEM',
        severity: 'MAJOR',
        description: `AI merge assessment failed: ${errorMessage}`,
        file: 'system',
        line: 0,
        addressed: false
      }],
      review_quality_assessment: {
        human_review_coverage: 'UNKNOWN',
        ai_analysis_coverage: 'FAILED',
        critical_issues_addressed: false,
        security_issues_addressed: false,
        total_unresolved_issues: 1
      },
      merge_readiness_score: 0,
      confidence: 'low',
      error: true,
      error_message: errorMessage
    };
  }

  // Prepare data for AI analysis with safe property access
  prepareAnalysisData(prData, existingComments) {
    const pr = prData.pr || prData || {};
    const files = prData.files || [];

    // CRITICAL FIX: Instead of sending raw diff, send structured file data with line mappings
    const structuredFiles = this.createStructuredFileData(files, prData.diff);

    return {
      // Match your Angular app payload structure
      repo_url: `https://github.com/${pr.repository}`,
      branch_name: pr.sourceBranch || 'unknown',
      pr_number: pr.number,
      pr_id: pr.number,
      repository: pr.repository,
      target_branch: pr.targetBranch || 'main',
      source_branch: pr.sourceBranch || 'unknown',

      // Enhanced PR info matching your Angular structure
      pr_info: {
        id: pr.id,
        number: pr.number,
        title: pr.title || 'No title',
        description: pr.description || 'No description',
        author: pr.author || 'unknown',
        url: pr.url || '#',
        state: pr.state || 'open',
        created_at: pr.created_at || new Date().toISOString(),
        updated_at: pr.updated_at || new Date().toISOString(),
        additions: pr.additions || 0,
        deletions: pr.deletions || 0,
        changed_files: files.length
      },

      // CRITICAL: Structured file changes with proper line mapping
      file_changes: structuredFiles,

      // Include existing comments for context
      existing_comments: this.formatExistingComments(existingComments),

      // Include reviewer info
      reviewers: prData.reviewers || [],

      // Analysis parameters
      analysis_params: {
        include_security_analysis: true,
        include_code_quality: true,
        include_performance_analysis: true,
        max_issues_per_file: 10,
        severity_threshold: 'MINOR'
      }
    };
  }

  // NEW: Create structured file data with accurate line mappings (like your Angular app expects)
  createStructuredFileData(files, rawDiff) {
    const structuredFiles = [];

    files.forEach(file => {
      if (!file.patch) return; // Skip files without patches

      const fileStructure = {
        filename: file.filename,
        status: file.status, // 'added', 'modified', 'deleted'
        additions: file.additions,
        deletions: file.deletions,
        changes: file.changes,

        // CRITICAL: Parse the patch to create line-by-line structure with proper mapping
        lines: this.parseFileLines(file.patch, file.filename),

        // Include the raw patch for reference but structured
        patch_summary: this.createPatchSummary(file.patch),

        // File metadata
        blob_url: file.blob_url,
        raw_url: file.raw_url,
        sha: file.sha
      };

      structuredFiles.push(fileStructure);
    });

    return structuredFiles;
  }

  // NEW: Parse file patch into structured lines with proper mapping
  parseFileLines(patch, filename) {
    const lines = patch.split('\n');
    const structuredLines = [];
    let oldLineNum = 0;
    let newLineNum = 0;
    let currentHunk = null;

    for (let i = 0; i < lines.length; i++) {
      const line = lines[i];

      // Parse hunk header
      if (line.startsWith('@@')) {
        const hunkMatch = line.match(/@@\s*-(\d+),?\d*\s*\+(\d+),?\d*\s*@@/);
        if (hunkMatch) {
          oldLineNum = parseInt(hunkMatch[1]) - 1;
          newLineNum = parseInt(hunkMatch[2]) - 1;
          currentHunk = {
            oldStart: parseInt(hunkMatch[1]),
            newStart: parseInt(hunkMatch[2]),
            header: line
          };
        }
        continue;
      }

      if (!currentHunk) continue;

      const lineType = line.charAt(0);
      const content = line.slice(1);

      if (lineType === '-') {
        // Deleted line
        oldLineNum++;
        structuredLines.push({
          type: 'deleted',
          oldLineNumber: oldLineNum,
          newLineNumber: null,
          content: content,
          raw: line,
          hunk: currentHunk.oldStart,
          // CRITICAL: This line cannot receive comments
          commentable: false
        });
      }
      else if (lineType === '+') {
        // Added line - THESE ARE THE LINES THAT CAN RECEIVE COMMENTS
        newLineNum++;
        structuredLines.push({
          type: 'added',
          oldLineNumber: null,
          newLineNumber: newLineNum,
          content: content,
          raw: line,
          hunk: currentHunk.newStart,
          // CRITICAL: This is the actual line number for GitHub comments
          commentable: true,
          githubCommentLine: newLineNum  // This is what GitHub API expects
        });
      }
      else if (lineType === ' ') {
        // Context line
        oldLineNum++;
        newLineNum++;
        structuredLines.push({
          type: 'context',
          oldLineNumber: oldLineNum,
          newLineNumber: newLineNum,
          content: content,
          raw: line,
          hunk: currentHunk.newStart,
          // Context lines typically can't receive comments in PR reviews
          commentable: false
        });
      }
    }

    logger.debug(`Parsed ${structuredLines.length} lines for ${filename}`, {
      commentableLines: structuredLines.filter(l => l.commentable).length,
      addedLines: structuredLines.filter(l => l.type === 'added').length
    });

    return structuredLines;
  }

  // NEW: Create patch summary for AI context
  createPatchSummary(patch) {
    const lines = patch.split('\n');
    const hunks = [];
    let currentHunk = null;

    for (const line of lines) {
      if (line.startsWith('@@')) {
        if (currentHunk) hunks.push(currentHunk);
        const hunkMatch = line.match(/@@\s*-(\d+),?(\d*)\s*\+(\d+),?(\d*)\s*@@(.*)?/);
        if (hunkMatch) {
          currentHunk = {
            header: line,
            oldStart: parseInt(hunkMatch[1]),
            oldCount: hunkMatch[2] ? parseInt(hunkMatch[2]) : 1,
            newStart: parseInt(hunkMatch[3]),
            newCount: hunkMatch[4] ? parseInt(hunkMatch[4]) : 1,
            context: hunkMatch[5] ? hunkMatch[5].trim() : '',
            additions: 0,
            deletions: 0
          };
        }
      } else if (currentHunk) {
        if (line.startsWith('+')) currentHunk.additions++;
        if (line.startsWith('-')) currentHunk.deletions++;
      }
    }

    if (currentHunk) hunks.push(currentHunk);

    return {
      totalHunks: hunks.length,
      hunks: hunks,
      totalAdditions: hunks.reduce((sum, h) => sum + h.additions, 0),
      totalDeletions: hunks.reduce((sum, h) => sum + h.deletions, 0)
    };
  }

  // NEW: Format existing comments for AI context
  formatExistingComments(comments) {
    return comments.map(comment => ({
      id: comment.id,
      user: comment.user,
      body: comment.body,
      created_at: comment.createdAt,
      type: comment.type,
      file: comment.path || null,
      line: comment.line || null,
      // Add context about what this comment addresses
      context: this.extractCommentContext(comment.body)
    }));
  }

  // NEW: Extract context from existing comments
  extractCommentContext(body) {
    const context = {
      severity: null,
      category: null,
      isResolved: false
    };

    // Check for severity indicators
    if (/critical|high|urgent/i.test(body)) context.severity = 'HIGH';
    if (/medium|moderate/i.test(body)) context.severity = 'MEDIUM';
    if (/low|minor|nitpick/i.test(body)) context.severity = 'LOW';

    // Check for category
    if (/security|vulnerability|exploit/i.test(body)) context.category = 'SECURITY';
    if (/performance|optimization|slow/i.test(body)) context.category = 'PERFORMANCE';
    if (/bug|error|issue/i.test(body)) context.category = 'BUG';
    if (/style|formatting|lint/i.test(body)) context.category = 'STYLE';

    // Check if resolved
    context.isResolved = /resolved|fixed|addressed|done/i.test(body);

    return context;
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
      cleanedResponse = cleanedResponse.replace(/```