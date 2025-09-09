const githubService = require("./github.service");
const aiService = require("./ai.service");
const checkRunButtonService = require("./check-run-button.service");
const prReviewStatusService = require("./pr-review-status.service");
const logger = require("../utils/logger");
const { delay, generateTrackingId } = require("../utils/helpers");

class WebhookService {
  constructor() {
    this.processingQueue = new Map();
    this.maxConcurrentReviews = 3;
    this.activeReviews = 0;
  }

  /**
   * Main webhook handler that processes GitHub webhook events
   * @param {string} event - The GitHub webhook event type
   * @param {Object} payload - The webhook payload data
   */
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
        case "pull_request":
          await this.handlePullRequestEvent(payload);
          break;
        case "check_run":
          await this.handleCheckRunEvent(payload);
          break;
        case "issue_comment":
          await this.handleIssueCommentEvent(payload);
          break;
        case "ping":
          logger.info("Webhook ping received - GitHub App is connected");
          break;
        default:
          logger.info(`Ignoring event: ${event}`);
      }
    } catch (error) {
      logger.error("Error handling webhook:", error);
      throw error;
    }
  }

  /**
   * Handles pull request events and creates initial AI review button
   * @param {Object} payload - The webhook payload containing PR data
   */
  async handlePullRequestEvent(payload) {
    const { action, pull_request, repository } = payload;
    const owner = repository.owner.login;
    const repo = repository.name;
    const pullNumber = pull_request.number;

    const relevantActions = ["opened", "reopened", "synchronize"];
    if (!relevantActions.includes(action)) {
      logger.info(`Ignoring PR action: ${action}`);
      return;
    }

    if (pull_request.draft) {
      logger.info(`Ignoring draft PR #${pullNumber}`);
      return;
    }

    if (!githubService.isTargetBranch(pull_request.base.ref)) {
      logger.info(`Ignoring PR to non-target branch: ${pull_request.base.ref}`);
      return;
    }

    // Check if review has already been completed for this PR
    if (prReviewStatusService.hasReviewBeenCompleted(owner, repo, pullNumber)) {
      logger.info(
        `PR #${pullNumber} already has completed review, skipping AI review button creation`
      );

      // If fixes have been committed, show only Check Merge Ready button
      if (
        prReviewStatusService.hasFixesBeenCommitted(owner, repo, pullNumber)
      ) {
        await this.createCheckMergeReadyButton(repository, pull_request);
      }
      return;
    }

    await this.createInitialAIReviewButton(repository, pull_request);
  }

  /**
   * Creates the initial AI review button for a pull request
   * @param {Object} repository - The repository object from webhook
   * @param {Object} pullRequest - The pull request object
   */
  async createInitialAIReviewButton(repository, pullRequest) {
    const owner = repository.owner.login;
    const repo = repository.name;
    const headSha = pullRequest.head.sha;

    try {
      logger.info(
        `Creating initial AI Review button for PR #${pullRequest.number}`
      );

      const checkRun = await githubService.createCheckRun(owner, repo, {
        name: "AI Code Review",
        head_sha: headSha,
        status: "queued",
        output: {
          title: "AI Code Review Available",
          summary: `Click "Start AI Review" to analyze this PR with SonarQube standards.\n\n**Files to analyze:** ${pullRequest.changed_files}\n**Lines changed:** +${pullRequest.additions} -${pullRequest.deletions}`,
          // REMOVED: text field to prevent empty DETAILS section
        },
        actions: [
          {
            label: "Start AI Review",
            description: "Trigger code analysis for this PR",
            identifier: "ai_review",
          },
        ],
      });

      logger.info(
        `Initial AI Review button created: ${checkRun.id} for PR #${pullRequest.number}`
      );
    } catch (error) {
      logger.error("Error creating AI Review button:", error);

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

  /**
   * Creates a check merge ready button for PRs that already have completed review
   * @param {Object} repository - The repository object from webhook
   * @param {Object} pullRequest - The pull request object
   */
  async createCheckMergeReadyButton(repository, pullRequest) {
    const owner = repository.owner.login;
    const repo = repository.name;
    const headSha = pullRequest.head.sha;

    try {
      logger.info(
        `Creating Check Merge Ready button for PR #${pullRequest.number}`
      );

      const checkRun = await githubService.createCheckRun(owner, repo, {
        name: "AI Code Review",
        head_sha: headSha,
        status: "queued",
        output: {
          title: "AI Review Completed - Check Merge Ready",
          summary: `This PR has already been reviewed by AI. All fixes have been committed.\n\n**Status:** Click "Check Merge Ready" to verify merge readiness\n**Files analyzed:** ${pullRequest.changed_files}\n**Lines changed:** +${pullRequest.additions} -${pullRequest.deletions}`,
        },
        actions: [
          {
            label: "Check Merge Ready",
            description: "Check if this PR is ready to merge",
            identifier: "check-merge",
          },
        ],
      });

      // Store check run data for button handling
      const checkRunData = {
        checkRunId: checkRun.id,
        owner,
        repo,
        pullNumber: pullRequest.number,
        headSha,
        buttonStates: {},
        analysis: null, // No analysis data for this check run
        postableFindings: [],
      };

      // Store in active check runs map
      const checkRunButtonService = require("./check-run-button.service");
      checkRunButtonService.activeCheckRuns.set(checkRun.id, checkRunData);

      logger.info(
        `Check Merge Ready button created: ${checkRun.id} for PR #${pullRequest.number}`
      );
    } catch (error) {
      logger.error("Error creating Check Merge Ready button:", error);
      throw error;
    }
  }

  /**
   * Handles check run button clicks for both initial AI review and comment posting
   * @param {Object} payload - The webhook payload containing check run data
   */
  async handleCheckRunEvent(payload) {
    const { action, check_run, requested_action } = payload;

    if (action === "requested_action" && check_run.name === "AI Code Review") {
      const actionId = requested_action.identifier;

      logger.info(
        `Check run action requested: ${actionId} for check run ${check_run.id}`
      );

      // Handle initial AI review trigger
      if (actionId === "ai_review" || actionId === "retry_review") {
        await this.handleInitialReviewRequest(payload);
        return;
      }

      const handled = await checkRunButtonService.handleButtonAction(payload);
      if (handled) {
        logger.info(`Interactive button action handled: ${actionId}`);
        return;
      }

      logger.warn(`Unhandled check run action: ${actionId}`);
    }
  }

  /**
   * Handles the initial AI review request from check run button
   * @param {Object} payload - The webhook payload containing check run data
   */
  async handleInitialReviewRequest(payload) {
    const { check_run, repository } = payload;

    let targetPR = null;

    if (check_run.pull_requests && check_run.pull_requests.length > 0) {
      targetPR = check_run.pull_requests[0];
      logger.info(`Found PR from pull_requests array: #${targetPR.number}`);
    } else {
      logger.info(`Searching for PR by commit SHA: ${check_run.head_sha}`);
      targetPR = this.findPRByCommitSha(repository, check_run.head_sha);
    }

    if (targetPR) {
      logger.info(`Triggering AI review for PR #${targetPR.number}`);
      await this.triggerAIReviewWithButtons(repository, targetPR, check_run);
    } else {
      logger.error("Could not find associated PR for check run", {
        checkRunId: check_run.id,
        headSha: check_run.head_sha,
      });

      await githubService.updateCheckRun(
        repository.owner.login,
        repository.name,
        check_run.id,
        {
          status: "completed",
          conclusion: "failure",
          output: {
            title: "AI Review Failed",
            summary:
              "Could not find the associated pull request for this check run.",
          },
        }
      );
    }
  }

  /**
   * Handles issue comments and processes AI review triggers
   * @param {Object} payload - The webhook payload containing comment data
   */
  async handleIssueCommentEvent(payload) {
    const { action, comment, issue, repository } = payload;

    if (action !== "created" || !issue.pull_request) {
      return;
    }

    const commentBody = comment.body.toLowerCase();
    const author = comment.user.login;

    const triggers = ["/ai-review"];
    const isAIReviewTrigger = triggers.some((trigger) =>
      commentBody.includes(trigger)
    );

    if (comment.user.type === "Bot") {
      return;
    }
    if (isAIReviewTrigger) {
      logger.info(
        `AI review triggered by comment from ${author} on PR #${issue.number} (backup method)`
      );

      try {
        const owner = repository.owner.login;
        const repo = repository.name;

        const { data: pr } = await githubService.octokit.rest.pulls.get({
          owner,
          repo,
          pull_number: issue.number,
        });

        const checkRun = await githubService.createCheckRun(owner, repo, {
          name: "AI Code Review (Manual)",
          head_sha: pr.head.sha,
          status: "queued",
          output: {
            title: "AI Review Triggered by Comment",
            summary: `Analysis started by @${author}`,
          },
        });

        await this.triggerAIReviewWithButtons(
          repository,
          { number: issue.number },
          checkRun
        );
      } catch (error) {
        logger.error("Error handling manual trigger:", error);
        await githubService.postGeneralComment(
          repository.owner.login,
          repository.name,
          issue.number,
          `**AI Review Failed**\n\nError: ${error.message}\n\nTriggered by: @${author}`
        );
      }
    }
  }

  /**
   * Finds a pull request by commit SHA when check run doesn't have pull_requests
   * @param {Object} repository - The repository object
   * @param {string} commitSha - The commit SHA to search for
   * @returns {Object|null} The pull request object or null if not found
   */
  async findPRByCommitSha(repository, commitSha) {
    try {
      const owner = repository.owner.login;
      const repo = repository.name;

      logger.info(`Searching for PR with commit SHA: ${commitSha}`);

      const { data: prs } = await githubService.octokit.rest.pulls.list({
        owner,
        repo,
        state: "open",
        sort: "updated",
        direction: "desc",
        per_page: 50,
      });

      for (const pr of prs) {
        if (pr.head.sha === commitSha) {
          logger.info(
            `Found matching PR #${pr.number} with head SHA: ${commitSha}`
          );
          return {
            number: pr.number,
            head: { sha: commitSha },
          };
        }
      }
      for (const pr of prs) {
        try {
          const { data: commits } =
            await githubService.octokit.rest.pulls.listCommits({
              owner,
              repo,
              pull_number: pr.number,
            });

          const hasCommit = commits.some((commit) => commit.sha === commitSha);
          if (hasCommit) {
            logger.info(
              `Found PR #${pr.number} containing commit ${commitSha}`
            );
            return {
              number: pr.number,
              head: { sha: commitSha },
            };
          }
        } catch (error) {
          logger.warn(`Error checking commits for PR #${pr.number}:`, error.message);
          continue;
        }
      }

      logger.warn(`No open PR found for commit SHA: ${commitSha}`);
      return null;
    } catch (error) {
      logger.error("Error finding PR by commit SHA:", error);
      return null;
    }
  }

  /**
   * Triggers AI review and creates interactive button check run
   * @param {Object} repository - The repository object
   * @param {Object} pullRequest - The pull request object
   * @param {Object} initialCheckRun - The initial check run object
   */
  async triggerAIReviewWithButtons(repository, pullRequest, initialCheckRun) {
    const owner = repository.owner.login;
    const repo = repository.name;
    const pullNumber = pullRequest.number;
    const trackingId = generateTrackingId();

    logger.info(
      `Starting AI review with interactive buttons for PR #${pullNumber}`,
      {
        trackingId,
        repository: `${owner}/${repo}`,
      }
    );

    if (this.activeReviews >= this.maxConcurrentReviews) {
      await githubService.updateCheckRun(owner, repo, initialCheckRun.id, {
        status: "queued",
        output: {
          title: "AI Review Queued",
          summary: `Analysis queued due to high demand. Currently processing ${this.activeReviews} reviews.\n\nPlease wait and try again in a few minutes.`,
        },
        actions: [
          {
            label: "Retry AI Review",
            description: "Re-run the AI code analysis on this PR",
            identifier: "retry_review",
          },
        ],
      });
      return;
    }

    const prKey = `${repository.full_name}#${pullNumber}`;
    if (this.processingQueue.has(prKey)) {
      logger.info(`PR ${prKey} already being processed`);

      await githubService.updateCheckRun(owner, repo, initialCheckRun.id, {
        status: "queued",
        output: {
          title: "AI Review Already in Progress",
          summary:
            "This PR is already being analyzed. Please wait for completion.",
        },
      });
      return;
    }

    this.processingQueue.set(prKey, {
      startTime: Date.now(),
      trackingId,
      checkRunId: initialCheckRun.id,
      pullNumber: pullNumber,
    });

    try {
      this.activeReviews++;
      await this.processAIReviewWithButtons(
        repository,
        pullRequest,
        initialCheckRun,
        trackingId
      );
    } finally {
      this.processingQueue.delete(prKey);
      this.activeReviews--;
    }
  }

  /**
   * Processes AI review and creates interactive button check run
   * @param {Object} repository - The repository object
   * @param {Object} pullRequest - The pull request object
   * @param {Object} initialCheckRun - The initial check run object
   * @param {string} trackingId - The tracking ID for this analysis
   */
  async processAIReviewWithButtons(
    repository,
    pullRequest,
    initialCheckRun,
    trackingId
  ) {
    const owner = repository.owner.login;
    const repo = repository.name;
    const pullNumber = pullRequest.number;
    const headSha = initialCheckRun.head_sha;

    try {
      logger.info(
        `Processing AI review with buttons for PR ${owner}/${repo}#${pullNumber}`,
        {
          trackingId,
          initialCheckRunId: initialCheckRun.id,
        }
      );

      await githubService.updateCheckRun(owner, repo, initialCheckRun.id, {
        status: "in_progress",
        output: {
          title: "AI Review In Progress",
          summary: `Starting code analysis for PR #${pullNumber}...\n\n**Status:** Initializing\n**Analysis ID:** \`${trackingId}\``,
        },
      });

      await githubService.updateCheckRun(owner, repo, initialCheckRun.id, {
        status: "in_progress",
        output: {
          title: "AI Review In Progress",
          summary: `Fetching PR data and code changes for PR #${pullNumber}...\n\n**Status:** Fetching data\n**Analysis ID:** \`${trackingId}\``,
        },
      });

      const prData = await githubService.getPullRequestData(
        owner,
        repo,
        pullNumber
      );

      if (!prData.files || prData.files.length === 0) {
        await this.completeWithNoFilesButtons(
          owner,
          repo,
          pullNumber,
          initialCheckRun,
          prData,
          trackingId
        );
        return;
      }

      await githubService.updateCheckRun(owner, repo, initialCheckRun.id, {
        status: "in_progress",
        output: {
          title: "AI Review In Progress",
          summary: `Analyzing ${prData.files.length} files with AI using SonarQube standards...\n\n**PR:** #${pullNumber}\n**Status:** AI processing\n**Analysis ID:** \`${trackingId}\`\n\n*This may take 1-2 minutes depending on code complexity...*`,
        },
      });

      const startTime = Date.now();
      const analysis = await aiService.analyzePullRequest(
        prData,
        prData.comments
      );
      const analysisTime = Date.now() - startTime;

      analysis.trackingId = trackingId;

      const filteredAnalysis = await aiService.filterPreviouslySuggestedFixes(
        owner,
        repo,
        analysis
      );

      logger.info(`AI analysis completed in ${analysisTime}ms`, {
        trackingId,
        pullNumber,
        issuesFound: filteredAnalysis.automatedAnalysis.totalIssues,
        assessment: filteredAnalysis.reviewAssessment,
      });

      if (
        filteredAnalysis.detailedFindings.some(
          (f) => f.file === "AI_PARSING_ERROR" || f.file === "AI_SERVICE_ERROR"
        )
      ) {
        await this.completeWithRetryButton(
          owner,
          repo,
          pullNumber,
          initialCheckRun,
          filteredAnalysis,
          prData
        );
        return;
      }

      await this.completeWithButtonsCheckRun(
        owner,
        repo,
        pullNumber,
        initialCheckRun,
        filteredAnalysis,
        headSha
      );
    } catch (error) {
      logger.error(`Error in AI review for PR #${pullNumber}:`, error, {
        trackingId,
      });
      await this.completeWithError(
        owner,
        repo,
        pullNumber,
        initialCheckRun,
        error,
        trackingId
      );
    }
  }

  /**
   * Completes the AI review with interactive button check run
   * @param {string} owner - Repository owner
   * @param {string} repo - Repository name
   * @param {number} pullNumber - Pull request number
   * @param {Object} initialCheckRun - The initial check run object
   * @param {Object} analysis - The AI analysis results
   * @param {string} headSha - The head commit SHA
   */
  async completeWithButtonsCheckRun(
    owner,
    repo,
    pullNumber,
    initialCheckRun,
    analysis,
    headSha
  ) {
    try {
      logger.info(`Creating interactive check run for PR #${pullNumber}`, {
        trackingId: analysis.trackingId,
        totalIssues: analysis.automatedAnalysis.totalIssues,
      });

      analysis.mainAnalysisPosted = true;
      await githubService.postStructuredReviewComment(
        owner,
        repo,
        pullNumber,
        analysis
      );

      const interactiveCheckRun =
        await checkRunButtonService.createInteractiveCheckRun(
          owner,
          repo,
          pullNumber,
          analysis,
          headSha
        );

      await githubService.updateCheckRun(owner, repo, initialCheckRun.id, {
        status: "completed",
        conclusion: "success",
        output: {
          title: "AI Review Analysis Complete",
          summary: `Analysis completed successfully!\n\nInteractive comment buttons are now available in the main "AI Code Review" check run.\n\n**Issues Found:** ${analysis.automatedAnalysis.totalIssues}\n**Analysis ID:** \`${analysis.trackingId}\`\n\nSee the main check run above for interactive comment posting options.`,
        },
      });

      prReviewStatusService.markReviewCompleted(owner, repo, pullNumber);

      logger.info(
        `Interactive check run created successfully for PR #${pullNumber}`,
        {
          trackingId: analysis.trackingId,
          interactiveCheckRunId: interactiveCheckRun.id,
          initialCheckRunId: initialCheckRun.id,
        }
      );
    } catch (error) {
      logger.error("Error creating interactive check run:", error);
      throw error;
    }
  }

  /**
   * Completes the check run with a retry button when AI analysis fails
   * @param {string} owner - Repository owner
   * @param {string} repo - Repository name
   * @param {number} pullNumber - Pull request number
   * @param {Object} checkRun - The check run object
   * @param {Object} analysis - The analysis results
   * @param {Object} prData - The pull request data
   */
  async completeWithRetryButton(
    owner,
    repo,
    pullNumber,
    checkRun,
    analysis,
    prData
  ) {
    try {
      const errorFinding = analysis.detailedFindings[0];

      await githubService.updateCheckRun(owner, repo, checkRun.id, {
        status: "completed",
        conclusion: "failure",
        output: {
          title: "AI Review Failed",
          summary:
            `The AI analysis failed to produce a valid response.\n\n` +
            `**Reason:** ${errorFinding.issue}\n\n` +
            `**Suggestion:** ${errorFinding.suggestion}\n\n` +
            `Please click the retry button below to try again.`,
        },
        actions: [
          {
            label: "Retry AI Review",
            description: "Re-run the AI code analysis on this PR",
            identifier: "retry_review",
          },
        ],
      });

      logger.warn(
        `AI review failed for PR #${pullNumber}, check run updated with retry button`,
        {
          trackingId: analysis.trackingId,
          error: errorFinding.issue,
        }
      );
    } catch (error) {
      logger.error("Error completing check run with retry button:", error);
      this.completeWithError(
        owner,
        repo,
        pullNumber,
        checkRun,
        error,
        analysis.trackingId
      );
    }
  }

  /**
   * Completes the check run when no files are found to analyze
   * @param {string} owner - Repository owner
   * @param {string} repo - Repository name
   * @param {number} pullNumber - Pull request number
   * @param {Object} checkRun - The check run object
   * @param {Object} prData - The pull request data
   * @param {string} trackingId - The tracking ID for this analysis
   */
  async completeWithNoFilesButtons(
    owner,
    repo,
    pullNumber,
    checkRun,
    prData,
    trackingId
  ) {
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
          reviewComments: prData.comments.length,
          issuesAddressedByReviewers: 0,
          securityIssuesCaught: 0,
          codeQualityIssuesCaught: 0,
        },
        reviewAssessment: "REVIEW REQUIRED",
        detailedFindings: [],
        recommendation:
          "No code files found to analyze. This PR contains only documentation or configuration changes.",
      };

      await githubService.postStructuredReviewComment(
        owner,
        repo,
        pullNumber,
        analysis
      );

      await githubService.updateCheckRun(owner, repo, checkRun.id, {
        status: "completed",
        conclusion: "neutral",
        output: {
          title: "AI Code Review Completed",
          summary: `No code files found to analyze for PR #${pullNumber}.\n\nThis PR may contain only documentation or configuration changes.\n\n**Analysis ID:** \`${trackingId}\``,
        },
      });

      logger.info(`AI review completed (no files) for PR #${pullNumber}`, {
        trackingId,
      });
    } catch (error) {
      await this.completeWithError(
        owner,
        repo,
        pullNumber,
        checkRun,
        error,
        trackingId
      );
    }
  }

  /**
   * Completes the check run with an error message
   * @param {string} owner - Repository owner
   * @param {string} repo - Repository name
   * @param {number} pullNumber - Pull request number
   * @param {Object} checkRun - The check run object
   * @param {Error} error - The error that occurred
   * @param {string} trackingId - The tracking ID for this analysis
   */
  async completeWithError(
    owner,
    repo,
    pullNumber,
    checkRun,
    error,
    trackingId
  ) {
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
        status: "completed",
        conclusion: "failure",
        output: {
          title: "AI Code Review Failed",
          summary: `Analysis failed for PR #${pullNumber}: ${error.message}\n\nPlease try again or contact administrator.\n\n**Tracking ID:** ${trackingId}`,
        },
      });

      logger.error(`AI review failed for PR #${pullNumber}`, {
        trackingId,
        error: error.message,
      });
    } catch (postError) {
      logger.error("Error posting failure message:", postError);
    }
  }

  /**
   * Validates the webhook payload structure
   * @param {Object} payload - The webhook payload
   * @param {string} event - The webhook event type
   * @returns {boolean} True if payload is valid
   */
  validateWebhookPayload(payload, event) {
    if (!payload) {
      throw new Error("Empty webhook payload");
    }

    if (event === "pull_request" && !payload.pull_request) {
      throw new Error("Invalid pull request payload");
    }

    if (event === "check_run" && !payload.check_run) {
      throw new Error("Invalid check run payload");
    }

    if (event === "issue_comment" && (!payload.comment || !payload.issue)) {
      throw new Error("Invalid issue comment payload");
    }

    if (!payload.repository) {
      throw new Error("Missing repository information in payload");
    }

    return true;
  }

  /**
   * Gets the current processing queue status with check run button stats
   * @returns {Object} The processing status information
   */
  getProcessingStatus() {
    const queueEntries = Array.from(this.processingQueue.entries()).map(
      ([key, value]) => ({
        prKey: key,
        pullNumber: value.pullNumber,
        startTime: value.startTime,
        trackingId: value.trackingId,
        checkRunId: value.checkRunId,
        duration: Date.now() - value.startTime,
      })
    );

    return {
      activeReviews: this.activeReviews,
      queueSize: this.processingQueue.size,
      maxConcurrent: this.maxConcurrentReviews,
      currentQueue: queueEntries,
      checkRunButtons: checkRunButtonService.getStats(),
    };
  }

  /**
   * Cleans old processing entries from the queue
   */
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

    checkRunButtonService.cleanOldCheckRuns();
  }

  /**
   * Performs graceful shutdown of the webhook service
   */
  async shutdown() {
    logger.info("Shutting down gracefully...");

    const maxWaitTime = 30000; // 30 seconds
    const startTime = Date.now();

    while (this.activeReviews > 0 && Date.now() - startTime < maxWaitTime) {
      logger.info(
        `Waiting for ${this.activeReviews} active reviews to complete...`
      );
      await delay(1000);
    }

    if (this.activeReviews > 0) {
      logger.warn(
        `Force shutdown with ${this.activeReviews} reviews still active`
      );
    } else {
      logger.info("All reviews completed, shutdown complete");
    }
  }
}

const webhookService = new WebhookService();
setInterval(() => {
  webhookService.cleanProcessingQueue();
}, 5 * 60 * 1000);

module.exports = webhookService;
