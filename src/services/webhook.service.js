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
        checkRunId: payload.check_run?.id,
        checkRunHeadSha: payload.check_run?.head_sha,
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

  // Handle PR events - create unique check runs per PR
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

  // Create AI Review button with PR-specific naming
  async createAIReviewButton(repository, pullRequest) {
    const owner = repository.owner.login;
    const repo = repository.name;
    const headSha = pullRequest.head.sha;

    try {
      logger.info(`Creating AI Review button for PR #${pullRequest.number} with SHA: ${headSha}`);

      // IMPORTANT: Create unique check run name per PR to avoid conflicts
      const uniqueCheckRunName = `AI Code Review (PR #${pullRequest.number})`;

      const checkRun = await githubService.createCheckRun(owner, repo, {
        name: uniqueCheckRunName,
        head_sha: headSha,
        status: 'queued',
        output: {
          title: `AI Code Review Available for PR #${pullRequest.number}`,
          summary: `Click "AI Review" to analyze PR #${pullRequest.number} with SonarQube standards.\n\n**Files to analyze:** ${pullRequest.changed_files}\n**Lines changed:** +${pullRequest.additions} -${pullRequest.deletions}`,
        },
        actions: [{
          label: 'AI Review',
          description: `Analyze PR #${pullRequest.number}`,
          identifier: `ai_review_${pullRequest.number}_${Date.now()}` // Unique identifier
        }]
      });

      logger.info(`AI Review button created for PR #${pullRequest.number}: ${checkRun.id}`);
    } catch (error) {
      logger.error(`Error creating AI Review button for PR #${pullRequest.number}:`, error);
      
      // Fallback: Post instruction comment
      await githubService.postGeneralComment(
        owner,
        repo,
        pullRequest.number,
        `🤖 **AI Code Review Available for PR #${pullRequest.number}**\n\n` +
        `Comment \`/ai-review\` to trigger analysis.\n\n` +
        `**Files to analyze:** ${pullRequest.changed_files}\n` +
        `**Lines changed:** +${pullRequest.additions} -${pullRequest.deletions}\n\n` +
        `*Analysis will use SonarQube standards for comprehensive code review.*`
      );
    }
  }

  // Handle button clicks with improved PR finding
  async handleCheckRunEvent(payload) {
    const { action, check_run, repository } = payload;

    if (action === 'requested_action' && check_run.name.startsWith('AI Code Review')) {
      const requestedAction = payload.requested_action;
      
      if (requestedAction.identifier.startsWith('ai_review')) {
        logger.info(`AI Review button clicked for check run ${check_run.id}`, {
          checkRunId: check_run.id,
          checkRunName: check_run.name,
          headSha: check_run.head_sha,
        });
        
        let targetPR = null;
        
        // Method 1: Extract PR number from check run name
        const prMatch = check_run.name.match(/PR #(\d+)/);
        if (prMatch) {
          const prNumber = parseInt(prMatch[1]);
          logger.info(`Extracted PR number from check run name: #${prNumber}`);
          
          // Validate this PR exists and matches the commit
          try {
            const { data: pr } = await githubService.octokit.rest.pulls.get({
              owner: repository.owner.login,
              repo: repository.name,
              pull_number: prNumber,
            });
            
            if (pr.head.sha === check_run.head_sha) {
              targetPR = { number: prNumber, head: { sha: check_run.head_sha } };
              logger.info(`Validated PR #${prNumber} matches commit SHA`);
            } else {
              logger.warn(`PR #${prNumber} head SHA mismatch. Expected: ${check_run.head_sha}, Got: ${pr.head.sha}`);
            }
          } catch (error) {
            logger.error(`Failed to validate PR #${prNumber}:`, error.message);
          }
        }
        
        // Method 2: Try pull_requests array
        if (!targetPR && check_run.pull_requests && check_run.pull_requests.length > 0) {
          targetPR = check_run.pull_requests[0];
          logger.info(`Found PR from pull_requests array: #${targetPR.number}`);
        }
        
        // Method 3: Search by commit SHA
        if (!targetPR) {
          logger.info(`Searching for PR by commit SHA: ${check_run.head_sha}`);
          targetPR = await this.findPRByCommitSha(repository, check_run.head_sha);
        }
        
        if (targetPR) {
          logger.info(`Triggering AI review for PR #${targetPR.number} from check run ${check_run.id}`);
          await this.triggerAIReview(repository, targetPR, check_run);
        } else {
          logger.error('Could not find associated PR for check run', { 
            checkRunId: check_run.id,
            checkRunName: check_run.name,
            headSha: check_run.head_sha 
          });
          
          await githubService.updateCheckRun(repository.owner.login, repository.name, check_run.id, {
            status: 'completed',
            conclusion: 'failure',
            output: {
              title: 'AI Review Failed - PR Not Found',
              summary: `Could not find the associated pull request.\n\nCheck Run: ${check_run.name}\nCommit SHA: ${check_run.head_sha}`,
            }
          });
        }
      }
    }
  }

  // Find PR by commit SHA
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

      // Find PR with exact head SHA match
      for (const pr of prs) {
        if (pr.head.sha === commitSha) {
          logger.info(`Found matching PR #${pr.number} with head SHA: ${commitSha}`);
          return { number: pr.number, head: { sha: commitSha } };
        }
      }

      // If no exact match, check commits in each PR
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
            return { number: pr.number, head: { sha: commitSha } };
          }
        } catch (error) {
          continue; // Skip to next PR if error
        }
      }

      logger.warn(`No open PR found for commit SHA: ${commitSha}`);
      return null;
      
    } catch (error) {
      logger.error('Error finding PR by commit SHA:', error);
      return null;
    }
  }

  // Handle issue comments for manual trigger
  async handleIssueCommentEvent(payload) {
    const { action, comment, issue, repository } = payload;
    
    if (action !== 'created' || !issue.pull_request || comment.user.type === 'Bot') {
      return;
    }

    const commentBody = comment.body.toLowerCase();
    const triggers = ['/ai-review', '@ai-reviewer review', 'ai review'];
    const isAIReviewTrigger = triggers.some(trigger => commentBody.includes(trigger));

    if (!isAIReviewTrigger) {
      return;
    }

    logger.info(`AI review triggered by comment from ${comment.user.login} on PR #${issue.number}`);

    try {
      const owner = repository.owner.login;
      const repo = repository.name;
      
      const { data: pr } = await githubService.octokit.rest.pulls.get({
        owner,
        repo,
        pull_number: issue.number,
      });

      const checkRun = await githubService.createCheckRun(owner, repo, {
        name: `AI Code Review (PR #${issue.number}) - Manual`,
        head_sha: pr.head.sha,
        status: 'queued',
        output: {
          title: `AI Review Triggered for PR #${issue.number}`,
          summary: `Analysis started by @${comment.user.login}`,
        }
      });

      await this.triggerAIReview(repository, { number: issue.number }, checkRun);

    } catch (error) {
      logger.error('Error handling manual trigger:', error);
      await this.processAIReviewDirect(repository, { number: issue.number }, comment.user.login);
    }
  }

  // Trigger AI review with proper PR isolation
  async triggerAIReview(repository, pullRequest, checkRun) {
    const owner = repository.owner.login;
    const repo = repository.name;
    const pullNumber = pullRequest.number;
    const trackingId = generateTrackingId();

    logger.info(`Triggering AI review for PR #${pullNumber}`, { 
      trackingId, 
      checkRunId: checkRun.id,
      repository: `${owner}/${repo}`,
      pullNumber
    });

    if (this.activeReviews >= this.maxConcurrentReviews) {
      await githubService.updateCheckRun(owner, repo, checkRun.id, {
        status: 'queued',
        output: {
          title: `AI Review Queued for PR #${pullNumber}`,
          summary: `Analysis queued due to high demand. Currently processing ${this.activeReviews} reviews.\n\nPlease wait and try again in a few minutes.`,
        }
      });
      return;
    }

    const prKey = `${repository.full_name}#${pullNumber}`;
    if (this.processingQueue.has(prKey)) {
      logger.info(`PR ${prKey} already being processed`);
      
      await githubService.updateCheckRun(owner, repo, checkRun.id, {
        status: 'queued',
        output: {
          title: `AI Review Already in Progress for PR #${pullNumber}`,
          summary: 'This PR is already being analyzed. Please wait for completion.',
        }
      });
      return;
    }

    this.processingQueue.set(prKey, { 
      startTime: Date.now(), 
      trackingId, 
      checkRunId: checkRun.id,
      pullNumber: pullNumber
    });

    try {
      this.activeReviews++;
      await this.processAIReview(repository, pullRequest, checkRun, trackingId);
    } finally {
      this.processingQueue.delete(prKey);
      this.activeReviews--;
    }
  }

  // Process AI review with enhanced error handling
  async processAIReview(repository, pullRequest, checkRun, trackingId) {
    const owner = repository.owner.login;
    const repo = repository.name;
    const pullNumber = pullRequest.number;

    try {
      logger.info(`Starting AI review for PR #${pullNumber}`, { 
        trackingId,
        checkRunId: checkRun.id
      });

      // Progress 1: Starting
      await githubService.updateCheckRun(owner, repo, checkRun.id, {
        status: 'in_progress',
        output: {
          title: `AI Review In Progress - PR #${pullNumber}`,
          summary: `🔄 Starting code analysis for PR #${pullNumber}...\n\n**Status:** Initializing\n**Analysis ID:** \`${trackingId}\``,
        }
      });

      // Progress 2: Fetching data
      await githubService.updateCheckRun(owner, repo, checkRun.id, {
        status: 'in_progress',
        output: {
          title: `AI Review In Progress - PR #${pullNumber}`,
          summary: `🔄 Fetching PR data and code changes for PR #${pullNumber}...\n\n**Status:** Fetching data\n**Analysis ID:** \`${trackingId}\``,
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
          title: `AI Review In Progress - PR #${pullNumber}`,
          summary: `🧠 Analyzing ${prData.files.length} files with AI using SonarQube standards...\n\n**PR:** #${pullNumber}\n**Status:** AI processing\n**Analysis ID:** \`${trackingId}\`\n\n*This may take 1-2 minutes...*`,
        }
      });

      const startTime = Date.now();
      
      // Enhanced AI analysis with better error handling
      let analysis;
      try {
        analysis = await aiService.analyzePullRequest(prData, prData.comments);
        
        // Validate analysis structure
        if (!analysis || !analysis.automatedAnalysis) {
          throw new Error('AI returned invalid analysis structure');
        }
        
        const analysisTime = Date.now() - startTime;
        logger.info(`AI analysis completed successfully in ${analysisTime}ms`, {
          trackingId,
          pullNumber,
          issuesFound: analysis.automatedAnalysis.totalIssues,
          assessment: analysis.reviewAssessment,
        });
        
      } catch (aiError) {
        logger.error(`AI analysis failed for PR #${pullNumber}:`, aiError);
        
        // Create fallback analysis with proper structure
        analysis = this.createFallbackAnalysis(prData, aiError.message, trackingId);
      }

      // Always post the analysis (either successful or fallback)
      await this.completeWithResults(owner, repo, pullNumber, checkRun, analysis, trackingId);

    } catch (error) {
      logger.error(`Error in AI review for PR #${pullNumber}:`, error, { trackingId });
      await this.completeWithError(owner, repo, pullNumber, checkRun, error, trackingId);
    }
  }

  // Create proper fallback analysis structure
  createFallbackAnalysis(prData, errorMessage, trackingId) {
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
        totalIssues: 1,
        severityBreakdown: { blocker: 0, critical: 0, major: 1, minor: 0, info: 0 },
        categories: { bugs: 0, vulnerabilities: 0, securityHotspots: 0, codeSmells: 1 },
        technicalDebtMinutes: 0
      },
      humanReviewAnalysis: {
        reviewComments: prData.comments.length,
        issuesAddressedByReviewers: 0,
        securityIssuesCaught: 0,
        codeQualityIssuesCaught: 0
      },
      reviewAssessment: 'REVIEW REQUIRED',
      detailedFindings: [{
        file: 'AI_ANALYSIS_ERROR',
        line: 1,
        issue: `AI analysis encountered an error: ${errorMessage}`,
        severity: 'MAJOR',
        category: 'CODE_SMELL',
        suggestion: 'Please try running the analysis again or contact the administrator if the error persists.'
      }],
      recommendation: `AI analysis failed due to: ${errorMessage}. Manual code review is recommended. Please try again or contact support if the issue persists.`
    };
  }

  // Complete with results (always posts structured comment)
  async completeWithResults(owner, repo, pullNumber, checkRun, analysis, trackingId) {
    try {
      logger.info(`Posting structured comment for PR #${pullNumber}`, { trackingId });

      // Always post the structured comment
      await githubService.postStructuredReviewComment(owner, repo, pullNumber, analysis);

      // Determine conclusion
      const hasCriticalIssues = analysis.automatedAnalysis.severityBreakdown.critical > 0;
      const hasBlockerIssues = analysis.automatedAnalysis.severityBreakdown.blocker > 0;
      const isAnalysisError = analysis.detailedFindings.some(f => f.file === 'AI_ANALYSIS_ERROR');
      
      let conclusion = 'success';
      if (isAnalysisError) {
        conclusion = 'neutral';
      } else if (hasBlockerIssues) {
        conclusion = 'failure';
      } else if (hasCriticalIssues) {
        conclusion = 'neutral';
      } else if (analysis.reviewAssessment === 'PROPERLY REVIEWED') {
        conclusion = 'success';
      }

      await githubService.updateCheckRun(owner, repo, checkRun.id, {
        status: 'completed',
        conclusion: conclusion,
        output: {
          title: `AI Code Review Completed - PR #${pullNumber}`,
          summary: `✅ Analysis completed for PR #${pullNumber}!\n\n**Issues Found:** ${analysis.automatedAnalysis.totalIssues}\n**Critical:** ${analysis.automatedAnalysis.severityBreakdown.critical}\n**Assessment:** ${analysis.reviewAssessment}\n\n📋 See detailed analysis in PR comments below.`,
        }
      });

      logger.info(`AI review completed successfully for PR #${pullNumber}`, { 
        trackingId,
        issuesFound: analysis.automatedAnalysis.totalIssues,
        conclusion
      });

    } catch (error) {
      logger.error('Error completing review with results:', error, { trackingId, pullNumber });
      throw error;
    }
  }

  // Complete with no files
  async completeWithNoFiles(owner, repo, pullNumber, checkRun, prData, trackingId) {
    try {
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
        recommendation: `No code files found to analyze in PR #${pullNumber}. This PR contains only documentation or configuration changes. Human review recommended for content validation.`
      };

      await githubService.postStructuredReviewComment(owner, repo, pullNumber, analysis);

      await githubService.updateCheckRun(owner, repo, checkRun.id, {
        status: 'completed',
        conclusion: 'neutral',
        output: {
          title: `AI Code Review Completed - PR #${pullNumber}`,
          summary: `No code files found to analyze in PR #${pullNumber}. This PR may contain only documentation or configuration changes.`,
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
        `🚨 **Unable to Complete AI Review for PR #${pullNumber}**\n\n` +
        `The AI analysis encountered an error and could not be completed.\n\n` +
        `**Error:** ${error.message}\n` +
        `**Analysis ID:** \`${trackingId}\`\n` +
        `**Time:** ${new Date().toISOString()}\n\n` +
        `Please try clicking "AI Review" again or contact the administrator if this persists.`
      );

      await githubService.updateCheckRun(owner, repo, checkRun.id, {
        status: 'completed',
        conclusion: 'failure',
        output: {
          title: `AI Code Review Failed - PR #${pullNumber}`,
          summary: `❌ Analysis failed for PR #${pullNumber}: ${error.message}\n\n**Tracking ID:** ${trackingId}`,
        }
      });

    } catch (postError) {
      logger.error('Error posting failure message:', postError);
    }
  }

  // Direct processing fallback
  async processAIReviewDirect(repository, pullRequest, triggeredBy) {
    const owner = repository.owner.login;
    const repo = repository.name;
    const pullNumber = pullRequest.number;
    const trackingId = generateTrackingId();

    try {
      const progressComment = await githubService.postGeneralComment(
        owner,
        repo,
        pullNumber,
        `🤖 **AI Review In Progress for PR #${pullNumber}**\n\n🔄 Analysis started by @${triggeredBy}\n\n**Status:** Processing...\n**Analysis ID:** \`${trackingId}\``
      );

      const prData = await githubService.getPullRequestData(owner, repo, pullNumber);
      
      if (!prData.files || prData.files.length === 0) {
        await githubService.deleteComment(owner, repo, progressComment.id);
        const analysis = this.createNoAnalysisResponse(prData, trackingId);
        await githubService.postStructuredReviewComment(owner, repo, pullNumber, analysis);
        return;
      }

      let analysis;
      try {
        analysis = await aiService.analyzePullRequest(prData, prData.comments);
      } catch (aiError) {
        analysis = this.createFallbackAnalysis(prData, aiError.message, trackingId);
      }

      await githubService.deleteComment(owner, repo, progressComment.id);
      await githubService.postStructuredReviewComment(owner, repo, pullNumber, analysis);

    } catch (error) {
      await githubService.postGeneralComment(
        owner,
        repo,
        pullNumber,
        `🚨 **Unable to Complete AI Review for PR #${pullNumber}**\n\nError: ${error.message}\n\nTriggered by: @${triggeredBy}\nTracking ID: \`${trackingId}\``
      );
    }
  }

  // Create response for no analysis
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
  }

  // Validate webhook payload
  validateWebhookPayload(payload, event) {
    if (!payload) throw new Error('Empty webhook payload');
    if (event === 'pull_request' && !payload.pull_request) throw new Error('Invalid pull request payload');
    if (event === 'check_run' && !payload.check_run) throw new Error('Invalid check run payload');
    if (event === 'issue_comment' && (!payload.comment || !payload.issue)) throw new Error('Invalid issue comment payload');
    if (!payload.repository) throw new Error('Missing repository information');
    return true;
  }

  // Get processing status
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
    };
  }

  // Clean old processing entries
  cleanProcessingQueue() {
    const now = Date.now();
    const maxAge = 15 * 60 * 1000;
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
  }

  // Graceful shutdown
  async shutdown() {
    logger.info('Shutting down webhook service...');
    
    const maxWaitTime = 30000;
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

const webhookService = new WebhookService();
setInterval(() => webhookService.cleanProcessingQueue(), 5 * 60 * 1000);
module.exports = webhookService;