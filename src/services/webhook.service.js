// src/services/webhook.service.js - Updated for Single Comment Output

const githubService = require('./github.service');
const aiService = require('./ai.service');
const logger = require('../utils/logger');
const { delay, generateTrackingId } = require('../utils/helpers');

class WebhookService {
  constructor() {
    this.processingQueue = new Map();
    this.maxConcurrentReviews = 3; // Reduced for stability
    this.activeReviews = 0;
  }

  // Main webhook handler
  async handleWebhook(event, payload) {
    try {
      logger.info(`Processing webhook event: ${event}`, {
        action: payload.action,
        repository: payload.repository?.full_name,
        pullRequest: payload.pull_request?.number,
      });

      // Validate payload
      this.validateWebhookPayload(payload, event);

      switch (event) {
        case 'pull_request':
          await this.handlePullRequestEvent(payload);
          break;
        case 'pull_request_review':
          await this.handlePullRequestReviewEvent(payload);
          break;
        case 'pull_request_review_comment':
          await this.handlePullRequestReviewCommentEvent(payload);
          break;
        case 'ping':
          logger.info('Webhook ping received - GitHub App is connected');
          break;
        default:
          logger.info(`Ignoring event: ${event}`);
      }
    } catch (error) {
      logger.error('Error handling webhook:', error);
      throw error;
    }
  }

  // Handle pull request events
  async handlePullRequestEvent(payload) {
    const { action, pull_request, repository } = payload;
    
    // Only process relevant actions
    const relevantActions = ['opened', 'reopened', 'synchronize'];
    if (!relevantActions.includes(action)) {
      logger.info(`Ignoring PR action: ${action}`);
      return;
    }

    // Skip draft PRs
    if (pull_request.draft) {
      logger.info(`Ignoring draft PR #${pull_request.number}`);
      return;
    }

    // Check if target branch is monitored
    if (!githubService.isTargetBranch(pull_request.base.ref)) {
      logger.info(`Ignoring PR to non-target branch: ${pull_request.base.ref}`);
      return;
    }

    // Check concurrent review limit
    if (this.activeReviews >= this.maxConcurrentReviews) {
      logger.warn(`Max concurrent reviews reached. Queuing PR #${pull_request.number}`);
      await delay(30000);
    }

    // Prevent duplicate processing
    const prKey = `${repository.full_name}#${pull_request.number}`;
    if (this.processingQueue.has(prKey)) {
      logger.info(`PR ${prKey} already being processed`);
      return;
    }

    const trackingId = generateTrackingId();
    this.processingQueue.set(prKey, { 
      startTime: Date.now(), 
      trackingId,
      action 
    });

    try {
      this.activeReviews++;
      await this.processCodeReview(repository, pull_request, false, trackingId);
    } finally {
      this.processingQueue.delete(prKey);
      this.activeReviews--;
    }
  }

  // Handle pull request review events (for re-analysis)
  async handlePullRequestReviewEvent(payload) {
    const { action, review, pull_request, repository } = payload;
    
    if (action === 'submitted' && review.state === 'commented') {
      logger.info(`New review submitted for PR #${pull_request.number} by ${review.user.login}`);
      
      // Don't re-analyze our own AI reviews
      if (review.user.type === 'Bot') {
        return;
      }
      
      // Wait for potential additional comments
      await delay(60000); // 1 minute delay
      
      // Re-analyze with new review context
      const trackingId = generateTrackingId();
      await this.processCodeReview(repository, pull_request, true, trackingId);
    }
  }

  // Handle review comment events (for re-analysis)
  async handlePullRequestReviewCommentEvent(payload) {
    const { action, comment, pull_request, repository } = payload;
    
    if (action === 'created' && comment.user.type !== 'Bot') {
      logger.info(`New review comment on PR #${pull_request.number}`);
      
      // Trigger re-analysis after delay
      setTimeout(async () => {
        const trackingId = generateTrackingId();
        await this.processCodeReview(repository, pull_request, true, trackingId);
      }, 120000); // 2 minute delay
    }
  }

  // Main code review processing
  async processCodeReview(repository, pullRequest, isReAnalysis = false, trackingId) {
    const owner = repository.owner.login;
    const repo = repository.name;
    const pullNumber = pullRequest.number;

    try {
      logger.info(`${isReAnalysis ? 'Re-analyzing' : 'Analyzing'} PR ${owner}/${repo}#${pullNumber}`, {
        trackingId,
        author: pullRequest.user.login,
        title: pullRequest.title,
      });

      // Step 1: Fetch PR data
      const prData = await githubService.getPullRequestData(owner, repo, pullNumber);
      
      if (!prData.files || prData.files.length === 0) {
        logger.info('No relevant files to analyze', { trackingId });
        
        // Post a simple no-analysis comment
        await githubService.postStructuredReviewComment(
          owner,
          repo,
          pullNumber,
          this.createNoAnalysisResponse(prData, trackingId)
        );
        return;
      }

      // Step 2: Post analysis start notification (only for new analysis)
      if (!isReAnalysis) {
        await githubService.postGeneralComment(
          owner,
          repo,
          pullNumber,
          `🤖 **AI Code Review Started** - Analyzing ${prData.files.length} files using SonarQube standards... *(Analysis ID: \`${trackingId}\`)*`
        );
      }

      // Step 3: Perform AI Analysis
      const startTime = Date.now();
      const analysis = await aiService.analyzePullRequest(prData, prData.comments);
      const analysisTime = Date.now() - startTime;

      logger.info(`Analysis completed in ${analysisTime}ms`, {
        trackingId,
        issuesFound: analysis.automatedAnalysis.totalIssues,
        assessment: analysis.reviewAssessment,
      });

      // Step 4: Post SINGLE structured comment
      await this.postSingleStructuredComment(owner, repo, pullNumber, analysis, isReAnalysis, trackingId);

      logger.info(`Code review completed for PR #${pullNumber}`, {
        trackingId,
        processingTime: analysisTime,
        assessment: analysis.reviewAssessment,
      });

    } catch (error) {
      logger.error(`Error processing code review for PR #${pullNumber}:`, error, { trackingId });
      
      // Post single error comment
      await this.postErrorComment(owner, repo, pullNumber, error, trackingId);
    }
  }

