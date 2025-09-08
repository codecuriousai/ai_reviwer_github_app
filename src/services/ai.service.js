// src/services/ai.service.js - Enhanced AI Service with Resolved Conversation-Based Merge Readiness

const OpenAI = require("openai");
const { GoogleGenerativeAI } = require("@google/generative-ai");
const config = require("../config/config");
const logger = require("../utils/logger");
const { getCodeReviewPrompt } = require("../prompts/prompts");
const {
  buildFixSuggestionPrompt,
  buildMergeReadinessPrompt,
} = require("../prompts/enhanced-prompts");
const {
  retryWithBackoff,
  sanitizeForAI,
  isValidJSON,
  delay,
  generateTrackingId,
} = require("../utils/helpers");

class AIService {
  constructor() {
    this.provider = config.ai.provider;
    this.initializeProviders();

    // Comment filtering configuration - easily modifiable
    this.commentFilterConfig = {
      // Comments to include in merge readiness assessment
      include: {
        commentTypes: [
          'REVIEW_COMMENT',        // Line-specific review comments (PRIORITY)
          'PULL_REQUEST_COMMENT',  // General PR comments
          'ISSUE_COMMENT'          // Issue comments (if linked to PR)
        ],
        authorTypes: [
          'HUMAN',                 // Human authors
          'COLLABORATOR',          // Repository collaborators
          'CONTRIBUTOR',           // External contributors
          'OWNER',                 // Repository owners
          'MEMBER'                 // Organization members
        ]
      },

      // Comments to exclude from merge readiness assessment
      exclude: {
        commentTypes: [
          'COMMIT_COMMENT',        // Comments on specific commits
          'DISCUSSION_COMMENT',    // GitHub Discussions comments
          'RELEASE_COMMENT',       // Release comments
          'GIST_COMMENT'          // Gist comments
        ],
        authorTypes: [
          'BOT',                   // All bot accounts
          'GITHUB_ACTIONS',        // GitHub Actions bot
          'DEPENDABOT',            // Dependabot
          'RENOVATE',              // Renovate bot
          'CODECOV',               // Codecov bot
          'SONARCLOUD',            // SonarCloud bot
          'SECURITY_BOT'           // Security bots
        ],
        specificBots: [
          'github-actions[bot]',
          'dependabot[bot]',
          'renovate[bot]',
          'codecov[bot]',
          'sonarcloud[bot]',
          'security-bot[bot]',
          'snyk-bot',
          'greenkeeper[bot]',
          'mergify[bot]'
        ],
        // Bot name patterns to exclude
        botNamePatterns: [
          'bot',
          '[bot]',
          'automation',
          'ci',
          'deploy'
        ]
      }
    };
  }

