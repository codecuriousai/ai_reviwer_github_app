// src/services/webhook.service.js - Complete Implementation

const githubService = require('./github.service');
const aiService = require('./ai.service');
const logger = require('../utils/logger');
const { delay, generateTrackingId } = require('../utils/helpers');

class WebhookService {
  constructor() {
    this.processingQueue = new Map(); // Prevent duplicate processing
    this.maxConcurrentReviews = 5;
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

  // Handle pull request events (opened, reopened, synchronize)
  async handlePullRequestEvent(payload) {
    const { action, pull_request, repository } = payload;
    
    // Only process relevant actions
    const relevantActions = ['opened', 'reopened', 'synchronize'];
    if (!relevantActions.includes(action)) {
      logger.info(`Ignoring PR action: ${action}`);
      return;
    }

    // Skip draft PRs unless specifically configured
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
      logger.warn(`Max concurrent reviews reached (${this.maxConcurrentReviews}). Queuing PR #${pull_request.number}`);
      // You could implement a proper queue here
      await delay(30000); // Wait 30 seconds and try again
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

  // Handle pull request review events
  async handlePullRequestReviewEvent(payload) {
    const { action, review, pull_request, repository } = payload;
    
    if (action === 'submitted' && review.state === 'commented') {
      logger.info(`New review submitted for PR #${pull_request.number} by ${review.user.login}`);
      
      // Don't re-analyze our own AI reviews
      if (review.user.type === 'Bot') {
        logger.info('Ignoring bot review');
        return;
      }
      
      // Wait a bit to allow for multiple comments to be posted
      await delay(30000); // 30 seconds
      
      // Re-analyze with new review context
      const trackingId = generateTrackingId();
      await this.processCodeReview(repository, pull_request, true, trackingId);
    }
  }

  // Handle individual review comments
  async handlePullRequestReviewCommentEvent(payload) {
    const { action, comment, pull_request, repository } = payload;
    
    if (action === 'created') {
      logger.info(`New review comment on PR #${pull_request.number}`, {
        author: comment.user.login,
        file: comment.path,
        line: comment.line,
      });
      
      // Don't respond to our own comments
      if (comment.user.type === 'Bot') {
        return;
      }
      
      // Trigger re-analysis after delay to collect multiple comments
      setTimeout(async () => {
        const trackingId = generateTrackingId();
        await this.processCodeReview(repository, pull_request, true, trackingId);
      }, 60000); // 1 minute delay
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
        await githubService.postGeneralComment(
          owner,
          repo,
          pullNumber,
          '🤖 **AI Code Review**: No code files found to analyze in this PR.'
        );
        return;
      }

      // Step 2: Post initial analysis comment (if not re-analysis)
      if (!isReAnalysis) {
        await githubService.postGeneralComment(
          owner,
          repo,
          pullNumber,
          `🤖 **AI Code Review Started**\n\n` +
          `Analyzing ${prData.files.length} files using SonarQube standards...\n` +
          `📊 Changes: +${prData.pr.additions} -${prData.pr.deletions}\n` +
          `⏱️ Analysis ID: \`${trackingId}\`\n\n` +
          `*This may take 1-2 minutes depending on the size of changes.*`
        );
      }

      // Step 3: AI Analysis
      const startTime = Date.now();
      const analysis = await aiService.analyzePullRequest(prData, prData.comments);
      const analysisTime = Date.now() - startTime;

      logger.info(`Analysis completed in ${analysisTime}ms`, {
        trackingId,
        issuesFound: analysis.summary.totalIssues,
        rating: analysis.summary.overallRating,
      });

      // Step 4: Format and post review comments
      await this.postAnalysisResults(owner, repo, pullNumber, analysis, isReAnalysis, trackingId);

      // Step 5: Log completion
      logger.info(`Code review completed for PR #${pullNumber}`, {
        trackingId,
        processingTime: Date.now() - startTime,
        recommendation: analysis.summary.recommendApproval ? 'APPROVE' : 'REQUEST_CHANGES',
      });

    } catch (error) {
      logger.error(`Error processing code review for PR #${pullNumber}:`, error, { trackingId });
      
      // Post error comment
      await githubService.postGeneralComment(
        owner,
        repo,
        pullNumber,
        `🚨 **AI Code Review Error**\n\n` +
        `Failed to analyze the code changes: ${error.message}\n\n` +
        `**Tracking ID**: \`${trackingId}\`\n` +
        `**Error Time**: ${new Date().toISOString()}\n\n` +
        `Please contact the administrator or try again later.\n` +
        `*If this persists, the issue may be related to API limits or service availability.*`
      );
    }
  }

  // Post analysis results to GitHub
  async postAnalysisResults(owner, repo, pullNumber, analysis, isReAnalysis, trackingId) {
    try {
      const { summary, issues } = analysis;
      
      // Create inline comments for specific issues
      const inlineComments = githubService.formatInlineComments(issues);
      
      // Create enhanced review body
      const reviewBody = this.createEnhancedReviewBody(analysis, trackingId, isReAnalysis);
      
      if (isReAnalysis) {
        // For re-analysis, post as a general comment
        await githubService.postGeneralComment(
          owner,
          repo,
          pullNumber,
          reviewBody
        );
      } else {
        // For initial analysis, create a proper review
        if (inlineComments.length > 0 && inlineComments.length <= 10) {
          // Post as review with inline comments (limit to 10 to avoid spam)
          // await githubService.postReviewComment(owner, repo, pullNumber, {
          //   inlineComments: inlineComments.slice(0, 10),
          //   summary: analysis,
          // });
          await githubService.postReviewComment(owner, repo, pullNumber, analysis);
        } else {
          // Post general comment if too many inline comments or none
          await githubService.postGeneralComment(owner, repo, pullNumber, reviewBody);
        }
      }

      // Post critical issues as separate comments for visibility
      await this.postCriticalIssuesAlerts(owner, repo, pullNumber, issues, trackingId);
      
      // Post security summary if security issues found
      await this.postSecuritySummary(owner, repo, pullNumber, issues, trackingId);
      
    } catch (error) {
      logger.error('Error posting analysis results:', error, { trackingId });
      throw error;
    }
  }

  // Create enhanced review body with better formatting
  createEnhancedReviewBody(analysis, trackingId, isReAnalysis) {
    const { summary, issues, reviewerCoverage, recommendations, complexity } = analysis;
    
    let body = isReAnalysis 
      ? `## 🔄 Updated AI Code Review\n\n` 
      : `## 🤖 AI Code Review Summary\n\n`;
    
    // Add tracking info
    body += `**Analysis ID**: \`${trackingId}\`\n`;
    body += `**Completed**: ${new Date().toISOString()}\n\n`;
    
    // Overall summary with emoji indicators
    const ratingEmoji = {
      'EXCELLENT': '🟢',
      'GOOD': '🟡', 
      'NEEDS_IMPROVEMENT': '🟠',
      'POOR': '🔴'
    };
    
    body += `**Overall Rating:** ${ratingEmoji[summary.overallRating]} ${summary.overallRating}\n`;
    body += `**Recommendation:** ${summary.recommendApproval ? '✅ Approve' : '❌ Request Changes'}\n\n`;
    
    // Issues breakdown with visual indicators
    body += `### 📊 Issues Found\n`;
    body += `| Severity | Count | Status |\n`;
    body += `|----------|-------|--------|\n`;
    body += `| 🚨 Critical | ${summary.criticalIssues} | ${summary.criticalIssues > 0 ? '❌ Must Fix' : '✅ None'} |\n`;
    body += `| 🔴 High | ${summary.highIssues} | ${summary.highIssues > 0 ? '⚠️ Should Fix' : '✅ None'} |\n`;
    body += `| 🟡 Medium | ${summary.mediumIssues} | ${summary.mediumIssues > 0 ? '💡 Consider' : '✅ None'} |\n`;
    body += `| 🔵 Low | ${summary.lowIssues} | ${summary.lowIssues > 0 ? 'ℹ️ Optional' : '✅ None'} |\n`;
    body += `| **Total** | **${summary.totalIssues}** | - |\n\n`;

    // Complexity assessment
    if (complexity) {
      body += `### 🎯 Complexity Assessment\n`;
      body += `- **Files Changed**: ${complexity.filesChanged}\n`;
      body += `- **Total Changes**: ${complexity.totalChanges}\n`;
      body += `- **Risk Level**: ${complexity.riskLevel}\n\n`;
    }

    // Reviewer coverage analysis
    if (reviewerCoverage) {
      body += `### 👥 Review Coverage Analysis\n`;
      body += `- **Issues found by reviewer**: ${reviewerCoverage.issuesFoundByReviewer}\n`;
      body += `- **Issues missed by reviewer**: ${reviewerCoverage.issuesMissedByReviewer}\n`;
      body += `- **Additional issues found**: ${reviewerCoverage.additionalIssuesFound}\n`;
      body += `- **Review quality**: ${reviewerCoverage.reviewQuality}\n\n`;
    }

    // Top issues summary (limit to 5)
    const topIssues = issues
      .filter(issue => ['CRITICAL', 'HIGH'].includes(issue.severity))
      .slice(0, 5);
      
    if (topIssues.length > 0) {
      body += `### 🔍 Top Issues\n`;
      topIssues.forEach((issue, index) => {
        const emoji = issue.severity === 'CRITICAL' ? '🚨' : '🔴';
        body += `${index + 1}. ${emoji} **${issue.file}:${issue.line}** - ${issue.title}\n`;
      });
      body += `\n`;
    }

    // Recommendations
    if (recommendations && recommendations.length > 0) {
      body += `### 💡 Key Recommendations\n`;
      recommendations.slice(0, 5).forEach(rec => {
        body += `- ${rec}\n`;
      });
      body += `\n`;
    }

    // Footer with links and info
    body += `---\n`;
    body += `*🔧 Powered by AI Code Reviewer with SonarQube Standards*\n`;
    body += `*📈 Analysis took ${this.activeReviews > 1 ? 'longer due to concurrent reviews' : 'standard time'}*\n`;
    
    if (summary.totalIssues === 0) {
      body += `\n🎉 **Great job!** No issues found in this PR.`;
    } else if (summary.criticalIssues > 0) {
      body += `\n⚠️ **Action Required**: Please address critical issues before merging.`;
    }
    
    return body;
  }

  // Post critical issues as separate urgent comments
  async postCriticalIssuesAlerts(owner, repo, pullNumber, issues, trackingId) {
    const criticalIssues = issues.filter(issue => issue.severity === 'CRITICAL');
    
    if (criticalIssues.length === 0) return;

    // Post a summary comment for multiple critical issues
    if (criticalIssues.length > 1) {
      let alertComment = `🚨 **${criticalIssues.length} CRITICAL ISSUES DETECTED**\n\n`;
      alertComment += `These issues must be addressed before merging:\n\n`;
      
      criticalIssues.slice(0, 5).forEach((issue, index) => {
        alertComment += `${index + 1}. **${issue.file}:${issue.line}** - ${issue.title}\n`;
        alertComment += `   └ ${issue.description}\n\n`;
      });
      
      if (criticalIssues.length > 5) {
        alertComment += `... and ${criticalIssues.length - 5} more critical issues.\n\n`;
      }
      
      alertComment += `**Tracking ID**: \`${trackingId}\``;
      
      await githubService.postGeneralComment(owner, repo, pullNumber, alertComment);
    }

    // For single critical issue, post detailed comment
    if (criticalIssues.length === 1) {
      const issue = criticalIssues[0];
      const comment = `🚨 **CRITICAL ISSUE DETECTED**\n\n` +
        `**File**: ${issue.file}:${issue.line}\n` +
        `**Issue**: ${issue.title}\n` +
        `**Type**: ${issue.type}\n\n` +
        `**Description**:\n${issue.description}\n\n` +
        `**Required Action**: ${issue.suggestion}\n\n` +
        `${issue.sonarRule ? `**SonarQube Rule**: ${issue.sonarRule}\n\n` : ''}` +
        `**Tracking ID**: \`${trackingId}\``;

      await githubService.postGeneralComment(owner, repo, pullNumber, comment);
    }
  }

  // Post security-specific summary if security issues found
  async postSecuritySummary(owner, repo, pullNumber, issues, trackingId) {
    const securityIssues = issues.filter(issue => issue.type === 'VULNERABILITY');
    
    if (securityIssues.length === 0) return;

    let securityComment = `🔒 **SECURITY ANALYSIS SUMMARY**\n\n`;
    securityComment += `Found ${securityIssues.length} security-related issue(s):\n\n`;
    
    const severityGroups = {
      CRITICAL: securityIssues.filter(i => i.severity === 'CRITICAL'),
      HIGH: securityIssues.filter(i => i.severity === 'HIGH'),
      MEDIUM: securityIssues.filter(i => i.severity === 'MEDIUM'),
      LOW: securityIssues.filter(i => i.severity === 'LOW'),
    };

    Object.entries(severityGroups).forEach(([severity, issueList]) => {
      if (issueList.length > 0) {
        const emoji = severity === 'CRITICAL' ? '🚨' : 
                     severity === 'HIGH' ? '🔴' : 
                     severity === 'MEDIUM' ? '🟡' : '🔵';
        
        securityComment += `**${emoji} ${severity} (${issueList.length})**:\n`;
        issueList.forEach(issue => {
          securityComment += `- ${issue.file}:${issue.line} - ${issue.title}\n`;
        });
        securityComment += `\n`;
      }
    });

    securityComment += `🛡️ **Security Recommendations**:\n`;
    securityComment += `- Review all security findings before merging\n`;
    securityComment += `- Consider running additional security scans\n`;
    securityComment += `- Validate input sanitization and authentication\n\n`;
    securityComment += `**Tracking ID**: \`${trackingId}\``;

    await githubService.postGeneralComment(owner, repo, pullNumber, securityComment);
  }

  // Handle webhook validation
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

    // Validate repository data
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
          duration: now - value.startTime,
        });
      }
    }
    
    if (cleaned > 0) {
      logger.info(`Cleaned ${cleaned} stale processing entries`);
    }
  }

  // Graceful shutdown handler
  async shutdown() {
    logger.info('Shutting down webhook service...');
    
    // Wait for active reviews to complete (with timeout)
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