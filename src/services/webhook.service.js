// src/services/webhook.service.js - Enhanced with Check Run Button Support

const githubService = require('./github.service');
const aiService = require('./ai.service');
const checkRunButtonService = require('./check-run-button.service');
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

  // Handle pull request events
  async handlePullRequestEvent(payload) {
    const { action, pull_request: pr, repository: repo } = payload;
    const trackingId = generateTrackingId();

    // Use a variable to hold the check run ID, so it's available in the catch block
    let checkRunId = null; 

    try {
      if (!pr) {
        logger.warn('Ignoring pull_request event without pull request data');
        return;
      }

      logger.info(`Handling PR event '${action}' for PR #${pr.number}`, { trackingId });

      if (action === 'opened' || action === 'reopened' || action === 'synchronize') {
        const pullNumber = pr.number;
        const owner = repo.owner.login;
        const repoName = repo.name;
        const headSha = pr.head.sha;

        if (this.isProcessing(owner, repoName, pullNumber)) {
          logger.warn('PR is already being processed, ignoring event.', { trackingId });
          return;
        }

        this.enqueueProcessing(owner, repoName, pullNumber, trackingId);

        // Create the initial check run and capture its ID
        const checkRun = await checkRunButtonService.createInteractiveCheckRun(owner, repoName, pullNumber, { summary: 'AI review in progress...' }, headSha);
        checkRunId = checkRun.id; // Store the ID for later use

        await this.processPullRequest(owner, repoName, pullNumber, pr.title, pr.body, headSha, checkRunId, trackingId);
      }
    } catch (error) {
      logger.error('Failed to complete AI review for PR #' + pr?.number, { trackingId, stack: error.stack });
      this.dequeueProcessing(repo.owner.login, repo.name, pr?.number);

      // Attempt to update the check run with a failure status
      if (checkRunId) {
        try {
          await githubService.updateCheckRun(repo.owner.login, repo.name, checkRunId, {
            status: 'completed',
            conclusion: 'failure',
            output: {
              title: 'AI Code Review Failed',
              summary: `An error occurred during the AI code review: ${error.message}`
            }
          });
        } catch (updateError) {
          logger.error('Error updating check run ' + checkRunId, updateError);
        }
      }
    }
  }

  // Handle check run button events
  async handleCheckRunEvent(payload) {
    const { action, check_run: checkRun, repository: repo, installation } = payload;
    const trackingId = checkRun.external_id;

    if (action === 'rerequested') {
      logger.info(`Handling rerequested check run`, { trackingId, checkRunId: checkRun.id });

      // We need to find the associated PR to re-trigger the review
      const prs = checkRun.pull_requests;
      if (!prs || prs.length === 0) {
        logger.warn('Check run rerequested but no associated PR found.', { trackingId });
        return;
      }
      const pullNumber = prs[0].number;
      const owner = repo.owner.login;
      const repoName = repo.name;
      const headSha = checkRun.head_sha;

      logger.info(`Re-triggering review for PR #${pullNumber}`, { trackingId });

      // Reset the check run to a pending state
      await githubService.updateCheckRun(owner, repoName, checkRun.id, {
        status: 'in_progress',
        output: {
          title: 'AI Code Review in Progress...',
          summary: 'Re-running AI review.'
        }
      });
      
      // Re-run the review process
      const prData = await githubService.getPullRequest(owner, repoName, pullNumber);
      await this.processPullRequest(owner, repoName, pullNumber, prData.title, prData.body, headSha, checkRun.id, trackingId);

    } else if (action === 'requested_action') {
      logger.info(`Handling check run requested_action: ${checkRun.id}`, { trackingId });
      // Delegate to the check run button service
      await checkRunButtonService.handleCheckRunAction(payload);
    }
  }

  // Handle issue comment events for manual commands
  async handleIssueCommentEvent(payload) {
    const { action, comment, issue, repository: repo } = payload;
    if (action !== 'created' || !issue.pull_request) {
      return;
    }

    const commentBody = comment.body.trim();
    const owner = repo.owner.login;
    const repoName = repo.name;
    const pullNumber = issue.number;

    if (commentBody.startsWith('/ai-review')) {
      logger.info(`Manual review command received for PR #${pullNumber}`, { command: commentBody });
      
      const pr = await githubService.getPullRequest(owner, repoName, pullNumber);
      
      // Create a temporary check run for the manual review and process the request
      const checkRun = await checkRunButtonService.createInteractiveCheckRun(owner, repoName, pullNumber, { summary: 'Manual AI review in progress...' }, pr.head.sha);
      const checkRunId = checkRun.id;

      await this.processPullRequest(owner, repoName, pullNumber, pr.title, pr.body, pr.head.sha, checkRunId, generateTrackingId());
    } else if (commentBody.startsWith('/ai-comment')) {
      // Delegate to the interactive comment service
      const parts = commentBody.split(' ');
      if (parts.length > 1) {
        const actionId = parts[1];
        await checkRunButtonService.handleCommentAction(owner, repoName, pullNumber, actionId);
      }
    }
  }
  
  // Validate required webhook payload properties
  validateWebhookPayload(payload, event) {
    const requiredProps = {
      pull_request: ['number', 'head'],
      repository: ['owner', 'name'],
    };

    if (event === 'pull_request' && payload.pull_request) {
      const pr = payload.pull_request;
      for (const prop of requiredProps.pull_request) {
        if (!pr[prop]) {
          throw new Error(`Invalid pull request payload: missing '${prop}'`);
        }
      }
      if (!pr.head.sha) {
        throw new Error('Invalid pull request payload: missing head.sha');
      }
    }
  }

  // Process the AI review for a pull request
  async processPullRequest(owner, repoName, pullNumber, prTitle, prBody, headSha, checkRunId, trackingId) {
    logger.info(`Starting AI review process for PR #${pullNumber}`, { trackingId });
    this.activeReviews++;

    try {
      // 1. Get PR files and diff
      const files = await githubService.getPullRequestFiles(owner, repoName, pullNumber);

      // 2. Prepare files for analysis
      const filesToAnalyze = await this.prepareFilesForAnalysis(owner, repoName, headSha, files);
      logger.info(`Prepared ${filesToAnalyze.length} files for analysis`, { trackingId });

      // 3. Get the latest code from the main branch for context
      const defaultBranch = (await githubService.getRepoInfo(owner, repoName)).default_branch;

      // 4. Get base branch file contents for diffs
      const baseFilesContent = await Promise.all(files.map(async (file) => {
        try {
          if (file.status === 'added') {
            return null;
          }
          const content = await githubService.getRepositoryContent(owner, repoName, file.filename, defaultBranch);
          return { file: file.filename, content: content ? Buffer.from(content.content, 'base64').toString('utf-8') : null };
        } catch (e) {
          logger.warn(`Could not get base content for file ${file.filename}, skipping`, { trackingId });
          return { file: file.filename, content: 'File not found in base branch.' };
        }
      }));

      // 5. Generate AI analysis
      // This is the correct call that fixes the `getDiff` error.
      const analysisResult = await aiService.analyzeCodeDiff(prTitle, prBody, filesToAnalyze, baseFilesContent);

      // 6. Store pending comments and update check run
      await checkRunButtonService.createInteractiveCheckRun(owner, repoName, pullNumber, analysisResult, headSha);
      
    } catch (error) {
      logger.error('Error during AI review process:', { trackingId, stack: error.stack });
      
      // Update the check run with the failure message
      try {
        await githubService.updateCheckRun(owner, repoName, checkRunId, {
          status: 'completed',
          conclusion: 'failure',
          output: {
            title: 'AI Code Review Failed',
            summary: `An error occurred during the AI code review: ${error.message}`
          }
        });
      } catch (updateError) {
        logger.error(`Error updating check run ${checkRunId}:`, updateError);
      }
      
    } finally {
      this.dequeueProcessing(owner, repoName, pullNumber);
      this.activeReviews--;
    }
  }

  // Prepare a list of files to be sent to the AI service
  async prepareFilesForAnalysis(owner, repoName, headSha, files) {
    return Promise.all(files.map(async file => {
      try {
        const content = await githubService.getRepositoryContent(owner, repoName, file.filename, headSha);
        if (content && content.content) {
          return {
            file: file.filename,
            patch: file.patch || 'No patch available',
            content: Buffer.from(content.content, 'base64').toString('utf-8')
          };
        }
        return null;
      } catch (e) {
        logger.warn(`Could not get content for file ${file.filename}, skipping`, { stack: e.stack });
        return {
          file: file.filename,
          patch: file.patch || 'No patch available',
          content: 'File not found or unreadable.'
        };
      }
    }));
  }

  // --- Processing Queue Management ---
  isProcessing(owner, repo, pullNumber) {
    const key = `${owner}/${repo}/${pullNumber}`;
    return this.processingQueue.has(key);
  }

  enqueueProcessing(owner, repo, pullNumber, trackingId) {
    const key = `${owner}/${repo}/${pullNumber}`;
    this.processingQueue.set(key, {
      startTime: Date.now(),
      trackingId,
      pullNumber
    });
    logger.info(`Enqueued review for PR #${pullNumber}`, { trackingId });
  }

  dequeueProcessing(owner, repo, pullNumber) {
    const key = `${owner}/${repo}/${pullNumber}`;
    this.processingQueue.delete(key);
    logger.info(`Dequeued review for PR #${pullNumber}`);
  }

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
      logger.warn(`Force shutdown with ${this.activeReviews} reviews still active. Some tasks may be incomplete.`);
    } else {
      logger.info('All active reviews completed.');
    }
  }
}

module.exports = new WebhookService();