  // Initialize AI providers
  initializeProviders() {
    try {
      if (this.provider === "openai" || config.ai.openai.apiKey) {
        this.openai = new OpenAI({
          apiKey: config.ai.openai.apiKey,
        });
        logger.info("OpenAI client initialized");
      }

      if (this.provider === "gemini" || config.ai.gemini.apiKey) {
        this.gemini = new GoogleGenerativeAI(config.ai.gemini.apiKey);
        this.geminiModel = this.gemini.getGenerativeModel({
          model: config.ai.gemini.model,
        });
        logger.info("Gemini client initialized");
      }
    } catch (error) {
      logger.error("Error initializing AI providers:", error);
      throw new Error("Failed to initialize AI providers");
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
          if (this.provider === "openai") {
            return await this.analyzeWithOpenAI(prompt);
          } else if (this.provider === "gemini") {
            return await this.analyzeWithGemini(prompt);
          } else {
            throw new Error(`Unsupported AI provider: ${this.provider}`);
          }
        });
      } catch (aiError) {
        logger.error("AI provider error:", aiError);
        return this.createErrorFallbackAnalysis(
          `AI Provider Error: ${aiError.message}`
        );
      }

      // Validate and parse response
      let parsedAnalysis;
      try {
        parsedAnalysis = this.parseAnalysisResponse(rawResponse);
      } catch (parseError) {
        logger.error("Response parsing error:", parseError);
        return this.createErrorFallbackAnalysis(
          `Parsing Error: ${parseError.message}`
        );
      }

      // Enhance analysis with PR context
      const enhancedAnalysis = this.enhanceAnalysisWithContext(
        parsedAnalysis,
        prData,
        existingComments
      );

      logger.info(
        `AI analysis completed. Found ${enhancedAnalysis.automatedAnalysis.totalIssues} issues`
      );
      return enhancedAnalysis;
    } catch (error) {
      logger.error("Critical error in AI analysis:", error);
      return this.createErrorFallbackAnalysis(
        `Critical Error: ${error.message}`
      );
    }
  }

  // UPDATED: Assess merge readiness based purely on resolved conversations - NO AI INTERFERENCE
  async assessMergeReadiness(prData, aiFindings, reviewComments, currentStatus) {
    try {
      logger.info(`Assessing merge readiness for PR #${prData.pr?.number} - NO AI INTERFERENCE`, {
        totalComments: reviewComments?.length || 0,
      });

      // Filter comments based on configuration (only human review comments)
      const filteredComments = this.filterRelevantComments(reviewComments || []);

      logger.info(`Filtered comments for assessment`, {
        originalCount: reviewComments?.length || 0,
        filteredCount: filteredComments.length,
        approach: 'resolved_conversations_only'
      });

      // Check resolved status of filtered comments - THIS IS THE ONLY CRITERIA
      const resolvedStatus = this.checkResolvedConversations(filteredComments);

      logger.info(`Resolved conversation analysis (FINAL DECISION CRITERIA)`, resolvedStatus);

      // Determine merge readiness based ONLY on resolved status
      return this.determineMergeReadinessFromResolved(resolvedStatus, prData);

    } catch (error) {
      logger.error("Critical error assessing merge readiness:", error);
      return this.createErrorMergeAssessment(`Critical Error: ${error.message}`);
    }
  }

  // ENHANCED: Filter comments with stricter bot detection
  filterRelevantComments(comments) {
    return comments.filter(comment => {
      // Step 1: Check if comment type should be included
      const commentType = this.determineCommentType(comment);
      if (!this.commentFilterConfig.include.commentTypes.includes(commentType)) {
        logger.debug(`Excluding comment by type: ${commentType}`, { commentId: comment.id });
        return false;
      }

      // Step 2: Check if comment type should be excluded
      if (this.commentFilterConfig.exclude.commentTypes.includes(commentType)) {
        logger.debug(`Excluding comment by excluded type: ${commentType}`, { commentId: comment.id });
        return false;
      }

      // Step 3: Enhanced bot detection
      const authorLogin = comment.user?.login?.toLowerCase() || '';
      
      // Check specific bots
      if (this.commentFilterConfig.exclude.specificBots.some(bot => 
        authorLogin.includes(bot.toLowerCase().replace('[bot]', '')))) {
        logger.debug(`Excluding comment from specific bot: ${authorLogin}`, { commentId: comment.id });
        return false;
      }

      // Check bot name patterns
      if (this.commentFilterConfig.exclude.botNamePatterns.some(pattern => 
        authorLogin.includes(pattern.toLowerCase()))) {
        logger.debug(`Excluding comment matching bot pattern: ${authorLogin}`, { commentId: comment.id });
        return false;
      }

      // Step 4: Check author type
      const authorType = this.determineAuthorType(comment);
      
      // Exclude bot author types
      if (this.commentFilterConfig.exclude.authorTypes.includes(authorType)) {
        logger.debug(`Excluding comment from bot author type: ${authorType}`, { 
          commentId: comment.id, 
          author: authorLogin 
        });
        return false;
      }

      // Include only allowed human author types
      if (!this.commentFilterConfig.include.authorTypes.includes(authorType)) {
        logger.debug(`Excluding comment - author type not in include list: ${authorType}`, { 
          commentId: comment.id 
        });
        return false;
      }

      // Step 5: Additional validation for review comments (prioritized)
      if (commentType === 'REVIEW_COMMENT') {
        // Ensure it has file and line information
        if (!comment.path || !comment.line) {
          logger.debug(`Excluding review comment without path/line`, { commentId: comment.id });
          return false;
        }
      }

      logger.debug(`Including comment for merge assessment`, { 
        commentId: comment.id, 
        type: commentType,
        author: authorLogin,
        authorType: authorType
      });

      return true;
    });
  }

  // ENHANCED: Better comment type detection
  determineCommentType(comment) {
    // Priority 1: Review comments (line-specific comments during code reviews)
    if (comment.path && (comment.line || comment.original_line) && 
        (comment.pull_request_review_id || comment.diff_hunk)) {
      return 'REVIEW_COMMENT';
    }
    
    // Priority 2: Pull request comments
    if (comment.pull_request_url || 
        comment.issue_url?.includes('/pull/') ||
        comment.html_url?.includes('/pull/')) {
      return 'PULL_REQUEST_COMMENT';
    }
    
    // Check for issue comments
    if (comment.issue_url && !comment.issue_url.includes('/pull/')) {
      return 'ISSUE_COMMENT';
    }
    
    // Check for commit comments
    if (comment.commit_id || comment.url?.includes('/commit/') || 
        comment.html_url?.includes('/commit/')) {
      return 'COMMIT_COMMENT';
    }
    
    // Check for discussion comments
    if (comment.discussion_id || comment.category) {
      return 'DISCUSSION_COMMENT';
    }

    // Default to pull request comment if uncertain
    return 'PULL_REQUEST_COMMENT';
  }

  // ENHANCED: Better author type detection with stricter bot filtering
  determineAuthorType(comment) {
    const user = comment.user || {};
    const userType = user.type?.toUpperCase() || 'USER';
    const login = user.login?.toLowerCase() || '';
    
    // Enhanced bot detection
    if (userType === 'BOT' || 
        login.includes('[bot]') || 
        login.endsWith('bot') ||
        login.includes('automation') ||
        login.includes('ci-') ||
        login.includes('deploy') ||
        user.type === 'Bot') {
      return 'BOT';
    }
    
    // Check for specific known bots and services
    const knownBotPatterns = [
      'github-actions', 'dependabot', 'renovate', 'codecov', 'sonarcloud',
      'snyk', 'security', 'lint', 'format', 'build', 'test', 'deploy'
    ];
    
    if (knownBotPatterns.some(pattern => login.includes(pattern))) {
      return 'BOT';
    }
    
    // Check association level (if available)
    const association = comment.author_association?.toUpperCase() || 'NONE';
    
    switch (association) {
      case 'OWNER':
        return 'OWNER';
      case 'MEMBER':
        return 'MEMBER';
      case 'COLLABORATOR':
        return 'COLLABORATOR';
      case 'CONTRIBUTOR':
        return 'CONTRIBUTOR';
      case 'FIRST_TIME_CONTRIBUTOR':
        return 'CONTRIBUTOR';
      case 'FIRST_TIMER':
        return 'CONTRIBUTOR';
      default:
        return 'HUMAN';
    }
  }

  // CORE LOGIC: Check resolved conversations status - THIS DETERMINES MERGE READINESS
  checkResolvedConversations(filteredComments) {
    if (filteredComments.length === 0) {
      logger.info('No relevant comments found for merge assessment');
      return {
        totalConversations: 0,
        resolvedConversations: 0,
        unresolvedCount: 0,
        pendingCount: 0,
        unresolvedConversations: [],
        pendingConversations: [],
        allResolved: true,
        resolutionPercentage: 100
      };
    }

    const conversationThreads = this.groupCommentsIntoConversations(filteredComments);
    
    let totalConversations = 0;
    let resolvedConversations = 0;
    let unresolvedConversations = [];
    let pendingConversations = [];

    Object.entries(conversationThreads).forEach(([threadId, comments]) => {
      totalConversations++;
      
      const threadStatus = this.analyzeConversationThread(comments);
      
      logger.debug(`Thread ${threadId} analysis:`, {
        threadId,
        commentCount: comments.length,
        isResolved: threadStatus.isResolved,
        isPending: threadStatus.isPending,
        requiresAction: threadStatus.requiresAction,
        hasGitHubResolution: threadStatus.hasGitHubResolution
      });
      
      if (threadStatus.isResolved) {
        resolvedConversations++;
      } else if (threadStatus.isPending) {
        pendingConversations.push({
          threadId,
          comments: comments.length,
          lastComment: comments[comments.length - 1],
          status: 'pending',
          reason: threadStatus.reason || 'Conversation appears to be pending response'
        });
      } else {
        unresolvedConversations.push({
          threadId,
          comments: comments.length,
          lastComment: comments[comments.length - 1],
          status: 'unresolved',
          requiresAction: threadStatus.requiresAction,
          reason: threadStatus.reason || 'Conversation has not been resolved'
        });
      }
    });

    const result = {
      totalConversations,
      resolvedConversations,
      unresolvedCount: unresolvedConversations.length,
      pendingCount: pendingConversations.length,
      unresolvedConversations,
      pendingConversations,
      allResolved: unresolvedConversations.length === 0 && pendingConversations.length === 0,
      resolutionPercentage: totalConversations > 0 ? 
        Math.round((resolvedConversations / totalConversations) * 100) : 100
    };

    logger.info('Conversation resolution summary:', result);
    return result;
  }

  // Group comments into conversation threads
  groupCommentsIntoConversations(comments) {
    const threads = {};
    
    comments.forEach(comment => {
      let threadId;
      
      // For review comments, group by file path and line number
      if (comment.path && (comment.line || comment.original_line)) {
        const line = comment.line || comment.original_line;
        threadId = `${comment.path}:${line}`;
      } 
      // For reply comments, group with parent
      else if (comment.in_reply_to_id) {
        threadId = `reply_to_${comment.in_reply_to_id}`;
      }
      // For general PR/issue comments, each is its own thread unless replying
      else {
        threadId = `standalone_${comment.id}`;
      }
      
      if (!threads[threadId]) {
        threads[threadId] = [];
      }
      
      threads[threadId].push(comment);
    });
    
    // Sort comments in each thread by creation date
    Object.keys(threads).forEach(threadId => {
      threads[threadId].sort((a, b) => 
        new Date(a.created_at) - new Date(b.created_at)
      );
    });
    
    return threads;
  }

  // CRITICAL: Analyze individual conversation thread - MAIN DECISION LOGIC
  analyzeConversationThread(comments) {
    if (comments.length === 0) {
      return { 
        isResolved: true, 
        isPending: false, 
        requiresAction: false, 
        reason: 'Empty thread',
        hasGitHubResolution: false
      };
    }

    // PRIORITY 1: Check GitHub's native resolved conversation status
    const hasGitHubResolution = comments.some(comment => 
      comment.resolved === true || 
      comment.conversation_resolved === true ||
      comment.state === 'resolved'
    );

    if (hasGitHubResolution) {
      return { 
        isResolved: true, 
        isPending: false, 
        requiresAction: false, 
        reason: 'GitHub resolved conversation',
        hasGitHubResolution: true
      };
    }

    // PRIORITY 2: Look for explicit resolution keywords
    const hasResolutionKeywords = comments.some(comment => {
      const body = comment.body?.toLowerCase() || '';
      return (
        body.includes('resolved') ||
        body.includes('fixed') ||
        body.includes('addressed') ||
        body.includes('done') ||
        body.includes('completed') ||
        body.includes('merged') ||
        body.includes('closed') ||
        body.includes('thank you') ||
        body.includes('thanks for fixing') ||
        body.includes('looks good now') ||
        body.includes('perfect')
      );
    });

    // PRIORITY 3: Check for explicit change requests (blocking)
    const hasChangeRequest = comments.some(comment => {
      const body = comment.body?.toLowerCase() || '';
      return (
        body.includes('please fix') ||
        body.includes('needs fix') ||
        body.includes('must fix') ||
        body.includes('must change') ||
        body.includes('required:') ||
        body.includes('blocking') ||
        body.includes('request changes') ||
        comment.state === 'CHANGES_REQUESTED'
      );
    });

    // PRIORITY 4: Check for approvals
    const hasApproval = comments.some(comment => {
      const body = comment.body?.toLowerCase() || '';
      return (
        body.includes('approve') ||
        body.includes('approved') ||
        body.includes('lgtm') ||
        body.includes('looks good to merge') ||
        body.includes('looks good') ||
        body.includes('👍') ||
        body.includes(':+1:') ||
        body.includes('ship it') ||
        comment.state === 'APPROVED'
      );
    });

    // Decision logic
    if (hasResolutionKeywords || hasApproval) {
      return { 
        isResolved: true, 
        isPending: false, 
        requiresAction: false, 
        reason: hasResolutionKeywords ? 'Resolution keywords found' : 'Approval found',
        hasGitHubResolution: false
      };
    }

    if (hasChangeRequest) {
      return { 
        isResolved: false, 
        isPending: false, 
        requiresAction: true, 
        reason: 'Change request found',
        hasGitHubResolution: false
      };
    }

    // Check if it's just a question or suggestion
    const lastComment = comments[comments.length - 1];
    const isQuestion = lastComment.body?.includes('?') || false;
    const isSuggestion = lastComment.body?.toLowerCase().includes('consider') ||
                        lastComment.body?.toLowerCase().includes('suggest') ||
                        lastComment.body?.toLowerCase().includes('might want to') ||
                        lastComment.body?.toLowerCase().includes('optional');
    
    if (isQuestion || isSuggestion) {
      return { 
        isResolved: false, 
        isPending: true, 
        requiresAction: false, 
        reason: isQuestion ? 'Question pending answer' : 'Suggestion pending response',
        hasGitHubResolution: false
      };
    }

    // Default: unresolved if no clear indicators
    return { 
      isResolved: false, 
      isPending: false, 
      requiresAction: true, 
      reason: 'No resolution indicators found',
      hasGitHubResolution: false
    };
  }

  // CORE DECISION: Determine merge readiness based ONLY on resolved status
  determineMergeReadinessFromResolved(resolvedStatus, prData) {
    const { allResolved, unresolvedConversations, pendingConversations, 
            totalConversations, resolutionPercentage } = resolvedStatus;

    // SCENARIO 1: All conversations resolved or no conversations
    if (allResolved) {
      logger.info(`✅ READY FOR MERGE - All conversations resolved`);
      return {
        status: "READY_FOR_MERGE",
        reason: totalConversations === 0 
          ? "No reviewer conversations to resolve."
          : `All ${totalConversations} reviewer conversations have been resolved using GitHub's 'Resolve conversation' feature.`,
        recommendation: totalConversations === 0
          ? "This PR is ready for merge. No review conversations require resolution."
          : "This PR is ready for merge. All reviewer feedback has been addressed and conversations resolved.",
        outstanding_issues: [],
        conversation_analysis: {
          total_conversations: totalConversations,
          resolved_conversations: resolvedStatus.resolvedConversations,
          unresolved_conversations: 0,
          pending_conversations: 0,
          resolution_percentage: resolutionPercentage,
          assessment_method: 'resolved_conversations_only'
        },
        merge_readiness_score: 100,
        confidence: "high",
        error: false,
      };
    }

    // SCENARIO 2: Only pending conversations (questions/suggestions) - Still ready
    if (unresolvedConversations.length === 0 && pendingConversations.length > 0) {
      logger.info(`⚠️ CONDITIONALLY READY - Only pending conversations`);
      return {
        status: "READY_FOR_MERGE",
        reason: `${pendingConversations.length} conversations are pending but don't block merge. These appear to be questions or suggestions rather than required changes.`,
        recommendation: "This PR can be merged. Consider addressing pending questions in follow-up discussions or resolve conversations if they're no longer relevant.",
        outstanding_issues: pendingConversations.map(conv => ({
          type: "PENDING_DISCUSSION",
          severity: "INFO",
          description: `Pending conversation in ${conv.threadId}`,
          last_comment: conv.lastComment.body?.substring(0, 100) + "...",
          requires_action: false,
          reason: conv.reason
        })),
        conversation_analysis: {
          total_conversations: totalConversations,
          resolved_conversations: resolvedStatus.resolvedConversations,
          unresolved_conversations: 0,
          pending_conversations: pendingConversations.length,
          resolution_percentage: resolutionPercentage,
          assessment_method: 'resolved_conversations_only'
        },
        merge_readiness_score: 85,
        confidence: "high",
        error: false,
      };
    }

    // SCENARIO 3: Unresolved conversations that require action - NOT READY
    logger.info(`❌ NOT READY - Unresolved conversations require attention`);
    return {
      status: "NOT_READY_FOR_MERGE",
      reason: `${unresolvedConversations.length} conversations require resolution before merge. Use GitHub's 'Resolve conversation' button after addressing each concern.`,
      recommendation: "Address all unresolved reviewer feedback before proceeding with merge. After fixing issues, use GitHub's 'Resolve conversation' feature to mark each conversation as resolved.",
      outstanding_issues: unresolvedConversations.map(conv => ({
        type: "UNRESOLVED_CONVERSATION",
        severity: conv.requiresAction ? "MAJOR" : "MINOR",
        description: `Unresolved conversation in ${conv.threadId} (${conv.comments} comments)`,
        last_comment: conv.lastComment.body?.substring(0, 100) + "...",
        requires_action: conv.requiresAction,
        reason: conv.reason,
        file: conv.threadId.includes(':') ? conv.threadId.split(':')[0] : null,
        line: conv.threadId.includes(':') ? conv.threadId.split(':')[1] : null,
        author: conv.lastComment.user?.login,
        created_at: conv.lastComment.created_at
      })),
      conversation_analysis: {
        total_conversations: totalConversations,
        resolved_conversations: resolvedStatus.resolvedConversations,
        unresolved_conversations: unresolvedConversations.length,
        pending_conversations: pendingConversations.length,
        resolution_percentage: resolutionPercentage,
        assessment_method: 'resolved_conversations_only'
      },
      merge_readiness_score: Math.max(10, resolutionPercentage - 30),
      confidence: "high",
      error: false,
    };
  }

  // UTILITY: Update comment filter configuration easily
  updateCommentFilterConfig(newConfig) {
    // Deep merge new configuration with existing
    if (newConfig.include) {
      this.commentFilterConfig.include = {
        ...this.commentFilterConfig.include,
        ...newConfig.include
      };
    }
    
    if (newConfig.exclude) {
      this.commentFilterConfig.exclude = {
        ...this.commentFilterConfig.exclude,
        ...newConfig.exclude
      };
      
      // Handle array merging for specific fields
      if (newConfig.exclude.specificBots) {
        this.commentFilterConfig.exclude.specificBots = [
          ...new Set([
            ...this.commentFilterConfig.exclude.specificBots,
            ...newConfig.exclude.specificBots
          ])
        ];
      }
      
      if (newConfig.exclude.botNamePatterns) {
        this.commentFilterConfig.exclude.botNamePatterns = [
          ...new Set([
            ...this.commentFilterConfig.exclude.botNamePatterns,
            ...newConfig.exclude.botNamePatterns
          ])
        ];
      }
    }
    
    logger.info('Comment filter configuration updated', this.commentFilterConfig);
    return this.commentFilterConfig;
  }

  // UTILITY: Get current filter configuration
  getCommentFilterConfig() {
    return JSON.parse(JSON.stringify(this.commentFilterConfig));
  }

  // UTILITY: Add specific bot to exclusion list
  addBotToExclusionList(botIdentifiers) {
    if (typeof botIdentifiers === 'string') {
      botIdentifiers = [botIdentifiers];
    }
    
    botIdentifiers.forEach(bot => {
      if (!this.commentFilterConfig.exclude.specificBots.includes(bot)) {
        this.commentFilterConfig.exclude.specificBots.push(bot);
      }
    });
    
    logger.info(`Added bots to exclusion list: ${botIdentifiers.join(', ')}`);
    return this.commentFilterConfig;
  }

  // UTILITY: Remove bot from exclusion list
  removeBotFromExclusionList(botIdentifiers) {
    if (typeof botIdentifiers === 'string') {
      botIdentifiers = [botIdentifiers];
    }
    
    botIdentifiers.forEach(bot => {
      const index = this.commentFilterConfig.exclude.specificBots.indexOf(bot);
      if (index > -1) {
        this.commentFilterConfig.exclude.specificBots.splice(index, 1);
      }
    });
    
    logger.info(`Removed bots from exclusion list: ${botIdentifiers.join(', ')}`);
    return this.commentFilterConfig;
  }

  // CREATE ERROR MERGE ASSESSMENT
  createErrorMergeAssessment(errorMessage) {
    return {
      status: "REVIEW_REQUIRED",
      reason: `Unable to assess merge readiness due to system error: ${errorMessage}`,
      recommendation: "Manual review required. Check system logs and configuration.",
      outstanding_issues: [
        {
          type: "SYSTEM_ERROR",
          severity: "MAJOR",
          description: `Merge assessment failed: ${errorMessage}`,
          requires_action: true,
        },
      ],
      conversation_analysis: {
        total_conversations: 0,
        resolved_conversations: 0,
        unresolved_conversations: 0,
        pending_conversations: 0,
        resolution_percentage: 0,
        assessment_method: 'error_fallback'
      },
      merge_readiness_score: 0,
      confidence: "low",
      error: true,
      error_message: errorMessage,
    };
  }

  // ... (keep all other existing methods unchanged)
  
  // OpenAI analysis
  async analyzeWithOpenAI(prompt) {
    try {
      logger.info("Sending request to OpenAI");

      const response = await this.openai.chat.completions.create({
        model: config.ai.openai.model,
        messages: [
          {
            role: "system",
            content: `You are an expert code reviewer. You MUST respond with ONLY valid JSON in the exact format specified. Do not include markdown formatting or additional text.`,
          },
          {
            role: "user",
            content: prompt,
          },
        ],
        max_tokens: config.ai.openai.maxTokens,
        temperature: config.ai.openai.temperature,
        response_format: { type: "json_object" },
      });

      const content = response.choices[0].message.content.trim();
      logger.info(`OpenAI response received (${content.length} characters)`);

      return content;
    } catch (error) {
      logger.error("OpenAI API error:", error);
      throw new Error(`OpenAI failed: ${error.message}`);
    }
  }

  // Gemini analysis
  async analyzeWithGemini(prompt) {
    try {
      logger.info("Sending request to Gemini");

      const enhancedPrompt = `${prompt}\n\nIMPORTANT: Respond ONLY with valid JSON. No markdown formatting.`;

      const result = await this.geminiModel.generateContent({
        contents: [
          {
            role: "user",
            parts: [{ text: enhancedPrompt }],
          },
        ],
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
      logger.error("Gemini API error:", error);
      throw new Error(`Gemini failed: ${error.message}`);
    }
  }

  // Parse AI analysis response
  parseAnalysisResponse(responseText) {
    let originalResponse = "";
    let cleanedResponse = "";

    try {
      if (!responseText || typeof responseText !== "string") {
        throw new Error(
          "Invalid response: empty or non-string response received from AI"
        );
      }

      originalResponse = responseText;
      cleanedResponse = responseText.trim();

      // Step 1: Remove markdown formatting
      cleanedResponse = cleanedResponse.replace(/```json\s*/g, "");
      cleanedResponse = cleanedResponse.replace(/```\s*/g, "");

      // Step 2: Find JSON boundaries
      const firstBraceIndex = cleanedResponse.indexOf("{");
      const lastBraceIndex = cleanedResponse.lastIndexOf("}");

      if (firstBraceIndex === -1 || lastBraceIndex === -1) {
        throw new Error("No valid JSON object found in response");
      }

      cleanedResponse = cleanedResponse.substring(
        firstBraceIndex,
        lastBraceIndex + 1
      );

      // Step 3: Parse JSON
      const analysis = JSON.parse(cleanedResponse);

      // Step 4: Validate structure
      this.validateAndNormalizeAnalysis(analysis);

      logger.info("Successfully parsed and validated AI analysis response");
      return analysis;
    } catch (error) {
      logger.error("Failed to parse AI response", { error: error.message });
      return this.createParsingErrorFallback(
        error.message,
        originalResponse,
        cleanedResponse
      );
    }
  }

  // Validate and normalize analysis structure
  validateAndNormalizeAnalysis(analysis) {
    const requiredFields = [
      "prInfo",
      "automatedAnalysis",
      "humanReviewAnalysis",
      "reviewAssessment",
      "recommendation",
    ];

    for (const field of requiredFields) {
      if (!analysis[field]) {
        analysis[field] = this.getDefaultFieldValue(field);
      }
    }

    // Normalize automatedAnalysis
    if (!analysis.automatedAnalysis.severityBreakdown) {
      analysis.automatedAnalysis.severityBreakdown = {
        blocker: 0,
        critical: 0,
        major: 0,
        minor: 0,
        info: 0,
      };
    }

    if (!analysis.automatedAnalysis.categories) {
      analysis.automatedAnalysis.categories = {
        bugs: 0,
        vulnerabilities: 0,
        securityHotspots: 0,
        codeSmells: 0,
      };
    }

    // Normalize detailedFindings
    if (!Array.isArray(analysis.detailedFindings)) {
      analysis.detailedFindings = [];
    }

    // Normalize each finding
    analysis.detailedFindings = analysis.detailedFindings.map(
      (finding, index) => {
        return {
          file: String(finding.file || `unknown-file-${index}`),
          line: Number(finding.line || 1),
          issue: String(finding.issue || "No description provided"),
          severity: this.normalizeSeverity(finding.severity),
          category: this.normalizeCategory(finding.category),
          suggestion: String(finding.suggestion || "No suggestion provided"),
        };
      }
    );

    // Ensure numeric fields
    analysis.automatedAnalysis.totalIssues =
      Number(analysis.automatedAnalysis.totalIssues) || 0;
    analysis.automatedAnalysis.technicalDebtMinutes =
      Number(analysis.automatedAnalysis.technicalDebtMinutes) || 0;

    // Validate review assessment
    const validAssessments = [
      "PROPERLY REVIEWED",
      "NOT PROPERLY REVIEWED",
      "REVIEW REQUIRED",
    ];
    if (!validAssessments.includes(analysis.reviewAssessment)) {
      analysis.reviewAssessment = "REVIEW REQUIRED";
    }
  }

  // Get default value for missing fields
  getDefaultFieldValue(fieldName) {
    const defaults = {
      prInfo: {
        prId: "unknown",
        title: "Unknown",
        repository: "unknown/unknown",
        author: "unknown",
        reviewers: [],
        url: "#",
      },
      automatedAnalysis: {
        totalIssues: 0,
        severityBreakdown: {
          blocker: 0,
          critical: 0,
          major: 0,
          minor: 0,
          info: 0,
        },
        categories: {
          bugs: 0,
          vulnerabilities: 0,
          securityHotspots: 0,
          codeSmells: 0,
        },
        technicalDebtMinutes: 0,
      },
      humanReviewAnalysis: {
        reviewComments: 0,
        issuesAddressedByReviewers: 0,
        securityIssuesCaught: 0,
        codeQualityIssuesCaught: 0,
      },
      reviewAssessment: "REVIEW REQUIRED",
      recommendation: "Unable to generate recommendation",
      detailedFindings: [],
    };

    return defaults[fieldName] || null;
  }

  // Normalize severity values
  normalizeSeverity(severity) {
    const severityStr = String(severity || "INFO").toUpperCase();
    const validSeverities = ["BLOCKER", "CRITICAL", "MAJOR", "MINOR", "INFO"];
    return validSeverities.includes(severityStr) ? severityStr : "INFO";
  }

  // Normalize category values
  normalizeCategory(category) {
    const categoryStr = String(category || "CODE_SMELL").toUpperCase();
    const validCategories = [
      "BUG",
      "VULNERABILITY",
      "SECURITY_HOTSPOT",
      "CODE_SMELL",
    ];
    return validCategories.includes(categoryStr) ? categoryStr : "CODE_SMELL";
  }

  // Create parsing error fallback
  createParsingErrorFallback(errorMessage, originalResponse, cleanedResponse) {
    return {
      prInfo: {
        prId: "parsing-error",
        title: "AI Response Parsing Error",
        repository: "unknown/unknown",
        author: "unknown",
        reviewers: [],
        url: "#",
      },
      automatedAnalysis: {
        totalIssues: 1,
        severityBreakdown: {
          blocker: 0,
          critical: 0,
          major: 1,
          minor: 0,
          info: 0,
        },
        categories: {
          bugs: 0,
          vulnerabilities: 0,
          securityHotspots: 0,
          codeSmells: 1,
        },
        technicalDebtMinutes: 15,
      },
      humanReviewAnalysis: {
        reviewComments: 0,
        issuesAddressedByReviewers: 0,
        securityIssuesCaught: 0,
        codeQualityIssuesCaught: 0,
      },
      reviewAssessment: "REVIEW REQUIRED",
      detailedFindings: [
        {
          file: "AI_PARSING_ERROR",
          line: 1,
          issue: `Failed to parse AI response: ${errorMessage}`,
          severity: "MAJOR",
          category: "CODE_SMELL",
          suggestion:
            "Check AI service configuration and review server logs for details.",
        },
      ],
      recommendation: `AI response parsing failed: ${errorMessage}. Please check AI provider configuration.`,
    };
  }

  // Create general error fallback
  createErrorFallbackAnalysis(errorMessage) {
    return {
      prInfo: {
        prId: "error",
        title: "AI Analysis Error",
        repository: "unknown/unknown",
        author: "unknown",
        reviewers: [],
        url: "#",
      },
      automatedAnalysis: {
        totalIssues: 1,
        severityBreakdown: {
          blocker: 0,
          critical: 1,
          major: 0,
          minor: 0,
          info: 0,
        },
        categories: {
          bugs: 0,
          vulnerabilities: 0,
          securityHotspots: 0,
          codeSmells: 1,
        },
        technicalDebtMinutes: 30,
      },
      humanReviewAnalysis: {
        reviewComments: 0,
        issuesAddressedByReviewers: 0,
        securityIssuesCaught: 0,
        codeQualityIssuesCaught: 0,
      },
      reviewAssessment: "REVIEW REQUIRED",
      detailedFindings: [
        {
          file: "AI_SERVICE_ERROR",
          line: 1,
          issue: `AI analysis service error: ${errorMessage}`,
          severity: "CRITICAL",
          category: "CODE_SMELL",
          suggestion:
            "Check AI service configuration and ensure the service is available.",
        },
      ],
      recommendation: `AI analysis encountered an error: ${errorMessage}. Please verify configuration.`,
    };
  }

  // Prepare data for AI analysis
  prepareAnalysisData(prData, existingComments) {
    const pr = prData.pr || prData || {};
    const files = prData.files || [];

    const structuredFiles = this.createStructuredFileData(files, prData.diff);

    return {
      repo_url: `https://github.com/${pr.repository}`,
      branch_name: pr.sourceBranch || "unknown",
      pr_number: pr.number,
      pr_id: pr.number,
      repository: pr.repository,
      target_branch: pr.targetBranch || "main",
      source_branch: pr.sourceBranch || "unknown",
      pr_info: {
        id: pr.id,
        number: pr.number,
        title: pr.title || "No title",
        description: pr.description || "No description",
        author: pr.author || "unknown",
        url: pr.url || "#",
        state: pr.state || "open",
        created_at: pr.created_at || new Date().toISOString(),
        updated_at: pr.updated_at || new Date().toISOString(),
        additions: pr.additions || 0,
        deletions: pr.deletions || 0,
        changed_files: files.length,
      },
      file_changes: structuredFiles,
      existing_comments: this.formatExistingComments(existingComments),
      reviewers: prData.reviewers || [],
    };
  }

  // Create structured file data
  createStructuredFileData(files, rawDiff) {
    const structuredFiles = [];

    files.forEach((file) => {
      if (!file.patch) return;

      structuredFiles.push({
        filename: file.filename,
        status: file.status,
        additions: file.additions,
        deletions: file.deletions,
        changes: file.changes,
        lines: this.parseFileLines(file.patch, file.filename),
        blob_url: file.blob_url,
        raw_url: file.raw_url,
        sha: file.sha,
      });
    });

    return structuredFiles;
  }

  // Parse file patch into structured lines
  parseFileLines(patch, filename) {
    const lines = patch.split("\n");
    const structuredLines = [];
    let oldLineNum = 0;
    let newLineNum = 0;

    for (const line of lines) {
      if (line.startsWith("@@")) {
        const hunkMatch = line.match(/@@\s*-(\d+),?\d*\s*\+(\d+),?\d*\s*@@/);
        if (hunkMatch) {
          oldLineNum = parseInt(hunkMatch[1]) - 1;
          newLineNum = parseInt(hunkMatch[2]) - 1;
        }
        continue;
      }

      const lineType = line.charAt(0);
      const content = line.slice(1);

      if (lineType === "-") {
        oldLineNum++;
        structuredLines.push({
          type: "deleted",
          oldLineNumber: oldLineNum,
          newLineNumber: null,
          content: content,
          commentable: false,
        });
      } else if (lineType === "+") {
        newLineNum++;
        structuredLines.push({
          type: "added",
          oldLineNumber: null,
          newLineNumber: newLineNum,
          content: content,
          commentable: true,
        });
      } else if (lineType === " ") {
        oldLineNum++;
        newLineNum++;
        structuredLines.push({
          type: "context",
          oldLineNumber: oldLineNum,
          newLineNumber: newLineNum,
          content: content,
          commentable: false,
        });
      }
    }

    return structuredLines;
  }

  // Format existing comments
  formatExistingComments(comments) {
    return comments.map((comment) => ({
      id: comment.id,
      user: comment.user,
      body: comment.body,
      created_at: comment.createdAt,
      type: comment.type,
      file: comment.path || null,
      line: comment.line || null,
    }));
  }

  // Enhance analysis with PR context
  enhanceAnalysisWithContext(analysis, prData, existingComments) {
    if (analysis.prInfo && prData.pr) {
      analysis.prInfo.prId = prData.pr.number;
      analysis.prInfo.title = prData.pr.title;
      analysis.prInfo.repository = prData.pr.repository;
      analysis.prInfo.author = prData.pr.author;
      analysis.prInfo.url = prData.pr.url;
      analysis.prInfo.reviewers = prData.reviewers || [];
    }

    if (analysis.humanReviewAnalysis) {
      analysis.humanReviewAnalysis.reviewComments = existingComments.length;
    }

    return analysis;
  }

  // Check AI service health
  async checkHealth() {
    try {
      const testPrompt = `{"status": "OK", "test": true}`;

      if (this.provider === "openai" && this.openai) {
        const response = await this.openai.chat.completions.create({
          model: config.ai.openai.model,
          messages: [
            { role: "user", content: `Return exactly: ${testPrompt}` },
          ],
          max_tokens: 50,
          response_format: { type: "json_object" },
        });

        const content = response.choices[0].message.content.trim();
        const parsed = JSON.parse(content);
        return parsed.status === "OK";
      } else if (this.provider === "gemini" && this.geminiModel) {
        const result = await this.geminiModel.generateContent(
          `Return exactly: ${testPrompt}`
        );
        const response = await result.response;
        const content = response.text().trim();
        const parsed = JSON.parse(content);
        return parsed.status === "OK";
      }

      return false;
    } catch (error) {
      logger.error("AI health check failed:", error);
      return false;
    }
  }

  // Check merge readiness wrapper method
  async checkMergeReadiness(analysis, checkRunData) {
    try {
      logger.info(`Checking merge readiness for analysis`, {
        trackingId: analysis.trackingId,
      });

      // Get PR data from checkRunData if available
      const prData = checkRunData.prData || {
        pr: {
          number: checkRunData.pullNumber,
          repository: `${checkRunData.owner}/${checkRunData.repo}`,
          mergeable: true,
          mergeable_state: "clean",
        },
        files: [],
        comments: [],
      };

      const aiFindings = analysis.detailedFindings || [];
      const reviewComments = checkRunData.reviewComments || [];
      const currentStatus = {
        mergeable: true,
        merge_state: "clean",
        review_decision: null,
      };

      // Use the main assessMergeReadiness method
      const mergeAssessment = await this.assessMergeReadiness(
        prData,
        aiFindings,
        reviewComments,
        currentStatus
      );

      logger.info(
        `Merge readiness assessment completed: ${mergeAssessment.status}`,
        {
          score: mergeAssessment.merge_readiness_score,
          trackingId: analysis.trackingId,
        }
      );

      // Format the response for the check run
      return {
        isReady: mergeAssessment.status === "READY_FOR_MERGE",
        summary: `${mergeAssessment.status}: ${mergeAssessment.reason}`,
        details: this.formatMergeReadinessDetails(mergeAssessment),
        status: mergeAssessment.status,
        score: mergeAssessment.merge_readiness_score,
        recommendation: mergeAssessment.recommendation,
      };
    } catch (error) {
      logger.error("Error in checkMergeReadiness:", error);
      throw new Error(`Failed to check merge readiness: ${error.message}`);
    }
  }

  // Format merge readiness details helper
  formatMergeReadinessDetails(mergeAssessment) {
    let details = `## Merge Readiness Assessment\n\n`;
    details += `**Status:** ${mergeAssessment.status}\n`;
    details += `**Score:** ${mergeAssessment.merge_readiness_score}/100\n`;
    details += `**Confidence:** ${mergeAssessment.confidence}\n\n`;
    details += `**Reason:** ${mergeAssessment.reason}\n\n`;
    details += `**Recommendation:** ${mergeAssessment.recommendation}\n\n`;

    if (
      mergeAssessment.outstanding_issues &&
      mergeAssessment.outstanding_issues.length > 0
    ) {
      details += `### Outstanding Issues (${mergeAssessment.outstanding_issues.length})\n`;
      mergeAssessment.outstanding_issues.forEach((issue, index) => {
        const issueText =
          typeof issue === "string"
            ? issue
            : issue.description || issue.message || JSON.stringify(issue);
        details += `${index + 1}. ${issueText}\n`;
      });
      details += "\n";
    }

    if (mergeAssessment.conversation_analysis) {
      details += `### Conversation Analysis\n`;
      const ca = mergeAssessment.conversation_analysis;
      details += `- Total Conversations: ${ca.total_conversations || 0}\n`;
      details += `- Resolved Conversations: ${ca.resolved_conversations || 0}\n`;
      details += `- Unresolved Conversations: ${ca.unresolved_conversations || 0}\n`;
      details += `- Pending Conversations: ${ca.pending_conversations || 0}\n`;
      details += `- Resolution Percentage: ${ca.resolution_percentage || 0}%\n`;
      details += `- Assessment Method: ${ca.assessment_method || 'standard'}\n\n`;
    }

    return details;
  }

  // Helper methods for AI calls
  async callAI(prompt, responseFormat) {
    if (this.provider === "openai" && this.openai) {
      const response = await this.openai.chat.completions.create({
        model: config.ai.openai.model,
        messages: [{ role: "user", content: prompt }],
        max_tokens: 4096,
        response_format: { type: responseFormat },
      });
      return response.choices[0].message.content;
    } else if (this.provider === "gemini" && this.geminiModel) {
      const result = await this.geminiModel.generateContent(prompt);
      const response = await result.response;
      return response.text();
    }
    throw new Error("No AI provider configured or initialized.");
  }

  parseAIResponse(responseText) {
    const cleanedText = responseText
      .replace(/```json/g, "")
      .replace(/```/g, "");
    if (!isValidJSON(cleanedText)) {
      throw new Error("AI returned invalid JSON.");
    }
    return JSON.parse(cleanedText);
  }

  processAIAnalysis(parsedResponse, prData) {
    const analysis = {
      trackingId: generateTrackingId(),
      timestamp: new Date().toISOString(),
      prInfo: {
        pullNumber: prData.pullNumber,
        repository: prData.pr.repository,
        author: prData.pr.author,
        url: prData.pr.url,
        reviewers: prData.reviewers || [],
      },
      ...parsedResponse,
    };
    if (analysis.humanReviewAnalysis) {
      analysis.humanReviewAnalysis.reviewComments =
        prData.existingComments.length;
    }
    return analysis;
  }

  // Enhanced code fix generation methods
  async generateDetailedCodeFix(enhancedContext) {
    try {
      const { file, issue, pr } = enhancedContext;

      logger.info(`Generating detailed code fix for ${file.name}:${file.line}`);

      // Extract the problematic code around the line
      const lines = file.content.split('\n');
      const lineIndex = file.line - 1;
      const contextLines = 3; // Get 3 lines before and after

      const startLine = Math.max(0, lineIndex - contextLines);
      const endLine = Math.min(lines.length - 1, lineIndex + contextLines);
      const contextCode = lines.slice(startLine, endLine + 1).join('\n');
      const problematicLine = lines[lineIndex] || '';

      // Create a more detailed prompt for the AI
      const detailedPrompt = `You are a security-focused code reviewer. Your task is to provide EXACT code replacements for security vulnerabilities and code issues.

CRITICAL REQUIREMENTS:
1. Provide EXACT code that can directly replace the problematic code
2. Maintain the same function structure and variable names
3. Preserve indentation and code style
4. Focus on the actual code fix, not explanations

Current file: ${file.name}
Issue: ${issue.description}
Category: ${issue.category}
Severity: ${issue.severity}

Problematic line ${file.line}: "${problematicLine.trim()}"

Context code around the issue:
\`\`\`javascript
${contextCode}
\`\`\`

Provide your response in this EXACT JSON format:
{
  "current_code": "exact problematic code that needs to be replaced",
  "suggested_fix": "exact replacement code that fixes the issue",
  "explanation": "brief explanation of why this fixes the issue",
  "confidence": "High|Medium|Low"
}

EXAMPLES for common issues:

SQL Injection:
{
  "current_code": "const query = \`SELECT * FROM users WHERE username = '\${username}' AND password = '\${password}'\`;",
  "suggested_fix": "const query = 'SELECT * FROM users WHERE username = ? AND password = ?';\\nexecuteQuery(query, [username, password]);",
  "explanation": "Uses parameterized queries to prevent SQL injection",
  "confidence": "High"
}

XSS Prevention:
{
  "current_code": "element.innerHTML = userInput;",
  "suggested_fix": "element.textContent = userInput;",
  "explanation": "Uses textContent instead of innerHTML to prevent XSS",
  "confidence": "High"
}

Provide ONLY the JSON response, no additional text.`;

      // Use existing callAI method
      const aiResponse = await this.callAI(detailedPrompt, "json_object");

      if (!aiResponse) {
        throw new Error('AI service returned empty response');
      }

      // Parse the AI response
      let fixData;
      try {
        // Clean the response to extract JSON
        const cleanResponse = aiResponse.replace(/```json\n?/g, '').replace(/```/g, '').trim();
        fixData = JSON.parse(cleanResponse);
      } catch (parseError) {
        logger.error('Failed to parse AI response as JSON:', parseError);

        // Fallback: try to extract code from the response
        const currentCodeMatch = aiResponse.match(/["']current_code["']\s*:\s*["']([^"']*?)["']/s);
        const suggestedFixMatch = aiResponse.match(/["']suggested_fix["']\s*:\s*["']([^"']*?)["']/s);
        const explanationMatch = aiResponse.match(/["']explanation["']\s*:\s*["']([^"']*?)["']/s);

        if (currentCodeMatch && suggestedFixMatch) {
          fixData = {
            current_code: currentCodeMatch[1].replace(/\\n/g, '\n').replace(/\\"/g, '"'),
            suggested_fix: suggestedFixMatch[1].replace(/\\n/g, '\n').replace(/\\"/g, '"'),
            explanation: explanationMatch ? explanationMatch[1] : 'AI-generated fix',
            confidence: 'Medium'
          };
        } else {
          throw new Error(`Could not parse AI response: ${parseError.message}`);
        }
      }

      // Validate the response
      if (!fixData.current_code || !fixData.suggested_fix) {
        throw new Error('AI response missing required fields: current_code or suggested_fix');
      }

      // Clean up the code strings
      fixData.current_code = fixData.current_code.replace(/\\n/g, '\n').replace(/\\t/g, '\t');
      fixData.suggested_fix = fixData.suggested_fix.replace(/\\n/g, '\n').replace(/\\t/g, '\t');

      logger.info(`Detailed code fix generated successfully`, {
        hasCurrentCode: !!fixData.current_code,
        hasSuggestedFix: !!fixData.suggested_fix,
        confidence: fixData.confidence,
        currentCodeLength: fixData.current_code.length,
        suggestedFixLength: fixData.suggested_fix.length
      });

      return {
        current_code: fixData.current_code,
        suggested_fix: fixData.suggested_fix,
        explanation: fixData.explanation || 'AI-generated security fix',
        confidence: fixData.confidence || 'Medium',
        estimated_effort: 'Low',
        category: issue.category,
        severity: issue.severity
      };

    } catch (error) {
      logger.error('Error generating detailed code fix:', error);
      return {
        error: true,
        error_message: error.message,
        current_code: null,
        suggested_fix: null
      };
    }
  }

  async generateCodeFixSuggestion(finding, fileContent, prData) {
    try {
      logger.info(`Generating code fix suggestion for ${finding.file}:${finding.line}`);

      // Extract context around the problematic line
      const lines = fileContent.split('\n');
      const lineIndex = finding.line - 1;
      const contextLines = 5;

      const startLine = Math.max(0, lineIndex - contextLines);
      const endLine = Math.min(lines.length - 1, lineIndex + contextLines);
      const contextCode = lines.slice(startLine, endLine + 1).join('\n');
      const problematicLine = lines[lineIndex] || '';

      const prompt = `You are a security-focused code reviewer. Provide EXACT code replacements for this issue.

File: ${finding.file}
Issue: ${finding.issue}
Suggestion: ${finding.suggestion}
Severity: ${finding.severity}

Problematic line ${finding.line}: "${problematicLine.trim()}"

Code context:
\`\`\`javascript
${contextCode}
\`\`\`

Respond ONLY with valid JSON:
{
  "current_code": "exact code to replace",
  "suggested_fix": "exact replacement code", 
  "explanation": "brief explanation"
}

For SQL injection, provide parameterized queries.
For XSS, use textContent or proper escaping.
Maintain original code structure and style.`;

      // Use existing callAI method
      const response = await this.callAI(prompt, "json_object");

      if (!response) {
        throw new Error('AI service returned empty response');
      }

      // Parse JSON response
      let fixData;
      try {
        const cleanResponse = response.replace(/```json\n?/g, '').replace(/```/g, '').trim();
        fixData = JSON.parse(cleanResponse);
      } catch (parseError) {
        // Fallback parsing
        const currentMatch = response.match(/["']current_code["']\s*:\s*["']([^"']*?)["']/s) ||
          response.match(/current_code["']\s*:\s*["']([^"']*?)["']/s);
        const fixMatch = response.match(/["']suggested_fix["']\s*:\s*["']([^"']*?)["']/s) ||
          response.match(/suggested_fix["']\s*:\s*["']([^"']*?)["']/s);

        if (currentMatch && fixMatch) {
          fixData = {
            current_code: currentMatch[1].replace(/\\n/g, '\n'),
            suggested_fix: fixMatch[1].replace(/\\n/g, '\n'),
            explanation: 'AI-generated fix'
          };
        } else {
          throw parseError;
        }
      }

      return {
        current_code: fixData.current_code?.replace(/\\n/g, '\n') || null,
        suggested_fix: fixData.suggested_fix?.replace(/\\n/g, '\n') || finding.suggestion,
        explanation: fixData.explanation || 'AI-generated code fix',
        confidence: 'High',
        estimated_effort: 'Low'
      };

    } catch (error) {
      logger.error('Error generating code fix suggestion:', error);
      return {
        error: true,
        error_message: error.message
      };
    }
  }
}

module.exports = new AIService();