  // Post single structured comment (main output)
  async postSingleStructuredComment(owner, repo, pullNumber, analysis, isReAnalysis, trackingId) {
    try {
      // Remove the initial "analysis started" comment if this is the first analysis
      if (!isReAnalysis) {
        // Delete the "analysis started" comment to keep PR clean
        // Note: We could implement comment deletion here if needed
      }

      // Post the main structured review comment
      await githubService.postStructuredReviewComment(
        owner,
        repo,
        pullNumber,
        analysis
      );

      logger.info(`Single structured comment posted for PR #${pullNumber}`, { trackingId });
      
    } catch (error) {
      logger.error('Error posting structured comment:', error, { trackingId });
      throw error;
    }
  }

  // Create response for PRs with no code to analyze
  createNoAnalysisResponse(prData, trackingId) {
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
        totalIssues: 0,
        severityBreakdown: {
          blocker: 0,
          critical: 0,
          major: 0,
          minor: 0,
          info: 0
        },
        categories: {
          bugs: 0,
          vulnerabilities: 0,
          securityHotspots: 0,
          codeSmells: 0
        },
        technicalDebtMinutes: 0
      },
      humanReviewAnalysis: {
        reviewComments: prData.comments.length,
        issuesAddressedByReviewers: 0,
        securityIssuesCaught: 0,
        codeQualityIssuesCaught: 0
      },
      reviewAssessment: 'REVIEW REQUIRED',
      detailedFindings: [],
      recommendation: 'No code files found to analyze. This PR may contain only documentation or configuration changes. Human review recommended for content validation.'
    };
  }

  // Post error comment in structured format
  async postErrorComment(owner, repo, pullNumber, error, trackingId) {
    const errorAnalysis = {
      prInfo: {
        prId: pullNumber,
        title: 'Error in AI Analysis',
        repository: `${owner}/${repo}`,
        author: 'system',
        reviewers: [],
        url: `https://github.com/${owner}/${repo}/pull/${pullNumber}`,
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
        technicalDebtMinutes: 0
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
        issue: `AI analysis failed: ${error.message}`,
        severity: 'MAJOR',
        category: 'CODE_SMELL',
        suggestion: 'Please contact administrator or try again later'
      }],
      recommendation: `AI analysis encountered an error. Manual code review is required. Error: ${error.message} (Tracking ID: ${trackingId})`
    };

    await githubService.postStructuredReviewComment(owner, repo, pullNumber, errorAnalysis);
  }

  // Validate webhook payload
  validateWebhookPayload(payload, event) {
    if (!payload) {
      throw new Error('Empty webhook payload');
    }

    if (event === 'pull_request' && !payload.pull_request) {
      throw new Error('Invalid pull request payload');
    }

    if (event === 'pull_request_review' && !payload.review) {
      throw new Error('Invalid pull request review payload');
    }

    if (event === 'pull_request_review_comment' && !payload.comment) {
      throw new Error('Invalid pull request review comment payload');
    }

    if (!payload.repository) {
      throw new Error('Missing repository information in payload');
    }

    return true;
  }

  // Get processing queue status
  getProcessingStatus() {
    const queueEntries = Array.from(this.processingQueue.entries()).map(([key, value]) => ({
      prKey: key,
      startTime: value.startTime,
      trackingId: value.trackingId,
      action: value.action,
      duration: Date.now() - value.startTime,
    }));

    return {
      activeReviews: this.activeReviews,
      queueSize: this.processingQueue.size,
      maxConcurrent: this.maxConcurrentReviews,
      currentQueue: queueEntries,
    };
  }

  // Clean old processing entries
  cleanProcessingQueue() {
    const now = Date.now();
    const maxAge = 15 * 60 * 1000; // 15 minutes
    let cleaned = 0;
    
    for (const [key, value] of this.processingQueue.entries()) {
      if (now - value.startTime > maxAge) {
        this.processingQueue.delete(key);
        cleaned++;
        logger.info(`Cleaned stale processing entry: ${key}`, {
          trackingId: value.trackingId,
        });
      }
    }
    
    if (cleaned > 0) {
      logger.info(`Cleaned ${cleaned} stale processing entries`);
    }
  }

  // Graceful shutdown
  async shutdown() {
    logger.info('Shutting down webhook service...');
    
    const maxWaitTime = 30000; // 30 seconds
    const startTime = Date.now();
    
    while (this.activeReviews > 0 && (Date.now() - startTime) < maxWaitTime) {
      logger.info(`Waiting for ${this.activeReviews} active reviews to complete...`);
      await delay(1000);
    }
    
    if (this.activeReviews > 0) {
      logger.warn(`Force shutdown with ${this.activeReviews} reviews still active`);
    } else {
      logger.info('All reviews completed, shutdown complete');
    }
  }
}

// Initialize cleanup interval
const webhookService = new WebhookService();
setInterval(() => {
  webhookService.cleanProcessingQueue();
}, 5 * 60 * 1000); // Clean every 5 minutes

module.exports = webhookService;