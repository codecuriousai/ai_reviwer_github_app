// src/services/webhook.service.js - Enhanced with Check Run Button Support

const githubService = require('./github.service');
const aiService = require('./ai.service');
const checkRunButtonService = require('./check-run-button.service');
const interactiveCommentService = require('./interactive-comment.service');
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
        checkRunId: payload.check_run?.id,
      });

      this.validateWebhookPayload(payload, event);

      switch (event) {
        case 'pull_request':
          await this.handlePullRequestEvent(payload);
          break;
        case 'check_run':
          await this.handleCheckRunEvent(payload);
          break;
        case 'issue_comment':
          await this.handleIssueCommentEvent(payload);
          break;
        case 'ping':
          logger.info('Webhook ping received - GitHub App is connected');
          break;
        default:
          logger.info(`Ignoring unknown event: ${event}`);
          break;
      }
    } catch (error) {
      logger.error('Error handling webhook event:', error);
    }
  }

  // Validate webhook payload for required fields
  validateWebhookPayload(payload, event) {
    if (event === 'pull_request' && (!payload.pull_request || !payload.repository)) {
      throw new Error('Invalid pull_request payload');
    }
    if (event === 'check_run' && (!payload.check_run || !payload.repository)) {
      throw new Error('Invalid check_run payload');
    }
    if (event === 'issue_comment' && (!payload.issue || !payload.repository || !payload.comment)) {
      throw new Error('Invalid issue_comment payload');
    }
  }

  // Handle pull_request event
  async handlePullRequestEvent(payload) {
    const { action, pull_request: pr, repository: repo } = payload;
    
    if (action === 'opened' || action === 'reopened' || action === 'synchronize') {
      const prKey = `${repo.full_name}#${pr.number}`;
      if (this.processingQueue.has(prKey)) {
        logger.info(`PR #${pr.number} is already in the processing queue. Ignoring.`, { trackingId: this.processingQueue.get(prKey).trackingId });
        return;
      }

      if (this.activeReviews >= this.maxConcurrentReviews) {
        logger.warn(`Max concurrent reviews (${this.maxConcurrentReviews}) reached. Adding PR #${pr.number} to queue.`);
        const trackingId = generateTrackingId();
        this.processingQueue.set(prKey, {
          owner: repo.owner.login,
          repo: repo.name,
          pullNumber: pr.number,
          headSha: pr.head.sha,
          startTime: Date.now(),
          trackingId
        });
        return;
      }
      
      const trackingId = generateTrackingId();
      await this.processPullRequest(repo.owner.login, repo.name, pr.number, pr.head.sha, trackingId);
    }
  }

  // Handle check_run event
  async handleCheckRunEvent(payload) {
    const { action, check_run: checkRun, repository: repo } = payload;
    if (action === 'rerequested' && checkRun.name === 'AI Code Review') {
      const pullNumber = checkRun.check_suite.pull_requests[0]?.number;
      if (pullNumber) {
        logger.info(`Re-requesting AI code review for PR #${pullNumber}`);
        await this.processPullRequest(repo.owner.login, repo.name, pullNumber, checkRun.head_sha);
      }
    } else if (action === 'requested_action' && checkRun.name === 'AI Code Review') {
      await checkRunButtonService.handleButtonAction(payload);
    }
  }
  
  // NEW: Handle issue_comment event
  async handleIssueCommentEvent(payload) {
    const { action, issue, comment, repository: repo } = payload;
    
    // Only process new comments on pull requests
    if (action === 'created' && issue.pull_request) {
      const pullNumber = issue.number;
      const commentBody = comment.body;
      const owner = repo.owner.login;
      const repoName = repo.name;
      
      // Check if the comment is a known command
      if (commentBody.startsWith('/ai-comment') || 
          commentBody.startsWith('/ai-suggest') || 
          commentBody.startsWith('/ai-comment-all')) {
        logger.info(`Processing AI command: '${commentBody}' on PR #${pullNumber}`);
        await interactiveCommentService.handleCommand(owner, repoName, pullNumber, commentBody);
      } else {
        logger.info(`Ignoring non-command comment on PR #${pullNumber}`);
      }
    }
  }

  // Process a single pull request
  async processPullRequest(owner, repo, pullNumber, headSha, trackingId = generateTrackingId()) {
    this.activeReviews++;
    
    try {
      logger.info(`Starting AI code review for PR #${pullNumber}`, { trackingId });
      
      const pr = await githubService.getPullRequest(owner, repo, pullNumber);
      const prFiles = await githubService.getPullRequestFiles(owner, repo, pullNumber);
      const diff = await githubService.getDiff(owner, repo, pullNumber);
      
      const analysis = await aiService.analyzeCode({
        diff,
        title: pr.title,
        files: prFiles.map(f => ({
          filename: f.filename,
          patch: f.patch,
          additions: f.additions,
          deletions: f.deletions,
        })),
        pullRequestInfo: {
          title: pr.title,
          body: pr.body,
        },
      });

      // Store findings for interactive commenting
      interactiveCommentService.storePendingComments(owner, repo, pullNumber, analysis.detailedFindings, trackingId);

      // Create an interactive check run with buttons and summary
      await checkRunButtonService.createInteractiveCheckRun(owner, repo, pullNumber, analysis, headSha);

      logger.info(`AI code review for PR #${pullNumber} completed successfully.`, { trackingId });
    } catch (error) {
      logger.error(`Failed to complete AI review for PR #${pullNumber}:`, error, { trackingId });
      await githubService.updateCheckRun(owner, repo, null, {
        status: 'completed',
        conclusion: 'failure',
        output: {
          title: 'AI Code Review Failed',
          summary: `An error occurred during the AI code review: ${error.message}`,
        },
      });
    } finally {
      this.activeReviews--;
      this.processQueue();
    }
  }

  // Process next item in the queue
  async processQueue() {
    if (this.activeReviews < this.maxConcurrentReviews && this.processingQueue.size > 0) {
      const [prKey, prData] = this.processingQueue.entries().next().value;
      this.processingQueue.delete(prKey);
      logger.info(`Processing queued PR #${prData.pullNumber}`);
      await this.processPullRequest(prData.owner, prData.repo, prData.pullNumber, prData.headSha, prData.trackingId);
    }
  }

  // Clean stale entries in the processing queue
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
          pullNumber: value.pullNumber,
        });
      }
    }
    
    if (cleaned > 0) {
      logger.info(`Cleaned ${cleaned} stale processing entries`);
    }

    // Also clean old check run data
    checkRunButtonService.cleanOldCheckRuns();
  }

  // Graceful shutdown
  async shutdown() {
    logger.info('Shutting down gracefully...');
    
    const maxWaitTime = 30000; // 30 seconds
    const startTime = Date.now();
    
    while (this.activeReviews > 0 && (Date.now() - startTime) < maxWaitTime) {
      logger.info(`Waiting for ${this.activeReviews} active reviews to complete...`);
      await delay(1000);
    }
    
    if (this.activeReviews > 0) {
      logger.warn(`Force shutdown with ${this.activeReviews} reviews still active. Some reviews may not have completed.`);
    } else {
      logger.info('All active reviews completed.');
    }
    
    // No need to explicitly exit, the main process will handle it after this method resolves.
  }
}

module.exports = new WebhookService();
