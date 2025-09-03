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
          logger.info(`Ignoring event: ${event}`);
      }
    } catch (error) {
      logger.error('Error handling webhook:', error);
      throw error;
    }
  }

  // Handle PR events - only create initial button, no analysis
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

    await this.createInitialAIReviewButton(repository, pull_request);
  }

  // Create initial AI Review button (before analysis)
  async createInitialAIReviewButton(repository, pullRequest) {
    const owner = repository.owner.login;
    const repo = repository.name;
    const headSha = pullRequest.head.sha;

    try {
      logger.info(`Creating initial AI Review button for PR #${pullRequest.number}`);

      const checkRun = await githubService.createCheckRun(owner, repo, {
        name: 'AI Code Review',
        head_sha: headSha,
        status: 'queued',
        output: {
          title: 'AI Code Review Available',
          summary: `Click "Start AI Review" to analyze this PR with SonarQube standards.\n\n**Files to analyze:** ${pullRequest.changed_files}\n**Lines changed:** +${pullRequest.additions} -${pullRequest.deletions}`,
        },
        actions: [{
          label: 'Start AI Review',
          description: 'Trigger code analysis for this PR', // Shortened to fit character limit
          identifier: 'ai_review'
        }]
      });

      logger.info(`Initial AI Review button created: ${checkRun.id} for PR #${pullRequest.number}`);
    } catch (error) {
      logger.error('Error creating AI Review button:', error);
      
      // Fallback: Post instruction comment
      await githubService.postGeneralComment(
        owner,
        repo,
        pullRequest.number,
        `**AI Code Review Available**\n\n` +
        `Click the "Start AI Review" button above or comment \`/ai-review\` to trigger analysis.\n\n` +
        `**Files to analyze:** ${pullRequest.changed_files}\n` +
        `**Lines changed:** +${pullRequest.additions} -${pullRequest.deletions}\n\n` +
        `*Analysis will create interactive buttons for posting AI findings directly to your code.*`
      );
    }
  }

  // ENHANCED: Handle check run button clicks (both initial AI review and comment posting)
  async handleCheckRunEvent(payload) {
    const { action, check_run, repository, requested_action } = payload;

    if (action === 'requested_action' && check_run.name === 'AI Code Review') {
      const actionId = requested_action.identifier;
      
      logger.info(`Check run action requested: ${actionId} for check run ${check_run.id}`);

      // Handle initial AI review trigger
      if (actionId === 'ai_review' || actionId === 'retry_review') {
        await this.handleInitialReviewRequest(payload);
        return;
      }

      // Handle interactive comment button clicks
      const handled = await checkRunButtonService.handleButtonAction(payload);
      if (handled) {
        logger.info(`Interactive button action handled: ${actionId}`);
        return;
      }

      logger.warn(`Unhandled check run action: ${actionId}`);
    }
  }

  // Handle the initial AI review request
  async handleInitialReviewRequest(payload) {
    const { check_run, repository } = payload;
    
    let targetPR = null;
    
    // Find associated PR
    if (check_run.pull_requests && check_run.pull_requests.length > 0) {
      targetPR = check_run.pull_requests[0];
      logger.info(`Found PR from pull_requests array: #${targetPR.number}`);
    } else {
      logger.info(`Searching for PR by commit SHA: ${check_run.head_sha}`);
      targetPR = await this.findPRByCommitSha(repository, check_run.head_sha);
    }
    
    if (targetPR) {
      logger.info(`Triggering AI review for PR #${targetPR.number}`);
      await this.triggerAIReviewWithButtons(repository, targetPR, check_run);
    } else {
      logger.error('Could not find associated PR for check run', { 
        checkRunId: check_run.id,
        headSha: check_run.head_sha 
      });
      
      await githubService.updateCheckRun(repository.owner.login, repository.name, check_run.id, {
        status: 'completed',
        conclusion: 'failure',
        output: {
          title: 'AI Review Failed',
          summary: 'Could not find the associated pull request for this check run.',
        }
      });
    }
  }

  // Handle issue comments (keeping /ai-review trigger as backup)
  async handleIssueCommentEvent(payload) {
    const { action, comment, issue, repository } = payload;
    
    // Only process created comments on pull requests
    if (action !== 'created' || !issue.pull_request) {
      return;
    }

    const commentBody = comment.body.toLowerCase();
    const author = comment.user.login;
    
    // Check for AI review triggers (backup method)
    const triggers = ['/ai-review'];
    const isAIReviewTrigger = triggers.some(trigger => commentBody.includes(trigger));

    if (comment.user.type === 'Bot') {
      return;
    }

    // Handle AI review triggers as backup
    if (isAIReviewTrigger) {
      logger.info(`AI review triggered by comment from ${author} on PR #${issue.number} (backup method)`);

      try {
        const owner = repository.owner.login;
        const repo = repository.name;
        
        const { data: pr } = await githubService.octokit.rest.pulls.get({
          owner,
          repo,
          pull_number: issue.number,
        });

        // Create initial check run and then trigger review
        const checkRun = await githubService.createCheckRun(owner, repo, {
          name: 'AI Code Review (Manual)',
          head_sha: pr.head.sha,
          status: 'queued',
          output: {
            title: 'AI Review Triggered by Comment',
            summary: `Analysis started by @${author}`,
          }
        });

        await this.triggerAIReviewWithButtons(repository, { number: issue.number }, checkRun);

      } catch (error) {
        logger.error('Error handling manual trigger:', error);
        await githubService.postGeneralComment(
          repository.owner.login,
          repository.name,
          issue.number,
          `**AI Review Failed**\n\nError: ${error.message}\n\nTriggered by: @${author}`
        );
      }
    }
  }

  // Find PR by commit SHA when check run doesn't have pull_requests
  async findPRByCommitSha(repository, commitSha) {
    try {
      const owner = repository.owner.login;
      const repo = repository.name;
      
      logger.info(`Searching for PR with commit SHA: ${commitSha}`);
      
      const { data: prs } = await githubService.octokit.rest.pulls.list({
        owner,
        repo,
        state: 'open',
        sort: 'updated',
        direction: 'desc',
        per_page: 50,
      });

      // Find PR with matching head SHA
      for (const pr of prs) {
        if (pr.head.sha === commitSha) {
          logger.info(`Found matching PR #${pr.number} with head SHA: ${commitSha}`);
          return {
            number: pr.number,
            head: { sha: commitSha }
          };
        }
      }

      // Check if commit exists in any PR
      for (const pr of prs) {
        try {
          const { data: commits } = await githubService.octokit.rest.pulls.listCommits({
            owner,
            repo,
            pull_number: pr.number,
          });
          
          const hasCommit = commits.some(commit => commit.sha === commitSha);
          if (hasCommit) {
            logger.info(`Found PR #${pr.number} containing commit ${commitSha}`);
            return {
              number: pr.number,
              head: { sha: commitSha }
            };
          }
        } catch (error) {
          continue;
        }
      }

      logger.warn(`No open PR found for commit SHA: ${commitSha}`);
      return null;
      
    } catch (error) {
      logger.error('Error finding PR by commit SHA:', error);
      return null;
    }
  }

  // ENHANCED: Trigger AI review and create interactive button check run
  async triggerAIReviewWithButtons(repository, pullRequest, initialCheckRun) {
    const owner = repository.owner.login;
    const repo = repository.name;
    const pullNumber = pullRequest.number;
    const trackingId = generateTrackingId();

    logger.info(`Starting AI review with interactive buttons for PR #${pullNumber}`, { 
      trackingId,
      repository: `${owner}/${repo}`
    });

    // Check concurrent review limit
    if (this.activeReviews >= this.maxConcurrentReviews) {
      await githubService.updateCheckRun(owner, repo, initialCheckRun.id, {
        status: 'queued',
        output: {
          title: 'AI Review Queued',
          summary: `Analysis queued due to high demand. Currently processing ${this.activeReviews} reviews.\n\nPlease wait and try again in a few minutes.`,
        },
        actions: [{
          label: 'Retry AI Review',
          description: 'Re-run the AI code analysis on this PR',
          identifier: 'retry_review'
        }]
      });
      return;
    }

    // Prevent duplicate processing
    const prKey = `${repository.full_name}#${pullNumber}`;
    if (this.processingQueue.has(prKey)) {
      logger.info(`PR ${prKey} already being processed`);
      
      await githubService.updateCheckRun(owner, repo, initialCheckRun.id, {
        status: 'queued',
        output: {
          title: 'AI Review Already in Progress',
          summary: 'This PR is already being analyzed. Please wait for completion.',
        }
      });
      return;
    }

    this.processingQueue.set(prKey, { 
      startTime: Date.now(), 
      trackingId, 
      checkRunId: initialCheckRun.id,
      pullNumber: pullNumber
    });

    try {
      this.activeReviews++;
      await this.processAIReviewWithButtons(repository, pullRequest, initialCheckRun, trackingId);
    } finally {
      this.processingQueue.delete(prKey);
      this.activeReviews--;
    }
  }

  // ENHANCED: Process AI review and create interactive button check run
  async processAIReviewWithButtons(repository, pullRequest, initialCheckRun, trackingId) {
    const owner = repository.owner.login;
    const repo = repository.name;
    const pullNumber = pullRequest.number;
    const headSha = initialCheckRun.head_sha;

    try {
      logger.info(`Processing AI review with buttons for PR ${owner}/${repo}#${pullNumber}`, { 
        trackingId,
        initialCheckRunId: initialCheckRun.id
      });

      // Progress 1: Starting analysis
      await githubService.updateCheckRun(owner, repo, initialCheckRun.id, {
        status: 'in_progress',
        output: {
          title: 'AI Review In Progress',
          summary: `Starting code analysis for PR #${pullNumber}...\n\n**Status:** Initializing\n**Analysis ID:** \`${trackingId}\``,
        }
      });

      // Progress 2: Fetching data
      await githubService.updateCheckRun(owner, repo, initialCheckRun.id, {
        status: 'in_progress',
        output: {
          title: 'AI Review In Progress',
          summary: `Fetching PR data and code changes for PR #${pullNumber}...\n\n**Status:** Fetching data\n**Analysis ID:** \`${trackingId}\``,
        }
      });

      const prData = await githubService.getPullRequestData(owner, repo, pullNumber);
      
      if (!prData.files || prData.files.length === 0) {
        await this.completeWithNoFilesButtons(owner, repo, pullNumber, initialCheckRun, prData, trackingId);
        return;
      }

      // Progress 3: AI Analysis
      await githubService.updateCheckRun(owner, repo, initialCheckRun.id, {
        status: 'in_progress',
        output: {
          title: 'AI Review In Progress',
          summary: `Analyzing ${prData.files.length} files with AI using SonarQube standards...\n\n**PR:** #${pullNumber}\n**Status:** AI processing\n**Analysis ID:** \`${trackingId}\`\n\n*This may take 1-2 minutes depending on code complexity...*`,
        }
      });

      const startTime = Date.now();
      const analysis = await aiService.analyzePullRequest(prData, prData.comments);
      const analysisTime = Date.now() - startTime;

      analysis.trackingId = trackingId;

      logger.info(`AI analysis completed in ${analysisTime}ms`, {
        trackingId,
        pullNumber,
        issuesFound: analysis.automatedAnalysis.totalIssues,
        assessment: analysis.reviewAssessment,
      });

      // NEW: Check if AI analysis failed before proceeding
      if (analysis.detailedFindings.some(f => f.file === 'AI_PARSING_ERROR' || f.file === 'AI_SERVICE_ERROR')) {
        await this.completeWithRetryButton(owner, repo, pullNumber, initialCheckRun, analysis, prData);
        return;
      }

      // If successful, post comment and create interactive check run
      await this.completeWithButtonsCheckRun(owner, repo, pullNumber, initialCheckRun, analysis, headSha);

    } catch (error) {
      logger.error(`Error in AI review for PR #${pullNumber}:`, error, { trackingId });
      await this.completeWithError(owner, repo, pullNumber, initialCheckRun, error, trackingId);
    }
  }

  // ENHANCED: Complete with interactive button check run
  async completeWithButtonsCheckRun(owner, repo, pullNumber, initialCheckRun, analysis, headSha) {
    try {
      logger.info(`Creating interactive check run for PR #${pullNumber}`, { 
        trackingId: analysis.trackingId,
        totalIssues: analysis.automatedAnalysis.totalIssues
      });

      // Post the traditional structured comment first
      await githubService.postStructuredReviewComment(owner, repo, pullNumber, analysis);

      // Create the new interactive check run with buttons
      const interactiveCheckRun = await checkRunButtonService.createInteractiveCheckRun(
        owner, repo, pullNumber, analysis, headSha
      );

      // Update the initial check run to point to the interactive one
      await githubService.updateCheckRun(owner, repo, initialCheckRun.id, {
        status: 'completed',
        conclusion: 'success',
        output: {
          title: 'AI Review Analysis Complete',
          summary: `Analysis completed successfully!\n\nInteractive comment buttons are now available in the main "AI Code Review" check run.\n\n**Issues Found:** ${analysis.automatedAnalysis.totalIssues}\n**Analysis ID:** \`${analysis.trackingId}\`\n\nSee the main check run above for interactive comment posting options.`
        }
      });

      logger.info(`Interactive check run created successfully for PR #${pullNumber}`, { 
        trackingId: analysis.trackingId,
        interactiveCheckRunId: interactiveCheckRun.id,
        initialCheckRunId: initialCheckRun.id
      });

    } catch (error) {
      logger.error('Error creating interactive check run:', error);
      throw error;
    }
  }

  // NEW: Complete with a retry button for AI failures
  async completeWithRetryButton(owner, repo, pullNumber, checkRun, analysis, prData) {
    try {
      const errorFinding = analysis.detailedFindings[0];

      await githubService.updateCheckRun(owner, repo, checkRun.id, {
        status: 'completed',
        conclusion: 'failure',
        output: {
          title: 'AI Review Failed',
          summary: `The AI analysis failed to produce a valid response.\n\n` + 
                   `**Reason:** ${errorFinding.issue}\n\n` +
                   `**Suggestion:** ${errorFinding.suggestion}\n\n` +
                   `Please click the retry button below to try again.`,
        },
        actions: [{
          label: 'Retry AI Review',
          description: 'Re-run the AI code analysis on this PR',
          identifier: 'retry_review'
        }]
      });

      logger.warn(`AI review failed for PR #${pullNumber}, check run updated with retry button`, {
        trackingId: analysis.trackingId,
        error: errorFinding.issue
      });
      
    } catch (error) {
      logger.error('Error completing check run with retry button:', error);
      this.completeWithError(owner, repo, pullNumber, checkRun, error, analysis.trackingId);
    }
  }

  // Complete with no files (simplified version)
  async completeWithNoFilesButtons(owner, repo, pullNumber, checkRun, prData, trackingId) {
    try {
      const analysis = {
        trackingId,
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
        recommendation: 'No code files found to analyze. This PR contains only documentation or configuration changes.'
      };

      // Post structured comment
      await githubService.postStructuredReviewComment(owner, repo, pullNumber, analysis);

      // Update check run
      await githubService.updateCheckRun(owner, repo, checkRun.id, {
        status: 'completed',
        conclusion: 'neutral',
        output: {
          title: 'AI Code Review Completed',
          summary: `No code files found to analyze for PR #${pullNumber}.\n\nThis PR may contain only documentation or configuration changes.\n\n**Analysis ID:** \`${trackingId}\``,
        }
      });

      logger.info(`AI review completed (no files) for PR #${pullNumber}`, { trackingId });

    } catch (error) {
      await this.completeWithError(owner, repo, pullNumber, checkRun, error, trackingId);
    }
  }

  // Complete with error
  async completeWithError(owner, repo, pullNumber, checkRun, error, trackingId) {
    try {
      await githubService.postGeneralComment(
        owner,
        repo,
        pullNumber,
        `**Unable to Complete AI Review**\n\n` +
        `The AI analysis encountered an error and could not be completed for PR #${pullNumber}.\n\n` +
        `**Error:** ${error.message}\n` +
        `**Analysis ID:** \`${trackingId}\`\n` +
        `**Time:** ${new Date().toISOString()}\n\n` +
        `Please try clicking "Start AI Review" again or contact the administrator if this persists.`
      );

      await githubService.updateCheckRun(owner, repo, checkRun.id, {
        status: 'completed',
        conclusion: 'failure',
        output: {
          title: 'AI Code Review Failed',
          summary: `Analysis failed for PR #${pullNumber}: ${error.message}\n\nPlease try again or contact administrator.\n\n**Tracking ID:** ${trackingId}`,
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

    if (event === 'issue_comment' && (!payload.comment || !payload.issue)) {
      throw new Error('Invalid issue comment payload');
    }

    if (!payload.repository) {
      throw new Error('Missing repository information in payload');
    }

    return true;
  }

  // Get processing queue status with check run button stats
  getProcessingStatus() {
    const queueEntries = Array.from(this.processingQueue.entries()).map(([key, value]) => ({
      prKey: key,
      pullNumber: value.pullNumber,
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
      checkRunButtons: checkRunButtonService.getStats(),
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
