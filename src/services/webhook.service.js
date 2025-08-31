const githubService = require('./github.service');
const aiService = require('./ai.service');
const logger = require('../utils/logger');
const { delay, generateTrackingId } = require('../utils/helpers');

class WebhookService {
  constructor() {
    this.processingQueue = new Map();
    this.maxConcurrentReviews = 3;
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

      this.validateWebhookPayload(payload, event);

      switch (event) {
        case 'pull_request':
          await this.handlePullRequestEvent(payload);
          break;
        case 'check_run':
          await this.handleCheckRunEvent(payload);
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

  // Handle PR events - only create button, no analysis
  async handlePullRequestEvent(payload) {
    const { action, pull_request, repository } = payload;
    
    const relevantActions = ['opened', 'reopened', 'synchronize'];
    if (!relevantActions.includes(action)) {
      logger.info(`Ignoring PR action: ${action}`);
      return;
    }

    if (pull_request.draft) {
      logger.info(`Ignoring draft PR #${pull_request.number}`);
      return;
    }

    if (!githubService.isTargetBranch(pull_request.base.ref)) {
      logger.info(`Ignoring PR to non-target branch: ${pull_request.base.ref}`);
      return;
    }

    await this.createAIReviewButton(repository, pull_request);
  }

  // Create AI Review button
  async createAIReviewButton(repository, pullRequest) {
    const owner = repository.owner.login;
    const repo = repository.name;
    const headSha = pullRequest.head.sha;

    try {
      logger.info(`Creating AI Review button for PR #${pullRequest.number}`);

      const checkRun = await githubService.createCheckRun(owner, repo, {
        name: 'AI Code Review',
        head_sha: headSha,
        status: 'queued',
        output: {
          title: 'AI Code Review Available',
          summary: `Click "AI Review" to analyze this PR with SonarQube standards.\n\n**Files to analyze:** ${pullRequest.changed_files}\n**Lines changed:** +${pullRequest.additions} -${pullRequest.deletions}`,
        },
        actions: [{
          label: 'AI Review',
          description: 'Analyze code changes with AI using SonarQube standards',
          identifier: 'ai_review'
        }]
      });

      logger.info(`AI Review button created: ${checkRun.id}`);
    } catch (error) {
      logger.error('Error creating AI Review button:', error);
      
      // Fallback: Post instruction comment
      await githubService.postGeneralComment(
        owner,
        repo,
        pullRequest.number,
        `🤖 **AI Code Review Available**\n\n` +
        `Manual trigger available. Contact administrator to enable button interface.\n\n` +
        `**Files to analyze:** ${pullRequest.changed_files}\n` +
        `**Lines changed:** +${pullRequest.additions} -${pullRequest.deletions}`
      );
    }
  }

  // Handle button clicks
  async handleCheckRunEvent(payload) {
    const { action, check_run, repository } = payload;

    if (action === 'requested_action' && check_run.name === 'AI Code Review') {
      const requestedAction = payload.requested_action;
      
      if (requestedAction.identifier === 'ai_review') {
        logger.info(`AI Review requested via button for check run ${check_run.id}`);
        
        const pullRequests = check_run.pull_requests;
        if (pullRequests && pullRequests.length > 0) {
          const pr = pullRequests[0];
          await this.triggerAIReview(repository, pr, check_run);
        }
      }
    }
  }

  // Trigger AI review
  async triggerAIReview(repository, pullRequest, checkRun) {
    const owner = repository.owner.login;
    const repo = repository.name;
    const pullNumber = pullRequest.number;
    const trackingId = generateTrackingId();

    // Check concurrent review limit
    if (this.activeReviews >= this.maxConcurrentReviews) {
      await githubService.updateCheckRun(owner, repo, checkRun.id, {
        status: 'queued',
        output: {
          title: 'AI Review Queued',
          summary: `Analysis queued due to high demand. Currently processing ${this.activeReviews} reviews.\n\nPlease wait and try again in a few minutes.`,
        }
      });
      return;
    }

    // Prevent duplicate processing
    const prKey = `${repository.full_name}#${pullNumber}`;
    if (this.processingQueue.has(prKey)) {
      logger.info(`PR ${prKey} already being processed`);
      return;
    }

    this.processingQueue.set(prKey, { 
      startTime: Date.now(), 
      trackingId, 
      checkRunId: checkRun.id 
    });

    try {
      this.activeReviews++;
      await this.processAIReview(repository, pullRequest, checkRun, trackingId);
    } finally {
      this.processingQueue.delete(prKey);
      this.activeReviews--;
    }
  }

  // Process AI review with progress updates
  async processAIReview(repository, pullRequest, checkRun, trackingId) {
    const owner = repository.owner.login;
    const repo = repository.name;
    const pullNumber = pullRequest.number;

    try {
      logger.info(`Starting AI review for PR ${owner}/${repo}#${pullNumber}`, { trackingId });

      // Progress 1: Starting analysis
      await githubService.updateCheckRun(owner, repo, checkRun.id, {
        status: 'in_progress',
        output: {
          title: 'AI Review In Progress',
          summary: `🔄 Starting code analysis...\n\n**Status:** Initializing\n**Analysis ID:** \`${trackingId}\``,
        }
      });

      // Progress 2: Fetching data
      await githubService.updateCheckRun(owner, repo, checkRun.id, {
        status: 'in_progress',
        output: {
          title: 'AI Review In Progress',
          summary: `🔄 Fetching PR data and code changes...\n\n**Status:** Fetching data\n**Analysis ID:** \`${trackingId}\``,
        }
      });

      const prData = await githubService.getPullRequestData(owner, repo, pullNumber);
      
      if (!prData.files || prData.files.length === 0) {
        await this.completeWithNoFiles(owner, repo, pullNumber, checkRun, prData, trackingId);
        return;
      }

      // Progress 3: AI Analysis
      await githubService.updateCheckRun(owner, repo, checkRun.id, {
        status: 'in_progress',
        output: {
          title: 'AI Review In Progress',
          summary: `🧠 Analyzing ${prData.files.length} files with AI using SonarQube standards...\n\n**Status:** AI processing\n**Analysis ID:** \`${trackingId}\`\n\n*This may take 1-2 minutes depending on code complexity...*`,
        }
      });

      const startTime = Date.now();
      const analysis = await aiService.analyzePullRequest(prData, prData.comments);
      const analysisTime = Date.now() - startTime;

      logger.info(`AI analysis completed in ${analysisTime}ms`, {
        trackingId,
        issuesFound: analysis.automatedAnalysis.totalIssues,
        assessment: analysis.reviewAssessment,
      });

      // Complete with results
      await this.completeWithResults(owner, repo, pullNumber, checkRun, analysis, trackingId);

    } catch (error) {
      logger.error(`Error in AI review for PR #${pullNumber}:`, error, { trackingId });
      await this.completeWithError(owner, repo, pullNumber, checkRun, error, trackingId);
    }
  }

  // Complete with successful results
  async completeWithResults(owner, repo, pullNumber, checkRun, analysis, trackingId) {
    try {
      // Post structured comment (only on success)
      await githubService.postStructuredReviewComment(owner, repo, pullNumber, analysis);

      // Determine check run conclusion
      const hasCriticalIssues = analysis.automatedAnalysis.severityBreakdown.critical > 0;
      const hasBlockerIssues = analysis.automatedAnalysis.severityBreakdown.blocker > 0;
      
      let conclusion = 'success';
      if (hasBlockerIssues) {
        conclusion = 'failure';
      } else if (hasCriticalIssues) {
        conclusion = 'neutral';
      } else if (analysis.reviewAssessment === 'PROPERLY REVIEWED') {
        conclusion = 'success';
      } else {
        conclusion = 'neutral';
      }

      // Update check run to completed
      await githubService.updateCheckRun(owner, repo, checkRun.id, {
        status: 'completed',
        conclusion: conclusion,
        output: {
          title: 'AI Code Review Completed',
          summary: `✅ Analysis completed successfully!\n\n**Issues Found:** ${analysis.automatedAnalysis.totalIssues}\n**Critical:** ${analysis.automatedAnalysis.severityBreakdown.critical}\n**Assessment:** ${analysis.reviewAssessment}\n\n📋 See detailed analysis in PR comments below.`,
        }
      });

      logger.info(`AI review completed successfully for PR #${pullNumber}`, { trackingId });

    } catch (error) {
      logger.error('Error completing review with results:', error, { trackingId });
      throw error;
    }
  }

  // Complete with no files to analyze
  async completeWithNoFiles(owner, repo, pullNumber, checkRun, prData, trackingId) {
    try {
      // Create minimal analysis for no files
      const analysis = {
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
          severityBreakdown: { blocker: 0, critical: 0, major: 0, minor: 0, info: 0 },
          categories: { bugs: 0, vulnerabilities: 0, securityHotspots: 0, codeSmells: 0 },
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
        recommendation: 'No code files found to analyze. This PR contains only documentation or configuration changes. Human review recommended for content validation.'
      };

      // Post structured comment
      await githubService.postStructuredReviewComment(owner, repo, pullNumber, analysis);

      // Update check run
      await githubService.updateCheckRun(owner, repo, checkRun.id, {
        status: 'completed',
        conclusion: 'neutral',
        output: {
          title: 'AI Code Review Completed',
          summary: 'No code files found to analyze. This PR may contain only documentation or configuration changes.',
        }
      });

      logger.info(`AI review completed (no files) for PR #${pullNumber}`, { trackingId });

    } catch (error) {
      await this.completeWithError(owner, repo, pullNumber, checkRun, error, trackingId);
    }
  }

  // Complete with error - show "unable to complete" message
  async completeWithError(owner, repo, pullNumber, checkRun, error, trackingId) {
    try {
      // Post simple error message (NOT structured comment)
      await githubService.postGeneralComment(
        owner,
        repo,
        pullNumber,
        `🚨 **Unable to Complete AI Review**\n\n` +
        `The AI analysis encountered an error and could not be completed.\n\n` +
        `**Error:** ${error.message}\n` +
        `**Analysis ID:** \`${trackingId}\`\n` +
        `**Time:** ${new Date().toISOString()}\n\n` +
        `Please try clicking "AI Review" again or contact the administrator if this persists.`
      );

      // Update check run to failed
      await githubService.updateCheckRun(owner, repo, checkRun.id, {
        status: 'completed',
        conclusion: 'failure',
        output: {
          title: 'AI Code Review Failed',
          summary: `❌ Analysis failed: ${error.message}\n\nPlease try again or contact administrator.\n\n**Tracking ID:** ${trackingId}`,
        }
      });

      logger.error(`AI review failed for PR #${pullNumber}`, { trackingId, error: error.message });

    } catch (postError) {
      logger.error('Error posting failure message:', postError);
    }
  }

  // Validate webhook payload
  validateWebhookPayload(payload, event) {
    if (!payload) {
      throw new Error('Empty webhook payload');
    }

    if (event === 'pull_request' && !payload.pull_request) {
      throw new Error('Invalid pull request payload');
    }

    if (event === 'check_run' && !payload.check_run) {
      throw new Error('Invalid check run payload');
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
      checkRunId: value.checkRunId,
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