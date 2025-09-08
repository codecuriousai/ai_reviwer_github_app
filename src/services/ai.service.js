// src/services/ai.service.js - Enhanced AI Service with Resolved Conversation-Based Merge Readiness

const OpenAI = require("openai");
const { GoogleGenerativeAI } = require("@google/generative-ai");
const config = require("../config/config");
const logger = require("../utils/logger");
const { getCodeReviewPrompt } = require("../prompts/prompts");

// Add this at the top of ai.service.js
const { graphql } = require("@octokit/graphql");

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

    // CORRECTED: Comment filtering configuration 
    this.commentFilterConfig = {
      include: {
        commentTypes: [
          'REVIEW_COMMENT',        // Line-specific review comments (ALWAYS has resolve button)
          'PULL_REQUEST_COMMENT',  // General PR comments (conditional)
        ],
        authorTypes: [
          'HUMAN',
          'COLLABORATOR',
          'CONTRIBUTOR',
          'OWNER',
          'MEMBER',
          'BOT'                    // INCLUDE bots that make review comments
        ]
      },

      exclude: {
        // Only exclude these specific automation bots
        excludeSpecificBots: [
          'github-actions[bot]',
          'dependabot[bot]',
          'renovate[bot]',
          'codecov[bot]',
          'sonarcloud[bot]',
          'security-bot[bot]',
          'snyk-bot',
          'greenkeeper[bot]',
          'mergify[bot]'
          // NOTE: Do NOT exclude 'your-ai-code-reviewer' or similar AI review bots
        ],

        // Patterns that identify NON-RESOLVABLE analysis reports
        nonResolvablePatterns: [
          'MERGE REQUEST REVIEW ANALYSIS',
          '📋 Pull Request Information:',
          '🤖 AUTOMATED ANALYSIS RESULTS:',
          '👥 HUMAN REVIEW ANALYSIS:',
          '⚖️ REVIEW ASSESSMENT:',
          '🎯 RECOMMENDATION:',
          'PR ANALYSIS REPORT',
          'SECURITY SCAN RESULTS',
          'CODE QUALITY REPORT',
          'BUILD STATUS',
          'DEPLOYMENT STATUS',
          'TEST RESULTS',
          'COVERAGE REPORT'
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

  // CORRECTED: Assess merge readiness with proper bot comment handling
 async assessMergeReadiness(prData, aiFindings, reviewComments, currentStatus) {
  try {
    logger.info(`Assessing merge readiness for PR #${prData.pr?.number} - Using GraphQL API`, {
      totalComments: reviewComments?.length || 0,
    });

    // Extract owner, repo, and PR number
    const repository = prData.pr?.repository || '';
    const [owner, repo] = repository.split('/');
    const pullNumber = prData.pr?.number;

    if (!owner || !repo || !pullNumber) {
      throw new Error(`Invalid PR data: owner=${owner}, repo=${repo}, pullNumber=${pullNumber}`);
    }

    // STEP 1: Use GraphQL to get actual conversation resolution status
    const reviewThreads = await this.getReviewThreadsViaGraphQL(owner, repo, pullNumber);

    logger.info(`Fetched ${reviewThreads.length} review threads via GraphQL`, {
      owner,
      repo,
      pullNumber
    });

    // STEP 2: Analyze actual resolved status using GraphQL data
    const resolvedStatus = this.analyzeGraphQLReviewThreads(reviewThreads);

    logger.info(`GraphQL resolved conversation analysis`, resolvedStatus);

    // STEP 3: Determine merge readiness based on ACTUAL resolution status
    return this.determineMergeReadinessFromGraphQL(resolvedStatus, prData);

  } catch (error) {
    logger.error("Critical error assessing merge readiness:", error);
    return this.createErrorMergeAssessment(`Critical Error: ${error.message}`);
  }
}

  // NEW METHOD: Get review threads using GraphQL API
 async getReviewThreadsViaGraphQL(owner, repo, pullNumber) {
   try {
     const githubToken = process.env.GITHUB_TOKEN || config.github?.token;
     
     if (!githubToken) {
       throw new Error('GITHUB_TOKEN not found in environment variables or config');
     }
 
     const graphqlWithAuth = graphql.defaults({
       headers: {
         authorization: `token ${githubToken}`,
       },
     });
 
     const query = `
       query($owner: String!, $repo: String!, $pullNumber: Int!) {
         repository(owner: $owner, name: $repo) {
           pullRequest(number: $pullNumber) {
             reviewThreads(first: 100) {
               nodes {
                 id
                 isResolved
                 isCollapsed
                 resolvedBy {
                   login
                 }
                 comments(first: 50) {
                   nodes {
                     id
                     body
                     author {
                       login
                     }
                     createdAt
                     path
                     line
                     originalLine
                   }
                 }
               }
             }
           }
         }
       }
     `;
 
     logger.info('Executing GraphQL query for review threads', {
       owner,
       repo,
       pullNumber
     });
 
     const result = await graphqlWithAuth(query, {
       owner,
       repo,
       pullNumber: parseInt(pullNumber)
     });
 
     if (!result?.repository?.pullRequest?.reviewThreads?.nodes) {
       logger.warn('No review threads found in GraphQL response');
       return [];
     }
 
     const threads = result.repository.pullRequest.reviewThreads.nodes;
     
     logger.info(`GraphQL query successful: found ${threads.length} review threads`);
     
     // Log thread details for debugging
     threads.forEach((thread, index) => {
       logger.debug(`GraphQL Thread #${index + 1}:`, {
         id: thread.id,
         isResolved: thread.isResolved,
         resolvedBy: thread.resolvedBy?.login,
         commentsCount: thread.comments.nodes.length,
         firstComment: {
           author: thread.comments.nodes[0]?.author?.login,
           path: thread.comments.nodes[0]?.path,
           line: thread.comments.nodes[0]?.line,
           bodyPreview: thread.comments.nodes[0]?.body?.substring(0, 100) + "..."
         }
       });
     });
 
     return threads;
 
   } catch (error) {
     logger.error('GraphQL API error:', error);
     
     if (error.message?.includes('401')) {
       throw new Error('GitHub token authentication failed. Check GITHUB_TOKEN.');
     } else if (error.message?.includes('404')) {
       throw new Error(`PR not found: ${owner}/${repo}#${pullNumber}`);
     } else {
       throw new Error(`GraphQL API error: ${error.message}`);
     }
   }
 }
 

// NEW METHOD: Analyze GraphQL review threads for resolution status
analyzeGraphQLReviewThreads(reviewThreads) {
  if (reviewThreads.length === 0) {
    logger.info('No review threads found - PR ready for merge');
    return {
      totalConversations: 0,
      resolvedConversations: 0,
      unresolvedCount: 0,
      unresolvedConversations: [],
      allResolved: true,
      resolutionPercentage: 100
    };
  }

  let totalConversations = reviewThreads.length;
  let resolvedConversations = 0;
  let unresolvedConversations = [];

  reviewThreads.forEach((thread, index) => {
    logger.debug(`GraphQL Thread analysis #${index + 1}:`, {
      id: thread.id,
      isResolved: thread.isResolved,
      resolvedBy: thread.resolvedBy?.login,
      commentsCount: thread.comments.nodes.length
    });

    if (thread.isResolved) {
      resolvedConversations++;
      logger.debug(`✅ Thread ${thread.id} is RESOLVED by ${thread.resolvedBy?.login}`);
    } else {
      logger.debug(`❌ Thread ${thread.id} is UNRESOLVED`);
      
      const firstComment = thread.comments.nodes[0];
      unresolvedConversations.push({
        threadId: thread.id,
        isResolved: false,
        commentsCount: thread.comments.nodes.length,
        firstComment: {
          author: firstComment?.author?.login,
          body: firstComment?.body,
          path: firstComment?.path,
          line: firstComment?.line,
          createdAt: firstComment?.createdAt
        }
      });
    }
  });

  const result = {
    totalConversations,
    resolvedConversations,
    unresolvedCount: unresolvedConversations.length,
    unresolvedConversations,
    allResolved: unresolvedConversations.length === 0,
    resolutionPercentage: totalConversations > 0 ? 
      Math.round((resolvedConversations / totalConversations) * 100) : 100
  };

  logger.info('GraphQL Review thread resolution summary:', result);
  return result;
}

// NEW METHOD: Determine merge readiness based on GraphQL data
determineMergeReadinessFromGraphQL(resolvedStatus, prData) {
  const { allResolved, unresolvedConversations, totalConversations, resolutionPercentage } = resolvedStatus;

  if (allResolved) {
    if (totalConversations === 0) {
      logger.info(`✅ READY FOR MERGE - No review conversations found`);
      return {
        status: "READY_FOR_MERGE",
        reason: "No reviewer conversations require resolution.",
        recommendation: "This PR is ready for merge. No review conversations require resolution.",
        outstanding_issues: [],
        conversation_analysis: {
          total_conversations: totalConversations,
          resolved_conversations: resolvedStatus.resolvedConversations,
          unresolved_conversations: 0,
          resolution_percentage: resolutionPercentage,
          assessment_method: 'graphql_api'
        },
        merge_readiness_score: 100,
        confidence: "high",
        error: false,
      };
    } else {
      logger.info(`✅ READY FOR MERGE - All ${totalConversations} conversations resolved`);
      return {
        status: "READY_FOR_MERGE",
        reason: `All ${totalConversations} reviewer conversations have been resolved using GitHub's 'Resolve conversation' button.`,
        recommendation: "This PR is ready for merge. All reviewer feedback has been properly resolved.",
        outstanding_issues: [],
        conversation_analysis: {
          total_conversations: totalConversations,
          resolved_conversations: resolvedStatus.resolvedConversations,
          unresolved_conversations: 0,
          resolution_percentage: resolutionPercentage,
          assessment_method: 'graphql_api'
        },
        merge_readiness_score: 100,
        confidence: "high",
        error: false,
      };
    }
  }

  // SCENARIO 2: Unresolved conversations exist - NOT READY
  const totalUnresolved = unresolvedConversations.length;
  logger.info(`❌ NOT READY - ${totalUnresolved} conversations require resolution`);

  return {
    status: "NOT_READY_FOR_MERGE",
    reason: `${totalUnresolved} reviewer conversations require resolution. Click 'Resolve conversation' for each after addressing the feedback.`,
    recommendation: `Address the feedback in ${totalUnresolved} conversation(s) and click 'Resolve conversation' for each thread.`,
    outstanding_issues: unresolvedConversations.map(conv => ({
      type: "UNRESOLVED_CONVERSATION", 
      severity: "MAJOR",
      description: `Review conversation requires GitHub resolution`,
      thread_id: conv.threadId,
      comments_count: conv.commentsCount,
      author: conv.firstComment?.author,
      file: conv.firstComment?.path,
      line: conv.firstComment?.line,
      body_preview: conv.firstComment?.body?.substring(0, 200) + "...",
      created_at: conv.firstComment?.createdAt,
      resolution_required: true,
      instructions: "Click 'Resolve conversation' button after addressing this feedback"
    })),
    conversation_analysis: {
      total_conversations: totalConversations,
      resolved_conversations: resolvedStatus.resolvedConversations,
      unresolved_conversations: unresolvedConversations.length,
      resolution_percentage: resolutionPercentage,
      assessment_method: 'graphql_api'
    },
    merge_readiness_score: Math.max(0, resolutionPercentage - 50),
    confidence: "high", 
    error: false,
  };
}


  // NEW METHOD: Filter comments to only include those that have "Resolve conversation" capability
  filterResolvableComments(comments) {
    const resolvableComments = [];

    comments.forEach(comment => {
      const commentId = comment.id || 'unknown';
      const authorLogin = comment.user?.login?.toLowerCase() || '';

      logger.debug(`Processing comment ${commentId}`, {
        author: authorLogin,
        hasPath: !!comment.path,
        hasLine: !!(comment.line || comment.original_line),
        hasReviewId: !!comment.pull_request_review_id,
        bodyPreview: comment.body?.substring(0, 100) + "..."
      });

      // RULE 1: Exclude non-resolvable analysis reports (regardless of author)
      if (this.hasNonResolvableContent(comment)) {
        logger.debug(`❌ Excluding comment - non-resolvable analysis report`, {
          commentId,
          author: authorLogin,
          pattern: this.findMatchingPattern(comment)
        });
        return;
      }

      // RULE 2: Exclude specific automation bots (but ALLOW AI reviewer bots)
      if (this.isExcludedBot(comment)) {
        logger.debug(`❌ Excluding comment - excluded automation bot: ${authorLogin}`, { commentId });
        return;
      }

      // RULE 3: INCLUDE line-specific review comments (these ALWAYS have resolve buttons)
      if (this.isLineSpecificReviewComment(comment)) {
        logger.debug(`✅ Including line-specific review comment`, {
          commentId,
          author: authorLogin,
          file: comment.path,
          line: comment.line || comment.original_line
        });
        resolvableComments.push(comment);
        return;
      }

      // RULE 4: INCLUDE threaded conversation comments
      if (this.isThreadedConversationComment(comment)) {
        logger.debug(`✅ Including threaded conversation comment`, {
          commentId,
          author: authorLogin,
          inReplyTo: comment.in_reply_to_id
        });
        resolvableComments.push(comment);
        return;
      }

      // RULE 5: Exclude all other types (standalone announcements, etc.)
      logger.debug(`❌ Excluding comment - not resolvable type`, {
        commentId,
        author: authorLogin
      });
    });

    logger.info(`FIXED Filtering completed: ${resolvableComments.length} resolvable comments found`);
    return resolvableComments;
  }

  // NEW: Check if comment is a line-specific review comment (ALWAYS resolvable)
  isLineSpecificReviewComment(comment) {
    // Must have file path AND line number to be a line-specific review comment
    return !!(comment.path && (comment.line || comment.original_line));
  }

  // NEW: Check if comment is part of a threaded conversation (resolvable)
  isThreadedConversationComment(comment) {
    // Comments that are replies or have review IDs are typically resolvable
    return !!(comment.in_reply_to_id || comment.pull_request_review_id);
  }

  // NEW: Check if a bot should be excluded (specific automation bots only)
  isExcludedBot(comment) {
    const authorLogin = comment.user?.login?.toLowerCase() || '';

    return this.commentFilterConfig.exclude.excludeSpecificBots.some(bot =>
      authorLogin.includes(bot.toLowerCase().replace('[bot]', ''))
    );
  }

  // NEW METHOD: Check if a comment has "Resolve conversation" capability
  commentHasResolveCapability(comment) {
    // RULE 1: Review comments (line-specific) always have resolve capability
    if (comment.path && (comment.line || comment.original_line) &&
      (comment.pull_request_review_id || comment.diff_hunk)) {
      return true;
    }

    // RULE 2: Comments that are part of a review conversation thread
    if (comment.in_reply_to_id || comment.pull_request_review_id) {
      return true;
    }

    // RULE 3: Comments with GitHub's conversation resolution metadata
    if (comment.resolved !== undefined ||
      comment.conversation_resolved !== undefined ||
      comment.resolvable === true) {
      return true;
    }

    // RULE 4: Check if comment has conversation threading (GitHub's internal structure)
    if (comment.node_id && comment.subject_type === 'PullRequest') {
      // These are typically resolvable if they're not standalone announcements
      return !this.isStandaloneAnnouncement(comment);
    }

    // RULE 5: PR comments are generally NOT resolvable unless they're threaded
    // This catches cases like "MERGE REQUEST REVIEW ANALYSIS" comments
    return false;
  }

  // CORRECTED: Check if PR comment has resolve button capability  
  prCommentHasResolveButton(comment) {
    // Check if this is a threaded conversation (has replies or is a reply)
    if (comment.in_reply_to_id) {
      return true; // Replies in threads are resolvable
    }

    // Check if this comment has been explicitly marked as resolvable by GitHub
    if (comment.resolvable === true || comment.resolved !== undefined) {
      return true;
    }

    // IMPORTANT: Don't include standalone analysis reports
    if (this.isStandaloneAnnouncement(comment)) {
      return false;
    }

    // For general PR comments from bots, they're usually NOT resolvable unless threaded
    const authorType = this.determineAuthorType(comment);
    if (authorType === 'BOT' && !comment.in_reply_to_id) {
      return false; // Standalone bot comments typically don't have resolve buttons
    }

    // For human comments, they're typically resolvable if they're discussion-oriented
    return this.isDiscussionOrientedComment(comment);
  }

  // NEW METHOD: Check if comment is a standalone announcement (no resolve button)
  isStandaloneAnnouncement(comment) {
    const body = comment.body?.toUpperCase() || '';

    const announcementPatterns = [
      'MERGE REQUEST REVIEW ANALYSIS',
      'PR ANALYSIS',
      'AUTOMATED REVIEW',
      'SECURITY SCAN RESULTS',
      'CODE QUALITY REPORT',
      'BUILD STATUS',
      'DEPLOYMENT STATUS',
      'TEST RESULTS',
      'COVERAGE REPORT'
    ];

    return announcementPatterns.some(pattern => body.includes(pattern));
  }

  // CORRECTED: Review comments have resolve capability if they're line-specific
  reviewCommentHasResolveCapability(comment) {
    // Review comments with file path and line number always have resolve buttons
    return !!(comment.path && (comment.line || comment.original_line));
  }

  // NEW METHOD: Check if comment is discussion-oriented (likely has resolve button)
  isDiscussionOrientedComment(comment) {
    const body = comment.body?.toLowerCase() || '';

    const discussionIndicators = [
      'what do you think',
      'could you',
      'please consider',
      'thoughts on',
      'feedback on',
      'suggestion:',
      'question:',
      'concern:',
      'issue with',
      'problem with',
      '?',
      'review:',
      'change:',
    ];

    return discussionIndicators.some(indicator => body.includes(indicator));
  }

  // CORRECTED: Check for non-resolvable content patterns
  hasNonResolvableContent(comment) {
    const body = comment.body?.toUpperCase() || '';

    return this.commentFilterConfig.exclude.nonResolvablePatterns.some(pattern =>
      body.includes(pattern.toUpperCase())
    );
  }

  // CORRECTED: Better comment type detection
  determineCommentType(comment) {
    // Priority 1: Review comments (line-specific) - ALWAYS RESOLVABLE
    if (comment.path && (comment.line || comment.original_line)) {
      return 'REVIEW_COMMENT';
    }

    // Priority 2: Check for non-resolvable analysis reports first
    if (this.hasNonResolvableContent(comment)) {
      return 'BOT_ANALYSIS_COMMENT'; // This will be excluded
    }

    // Priority 3: Pull request comments
    if (comment.pull_request_url ||
      comment.issue_url?.includes('/pull/') ||
      comment.html_url?.includes('/pull/')) {
      return 'PULL_REQUEST_COMMENT';
    }

    // Other types
    if (comment.issue_url && !comment.issue_url.includes('/pull/')) {
      return 'ISSUE_COMMENT';
    }

    if (comment.commit_id || comment.url?.includes('/commit/')) {
      return 'COMMIT_COMMENT';
    }

    return 'PULL_REQUEST_COMMENT';
  }

  // ENHANCED: Analyze conversation thread with better resolution detection
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
      comment.state === 'resolved' ||
      comment.conversation?.resolved === true
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

    // PRIORITY 2: Look for explicit resolution keywords from authoritative users
    const hasResolutionKeywords = comments.some(comment => {
      const body = comment.body?.toLowerCase() || '';

      // Only count resolution keywords from PR author, collaborators, or the comment author themselves
      const isAuthoritative = comment.author_association === 'OWNER' ||
        comment.author_association === 'COLLABORATOR' ||
        comment.author_association === 'MEMBER';

      if (!isAuthoritative) return false;

      return (
        body.includes('resolved') ||
        body.includes('fixed') ||
        body.includes('addressed') ||
        body.includes('done') ||
        body.includes('completed') ||
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
        reason: hasResolutionKeywords ? 'Developer marked as resolved' : 'Approval found',
        hasGitHubResolution: false
      };
    }

    if (hasChangeRequest) {
      return {
        isResolved: false,
        isPending: false,
        requiresAction: true,
        reason: 'Change request found - requires action',
        hasGitHubResolution: false
      };
    }

    // CORRECTED: For resolvable comments, if no clear resolution, consider UNRESOLVED
    return {
      isResolved: false,
      isPending: false,
      requiresAction: true,
      reason: 'Review comment requires GitHub conversation resolution',
      hasGitHubResolution: false
    };
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
      user.type === 'Bot') {
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
        hasGitHubResolution: threadStatus.hasGitHubResolution,
        reason: threadStatus.reason
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

    logger.info('CORRECTED Conversation resolution summary:', result);
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

    // SCENARIO 1: All resolvable conversations resolved or no resolvable conversations
    if (allResolved) {
      if (totalConversations === 0) {
        logger.info(`✅ READY FOR MERGE - No resolvable conversations found`);
        return {
          status: "READY_FOR_MERGE",
          reason: "No reviewer conversations require resolution.",
          recommendation: "This PR is ready for merge. No review conversations require resolution.",
          outstanding_issues: [],
          conversation_analysis: {
            total_conversations: totalConversations,
            resolved_conversations: resolvedStatus.resolvedConversations,
            unresolved_conversations: 0,
            pending_conversations: 0,
            resolution_percentage: resolutionPercentage,
            assessment_method: 'corrected_bot_filtering'
          },
          merge_readiness_score: 100,
          confidence: "high",
          error: false,
        };
      } else {
        logger.info(`✅ READY FOR MERGE - All ${totalConversations} conversations resolved`);
        return {
          status: "READY_FOR_MERGE",
          reason: `All ${totalConversations} resolvable reviewer conversations have been resolved using GitHub's 'Resolve conversation' feature.`,
          recommendation: "This PR is ready for merge. All reviewer feedback requiring resolution has been addressed.",
          outstanding_issues: [],
          conversation_analysis: {
            total_conversations: totalConversations,
            resolved_conversations: resolvedStatus.resolvedConversations,
            unresolved_conversations: 0,
            pending_conversations: 0,
            resolution_percentage: resolutionPercentage,
            assessment_method: 'corrected_bot_filtering'
          },
          merge_readiness_score: 100,
          confidence: "high",
          error: false,
        };
      }
    }

    // SCENARIO 2: Unresolved conversations exist - NOT READY
    const totalUnresolved = unresolvedConversations.length + pendingConversations.length;
    logger.info(`❌ NOT READY - ${totalUnresolved} conversations require resolution`);

    return {
      status: "NOT_READY_FOR_MERGE",
      reason: `${totalUnresolved} reviewer conversations require resolution. Use GitHub's 'Resolve conversation' button for each after addressing the feedback.`,
      recommendation: `Address the feedback in ${totalUnresolved} conversation(s) and click 'Resolve conversation' for each. Review comments from bots (like your-ai-code-reviewer) also need to be resolved.`,
      outstanding_issues: [...unresolvedConversations, ...pendingConversations].map(conv => ({
        type: "UNRESOLVED_CONVERSATION",
        severity: conv.requiresAction ? "MAJOR" : "MINOR",
        description: `Conversation in ${conv.threadId} requires GitHub resolution (${conv.comments} comments)`,
        last_comment: conv.lastComment.body?.substring(0, 100) + "...",
        requires_action: true,
        reason: conv.reason,
        file: conv.threadId.includes(':') ? conv.threadId.split(':')[0] : null,
        line: conv.threadId.includes(':') ? conv.threadId.split(':')[1] : null,
        author: conv.lastComment.user?.login,
        created_at: conv.lastComment.created_at,
        resolution_required: true
      })),
      conversation_analysis: {
        total_conversations: totalConversations,
        resolved_conversations: resolvedStatus.resolvedConversations,
        unresolved_conversations: unresolvedConversations.length,
        pending_conversations: pendingConversations.length,
        resolution_percentage: resolutionPercentage,
        assessment_method: 'corrected_bot_filtering'
      },
      merge_readiness_score: Math.max(0, resolutionPercentage - 50),
      confidence: "high",
      error: false,
    };
  }

  // UTILITY: Add pattern to non-resolvable exclusions
  addNonResolvablePattern(pattern) {
    if (!this.commentFilterConfig.exclude.nonResolvablePatterns.includes(pattern)) {
      this.commentFilterConfig.exclude.nonResolvablePatterns.push(pattern);
      logger.info(`Added non-resolvable pattern: ${pattern}`);
    }
    return this.commentFilterConfig;
  }

  // UTILITY: Remove pattern from non-resolvable exclusions  
  removeNonResolvablePattern(pattern) {
    const index = this.commentFilterConfig.exclude.nonResolvablePatterns.indexOf(pattern);
    if (index > -1) {
      this.commentFilterConfig.exclude.nonResolvablePatterns.splice(index, 1);
      logger.info(`Removed non-resolvable pattern: ${pattern}`);
    }
    return this.commentFilterConfig;
  }

  // UTILITY: Get statistics about comment filtering
  getCommentFilteringStats(originalComments) {
    const stats = {
      total_comments: originalComments.length,
      resolvable_comments: 0,
      non_resolvable_comments: 0,
      bot_comments: 0,
      human_comments: 0,
      review_comments: 0,
      pr_comments: 0,
      filtered_out_patterns: []
    };

    originalComments.forEach(comment => {
      const authorType = this.determineAuthorType(comment);
      const commentType = this.determineCommentType(comment);
      const hasResolveCapability = this.commentHasResolveCapability(comment);
      const hasNonResolvableContent = this.hasNonResolvableContent(comment);

      if (authorType === 'BOT') {
        stats.bot_comments++;
      } else {
        stats.human_comments++;
      }

      if (commentType === 'REVIEW_COMMENT') {
        stats.review_comments++;
      } else if (commentType === 'PULL_REQUEST_COMMENT') {
        stats.pr_comments++;
      }

      if (hasResolveCapability && !hasNonResolvableContent && authorType !== 'BOT') {
        stats.resolvable_comments++;
      } else {
        stats.non_resolvable_comments++;

        if (hasNonResolvableContent) {
          const pattern = this.commentFilterConfig.exclude.nonResolvablePatterns.find(p =>
            comment.body?.toUpperCase().includes(p)
          );
          if (pattern && !stats.filtered_out_patterns.includes(pattern)) {
            stats.filtered_out_patterns.push(pattern);
          }
        }
      }
    });

    return stats;
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

  // NEW: Find which pattern matched for debugging
  findMatchingPattern(comment) {
    const body = comment.body?.toUpperCase() || '';

    return this.commentFilterConfig.exclude.nonResolvablePatterns.find(pattern =>
      body.includes(pattern.toUpperCase())
    ) || 'none';
  }

  // NEW: Enhanced debugging for comment filtering
  logFilteringDebugInfo(originalComments, resolvableComments) {
    const stats = {
      total: originalComments.length,
      resolvable: resolvableComments.length,
      excluded: originalComments.length - resolvableComments.length,
      byType: {},
      byAuthor: {},
      excludedPatterns: []
    };

    originalComments.forEach(comment => {
      const authorLogin = comment.user?.login || 'unknown';
      const commentType = this.determineCommentType(comment);

      // Count by type
      stats.byType[commentType] = (stats.byType[commentType] || 0) + 1;

      // Count by author
      stats.byAuthor[authorLogin] = (stats.byAuthor[authorLogin] || 0) + 1;

      // Track excluded patterns
      if (this.hasNonResolvableContent(comment)) {
        const pattern = this.findMatchingPattern(comment);
        if (!stats.excludedPatterns.includes(pattern)) {
          stats.excludedPatterns.push(pattern);
        }
      }
    });

    logger.info(`CORRECTED Comment filtering debug info:`, stats);

    // Log specific examples
    resolvableComments.forEach((comment, index) => {
      if (index < 3) { // Log first 3 for debugging
        logger.debug(`Resolvable comment example #${index + 1}:`, {
          id: comment.id,
          author: comment.user?.login,
          type: this.determineCommentType(comment),
          hasPath: !!comment.path,
          hasLine: !!(comment.line || comment.original_line),
          bodyStart: comment.body?.substring(0, 100) + "..."
        });
      }
    });
  }

  // CRITICAL FIX: Check ACTUAL resolved status using GitHub's resolution data
  checkActualResolvedConversations(filteredComments) {
    if (filteredComments.length === 0) {
      logger.info('No resolvable comments found for merge assessment');
      return {
        totalConversations: 0,
        resolvedConversations: 0,
        unresolvedCount: 0,
        unresolvedConversations: [],
        allResolved: true,
        resolutionPercentage: 100
      };
    }

    const conversationThreads = this.groupCommentsIntoConversations(filteredComments);

    let totalConversations = 0;
    let resolvedConversations = 0;
    let unresolvedConversations = [];

    Object.entries(conversationThreads).forEach(([threadId, comments]) => {
      totalConversations++;

      // FIXED: Check GitHub's ACTUAL resolution status
      const threadStatus = this.checkGitHubConversationResolution(comments);

      logger.debug(`Thread ${threadId} analysis:`, {
        threadId,
        commentCount: comments.length,
        isResolved: threadStatus.isResolved,
        hasGitHubResolution: threadStatus.hasGitHubResolution,
        reason: threadStatus.reason
      });

      if (threadStatus.isResolved) {
        resolvedConversations++;
      } else {
        unresolvedConversations.push({
          threadId,
          comments: comments.length,
          lastComment: comments[comments.length - 1],
          status: 'unresolved',
          reason: threadStatus.reason || 'Conversation not resolved using "Resolve conversation" button'
        });
      }
    });

    const result = {
      totalConversations,
      resolvedConversations,
      unresolvedCount: unresolvedConversations.length,
      unresolvedConversations,
      allResolved: unresolvedConversations.length === 0,
      resolutionPercentage: totalConversations > 0 ?
        Math.round((resolvedConversations / totalConversations) * 100) : 100
    };

    logger.info('FIXED Conversation resolution summary:', result);
    return result;
  }

  // CRITICAL FIX: Check GitHub's ACTUAL conversation resolution status
  checkGitHubConversationResolution(comments) {
    if (comments.length === 0) {
      return {
        isResolved: true,
        reason: 'Empty thread',
        hasGitHubResolution: false
      };
    }

    // PRIORITY 1: Check GitHub's native resolved conversation status
    // This is the ONLY reliable way to know if "Resolve conversation" was clicked
    const hasGitHubResolution = comments.some(comment => {
      return (
        comment.resolved === true ||
        comment.conversation_resolved === true ||
        comment.state === 'resolved' ||
        comment.conversation?.resolved === true ||
        // Check if the comment object has resolution metadata
        (comment.resolvable !== undefined && comment.resolved !== undefined && comment.resolved === true)
      );
    });

    if (hasGitHubResolution) {
      return {
        isResolved: true,
        reason: 'GitHub resolved conversation (Resolve conversation button clicked)',
        hasGitHubResolution: true
      };
    }

    // PRIORITY 2: If no GitHub resolution data, the conversation is NOT resolved
    // This fixes the main issue - we should not guess based on keywords
    return {
      isResolved: false,
      reason: 'Conversation not resolved - "Resolve conversation" button not clicked',
      hasGitHubResolution: false
    };
  }

  // FIXED: Determine merge readiness based ONLY on actual GitHub resolution status
  determineMergeReadinessFromActualResolved(resolvedStatus, prData) {
    const { allResolved, unresolvedConversations, totalConversations, resolutionPercentage } = resolvedStatus;

    // SCENARIO 1: All resolvable conversations resolved OR no resolvable conversations
    if (allResolved) {
      if (totalConversations === 0) {
        logger.info(`✅ READY FOR MERGE - No resolvable review conversations found`);
        return {
          status: "READY_FOR_MERGE",
          reason: "No reviewer conversations require resolution.",
          recommendation: "This PR is ready for merge. No review conversations require resolution.",
          outstanding_issues: [],
          conversation_analysis: {
            total_conversations: totalConversations,
            resolved_conversations: resolvedStatus.resolvedConversations,
            unresolved_conversations: 0,
            resolution_percentage: resolutionPercentage,
            assessment_method: 'github_resolution_status'
          },
          merge_readiness_score: 100,
          confidence: "high",
          error: false,
        };
      } else {
        logger.info(`✅ READY FOR MERGE - All ${totalConversations} conversations resolved via GitHub`);
        return {
          status: "READY_FOR_MERGE",
          reason: `All ${totalConversations} reviewer conversations have been resolved using GitHub's 'Resolve conversation' button.`,
          recommendation: "This PR is ready for merge. All reviewer feedback has been properly resolved.",
          outstanding_issues: [],
          conversation_analysis: {
            total_conversations: totalConversations,
            resolved_conversations: resolvedStatus.resolvedConversations,
            unresolved_conversations: 0,
            resolution_percentage: resolutionPercentage,
            assessment_method: 'github_resolution_status'
          },
          merge_readiness_score: 100,
          confidence: "high",
          error: false,
        };
      }
    }

    // SCENARIO 2: Unresolved conversations exist - NOT READY
    const totalUnresolved = unresolvedConversations.length;
    logger.info(`❌ NOT READY - ${totalUnresolved} conversations require resolution`);

    return {
      status: "NOT_READY_FOR_MERGE",
      reason: `${totalUnresolved} reviewer conversations require resolution. Click 'Resolve conversation' for each after addressing the feedback.`,
      recommendation: `Address the feedback in ${totalUnresolved} conversation(s) and click 'Resolve conversation' for each. This includes review comments from AI bots like 'your-ai-code-reviewer'.`,
      outstanding_issues: unresolvedConversations.map(conv => ({
        type: "UNRESOLVED_CONVERSATION",
        severity: "MAJOR",
        description: `Review conversation requires GitHub resolution: ${conv.threadId}`,
        last_comment_preview: conv.lastComment.body?.substring(0, 200) + "...",
        author: conv.lastComment.user?.login,
        created_at: conv.lastComment.created_at,
        resolution_required: true,
        instructions: "Click 'Resolve conversation' button after addressing this feedback"
      })),
      conversation_analysis: {
        total_conversations: totalConversations,
        resolved_conversations: resolvedStatus.resolvedConversations,
        unresolved_conversations: unresolvedConversations.length,
        resolution_percentage: resolutionPercentage,
        assessment_method: 'github_resolution_status'
      },
      merge_readiness_score: Math.max(0, resolutionPercentage - 50),
      confidence: "high",
      error: false,
    };
  }

  // UTILITY: Add debugging method to check what comments are being processed
  debugCommentFiltering(comments) {
    logger.info('=== COMMENT FILTERING DEBUG ===');

    comments.forEach((comment, index) => {
      const authorLogin = comment.user?.login || 'unknown';
      const isLineSpecific = this.isLineSpecificReviewComment(comment);
      const isThreaded = this.isThreadedConversationComment(comment);
      const hasNonResolvableContent = this.hasNonResolvableContent(comment);
      const isExcludedBot = this.isExcludedBot(comment);

      logger.debug(`Comment #${index + 1}:`, {
        id: comment.id,
        author: authorLogin,
        isLineSpecific,
        isThreaded,
        hasNonResolvableContent,
        isExcludedBot,
        path: comment.path || null,
        line: comment.line || comment.original_line || null,
        inReplyTo: comment.in_reply_to_id || null,
        bodyPreview: comment.body?.substring(0, 100) + "...",
        willBeIncluded: (isLineSpecific || isThreaded) && !hasNonResolvableContent && !isExcludedBot
      });
    });

    logger.info('=== END COMMENT FILTERING DEBUG ===');
  }

  // UTILITY: Test GraphQL connection
async testGraphQLConnection() {
  try {
    const githubToken = process.env.GITHUB_TOKEN || config.github?.token;
    
    if (!githubToken) {
      throw new Error('GITHUB_TOKEN not found');
    }

    const { graphql } = require("@octokit/graphql");
    const graphqlWithAuth = graphql.defaults({
      headers: {
        authorization: `token ${githubToken}`,
      },
    });

    // Simple test query
    const result = await graphqlWithAuth(`
      query {
        viewer {
          login
        }
      }
    `);

    logger.info('GraphQL connection test successful:', result.viewer);
    return { success: true, user: result.viewer.login };
  } catch (error) {
    logger.error('GraphQL connection test failed:', error);
    return { success: false, error: error.message };
  }
}

// UTILITY: Get detailed review thread information for debugging
async getDetailedReviewThreads(owner, repo, pullNumber) {
  try {
    const githubToken = process.env.GITHUB_TOKEN || config.github?.token;
    const { graphql } = require("@octokit/graphql");
    
    const graphqlWithAuth = graphql.defaults({
      headers: {
        authorization: `token ${githubToken}`,
      },
    });

    const query = `
      query($owner: String!, $repo: String!, $pullNumber: Int!) {
        repository(owner: $owner, name: $repo) {
          pullRequest(number: $pullNumber) {
            title
            author {
              login
            }
            reviewThreads(first: 100) {
              totalCount
              nodes {
                id
                isResolved
                isCollapsed
                resolvedBy {
                  login
                }
                comments(first: 50) {
                  totalCount
                  nodes {
                    id
                    body
                    author {
                      login
                    }
                    authorAssociation
                    createdAt
                    updatedAt
                    path
                    line
                    originalLine
                    outdated
                    state
                  }
                }
              }
            }
          }
        }
      }
    `;

    const result = await graphqlWithAuth(query, {
      owner,
      repo,
      pullNumber: parseInt(pullNumber)
    });

    return {
      pr: result.repository.pullRequest,
      threads: result.repository.pullRequest.reviewThreads
    };
  } catch (error) {
    logger.error('Error getting detailed review threads:', error);
    throw error;
  }
}

// UTILITY: Log comprehensive merge readiness debug info
logMergeReadinessDebug(resolvedStatus, prData) {
  logger.info('=== MERGE READINESS DEBUG INFO ===');
  logger.info('PR Info:', {
    number: prData.pr?.number,
    repository: prData.pr?.repository,
    title: prData.pr?.title?.substring(0, 100)
  });
  
  logger.info('Resolution Status:', resolvedStatus);
  
  if (resolvedStatus.unresolvedConversations?.length > 0) {
    logger.info('Unresolved Conversations Details:');
    resolvedStatus.unresolvedConversations.forEach((conv, index) => {
      logger.info(`  ${index + 1}. Thread ${conv.threadId}:`, {
        author: conv.firstComment?.author,
        path: conv.firstComment?.path,
        line: conv.firstComment?.line,
        bodyPreview: conv.firstComment?.body?.substring(0, 150) + "..."
      });
    });
  }
  
  logger.info('=== END MERGE READINESS DEBUG ===');
}

// OVERRIDE: Update the main method to include debug logging
async assessMergeReadiness(prData, aiFindings, reviewComments, currentStatus) {
  try {
    logger.info(`Assessing merge readiness for PR #${prData.pr?.number} - Using GraphQL API`, {
      totalComments: reviewComments?.length || 0,
    });

    // Extract owner, repo, and PR number
    const repository = prData.pr?.repository || '';
    const [owner, repo] = repository.split('/');
    const pullNumber = prData.pr?.number;

    if (!owner || !repo || !pullNumber) {
      throw new Error(`Invalid PR data: owner=${owner}, repo=${repo}, pullNumber=${pullNumber}`);
    }

    // STEP 1: Test GraphQL connection first
    const connectionTest = await this.testGraphQLConnection();
    if (!connectionTest.success) {
      throw new Error(`GraphQL connection failed: ${connectionTest.error}`);
    }
    
    logger.info('GraphQL connection verified successfully');

    // STEP 2: Use GraphQL to get actual conversation resolution status
    const reviewThreads = await this.getReviewThreadsViaGraphQL(owner, repo, pullNumber);

    logger.info(`Fetched ${reviewThreads.length} review threads via GraphQL`, {
      owner,
      repo,
      pullNumber
    });

    // STEP 3: Analyze actual resolved status using GraphQL data
    const resolvedStatus = this.analyzeGraphQLReviewThreads(reviewThreads);

    // STEP 4: Log debug information
    this.logMergeReadinessDebug(resolvedStatus, prData);

    // STEP 5: Determine merge readiness based on ACTUAL resolution status
    const result = this.determineMergeReadinessFromGraphQL(resolvedStatus, prData);
    
    logger.info(`Final merge readiness decision: ${result.status}`, {
      score: result.merge_readiness_score,
      totalConversations: resolvedStatus.totalConversations,
      resolvedConversations: resolvedStatus.resolvedConversations
    });

    return result;

  } catch (error) {
    logger.error("Critical error assessing merge readiness:", error);
    return this.createErrorMergeAssessment(`Critical Error: ${error.message}`);
  }
}
}

module.exports = new AIService();