// src/services/interactive-comment.service.js - Handle Interactive AI Comment Posting

const githubService = require('./github.service');
const logger = require('../utils/logger');
const { generateTrackingId } = require('../utils/helpers');

class InteractiveCommentService {
  constructor() {
    this.pendingComments = new Map(); // Store comments for each PR
    this.commentActions = new Map(); // Track comment action states
  }

  // Store AI findings for interactive commenting
  storePendingComments(owner, repo, pullNumber, detailedFindings, trackingId) {
    const prKey = `${owner}/${repo}#${pullNumber}`;
    
    // Filter only issues that can be posted as inline comments (have file/line info)
    const postableFindings = detailedFindings.filter(finding => 
      finding.file && 
      finding.file !== 'unknown-file' && 
      finding.line && 
      finding.line > 0 &&
      finding.file !== 'AI_ANALYSIS_ERROR'
    );

    const commentData = {
      owner,
      repo,
      pullNumber,
      trackingId,
      findings: postableFindings.map((finding, index) => ({
        id: `${trackingId}-finding-${index}`,
        file: finding.file,
        line: finding.line,
        issue: finding.issue,
        severity: finding.severity,
        category: finding.category,
        suggestion: finding.suggestion,
        posted: false,
        commentId: null
      })),
      allPosted: false,
      createdAt: Date.now()
    };

    this.pendingComments.set(prKey, commentData);
    
    logger.info(`Stored ${postableFindings.length} pending comments for ${prKey}`, { 
      trackingId,
      totalFindings: detailedFindings.length,
      postableFindings: postableFindings.length
    });

    return commentData;
  }

  // Create interactive buttons for AI findings
  createInteractiveButtons(detailedFindings, trackingId) {
    if (!detailedFindings || detailedFindings.length === 0) {
      return '';
    }

    // Filter postable findings (ones with valid file/line info)
    const postableFindings = detailedFindings.filter(finding => 
      finding.file && 
      finding.file !== 'unknown-file' && 
      finding.line && 
      finding.line > 0 &&
      finding.file !== 'AI_ANALYSIS_ERROR'
    );

    if (postableFindings.length === 0) {
      return '\n\n*No issues found that can be posted as inline comments.*';
    }

    let buttonsSection = '\n\n📝 **INTERACTIVE COMMENTING:**\n';
    buttonsSection += '*(Click buttons below to post AI findings as inline comments)*\n\n';

    // Individual comment buttons for each finding
    postableFindings.forEach((finding, index) => {
      const findingId = `${trackingId}-finding-${index}`;
      const severityEmoji = this.getSeverityEmoji(finding.severity);
      const categoryEmoji = this.getCategoryEmoji(finding.category);
      
      buttonsSection += `${index + 1}. ${severityEmoji} ${categoryEmoji} **${finding.file}:${finding.line}**\n`;
      buttonsSection += `   └─ ${finding.issue}\n`;
      buttonsSection += `   └─ [📝 Comment](https://github.com/comment-action?id=${findingId}) | `;
      buttonsSection += `*${finding.severity} ${finding.category}*\n\n`;
    });

    // Post all comments button
    buttonsSection += `🔄 **[📝 Post All Comments](https://github.com/comment-action?id=${trackingId}-all)** `;
    buttonsSection += `*(Post all ${postableFindings.length} findings as inline comments)*\n\n`;

    buttonsSection += `---\n`;
    buttonsSection += `*💡 Tip: Individual comments will be posted as line-specific review comments*`;

    return buttonsSection;
  }

  // Handle comment action from button clicks via issue comments
  async handleCommentAction(repository, pullNumber, commentBody, author) {
    try {
      const owner = repository.owner.login;
      const repo = repository.name;
      const prKey = `${owner}/${repo}#${pullNumber}`;

      // Check for comment action triggers
      const commentActionMatch = commentBody.match(/\/ai-comment\s+(.+)/);
      if (!commentActionMatch) {
        return false; // Not a comment action
      }

      const actionId = commentActionMatch[1].trim();
      logger.info(`Comment action triggered: ${actionId}`, { pullNumber, author });

      const pendingComments = this.pendingComments.get(prKey);
      if (!pendingComments) {
        await githubService.postGeneralComment(
          owner, repo, pullNumber,
          `❌ No pending AI comments found for this PR. Please run AI review first.`
        );
        return true;
      }

      // Handle "post all" action
      if (actionId.endsWith('-all')) {
        await this.postAllComments(owner, repo, pullNumber, pendingComments, author);
        return true;
      }

      // Handle individual comment posting
      const finding = pendingComments.findings.find(f => f.id === actionId);
      if (!finding) {
        await githubService.postGeneralComment(
          owner, repo, pullNumber,
          `❌ AI finding with ID "${actionId}" not found.`
        );
        return true;
      }

      if (finding.posted) {
        await githubService.postGeneralComment(
          owner, repo, pullNumber,
          `ℹ️ This AI finding has already been posted as a comment.`
        );
        return true;
      }

      await this.postIndividualComment(owner, repo, pullNumber, finding, author);
      return true;

    } catch (error) {
      logger.error('Error handling comment action:', error);
      return false;
    }
  }

  // Post individual AI finding as inline comment
  async postIndividualComment(owner, repo, pullNumber, finding, triggeredBy) {
    try {
      logger.info(`Posting individual AI comment for ${finding.file}:${finding.line}`, {
        pullNumber,
        findingId: finding.id,
        triggeredBy
      });

      // Get the commit SHA for the file
      const { data: pr } = await githubService.octokit.rest.pulls.get({
        owner,
        repo,
        pull_number: pullNumber,
      });

      const commentBody = this.formatInlineComment(finding);

      // Post as inline review comment
      const { data: comment } = await githubService.octokit.rest.pulls.createReviewComment({
        owner,
        repo,
        pull_number: pullNumber,
        body: commentBody,
        commit_id: pr.head.sha,
        path: finding.file,
        line: finding.line,
      });

      // Mark as posted
      finding.posted = true;
      finding.commentId = comment.id;

      // Post confirmation
      await githubService.postGeneralComment(
        owner, repo, pullNumber,
        `✅ AI finding posted as inline comment by @${triggeredBy}\n\n` +
        `**File:** ${finding.file}:${finding.line}\n` +
        `**Issue:** ${finding.issue}\n` +
        `**Comment ID:** ${comment.id}`
      );

      logger.info(`Individual AI comment posted successfully`, {
        pullNumber,
        commentId: comment.id,
        file: finding.file,
        line: finding.line
      });

    } catch (error) {
      logger.error('Error posting individual comment:', error);
      
      // Post error message
      await githubService.postGeneralComment(
        owner, repo, pullNumber,
        `❌ Failed to post AI comment for ${finding.file}:${finding.line}\n\n` +
        `**Error:** ${error.message}\n` +
        `**Triggered by:** @${triggeredBy}`
      );
      
      throw error;
    }
  }

  // Post all pending AI comments at once
  async postAllComments(owner, repo, pullNumber, pendingComments, triggeredBy) {
    try {
      logger.info(`Posting all AI comments for PR #${pullNumber}`, {
        totalFindings: pendingComments.findings.length,
        triggeredBy
      });

      if (pendingComments.allPosted) {
        await githubService.postGeneralComment(
          owner, repo, pullNumber,
          `ℹ️ All AI comments have already been posted for this PR.`
        );
        return;
      }

      // Get PR data for commit SHA
      const { data: pr } = await githubService.octokit.rest.pulls.get({
        owner,
        repo,
        pull_number: pullNumber,
      });

      let successCount = 0;
      let errorCount = 0;
      const errors = [];

      // Post each finding as inline comment
      for (const finding of pendingComments.findings) {
        if (finding.posted) {
          successCount++;
          continue;
        }

        try {
          const commentBody = this.formatInlineComment(finding);

          const { data: comment } = await githubService.octokit.rest.pulls.createReviewComment({
            owner,
            repo,
            pull_number: pullNumber,
            body: commentBody,
            commit_id: pr.head.sha,
            path: finding.file,
            line: finding.line,
          });

          finding.posted = true;
          finding.commentId = comment.id;
          successCount++;

          // Small delay to avoid rate limiting
          await new Promise(resolve => setTimeout(resolve, 200));

        } catch (error) {
          logger.error(`Error posting comment for ${finding.file}:${finding.line}:`, error);
          errorCount++;
          errors.push(`${finding.file}:${finding.line} - ${error.message}`);
        }
      }

      // Mark all as posted
      pendingComments.allPosted = true;

      // Post summary comment
      let summaryMessage = `🤖 **All AI Comments Posted** by @${triggeredBy}\n\n`;
      summaryMessage += `✅ **Successfully posted:** ${successCount} comments\n`;
      
      if (errorCount > 0) {
        summaryMessage += `❌ **Failed to post:** ${errorCount} comments\n\n`;
        summaryMessage += `**Errors:**\n`;
        errors.forEach(error => {
          summaryMessage += `• ${error}\n`;
        });
      }

      summaryMessage += `\n📍 **Location:** All comments posted as inline review comments on respective code lines\n`;
      summaryMessage += `🕒 **Posted at:** ${new Date().toISOString()}`;

      await githubService.postGeneralComment(owner, repo, pullNumber, summaryMessage);

      logger.info(`Bulk comment posting completed`, {
        pullNumber,
        successCount,
        errorCount,
        triggeredBy
      });

    } catch (error) {
      logger.error('Error posting all comments:', error);
      
      await githubService.postGeneralComment(
        owner, repo, pullNumber,
        `❌ Failed to post all AI comments\n\n` +
        `**Error:** ${error.message}\n` +
        `**Triggered by:** @${triggeredBy}\n` +
        `**Time:** ${new Date().toISOString()}`
      );
      
      throw error;
    }
  }

  // Format inline comment for specific finding
  formatInlineComment(finding) {
    const severityEmoji = this.getSeverityEmoji(finding.severity);
    const categoryEmoji = this.getCategoryEmoji(finding.category);

    let comment = `${severityEmoji} ${categoryEmoji} **AI Code Review Finding**\n\n`;
    comment += `**Issue:** ${finding.issue}\n\n`;
    comment += `**Severity:** ${finding.severity}\n`;
    comment += `**Category:** ${finding.category}\n\n`;
    comment += `**Suggestion:**\n${finding.suggestion}\n\n`;
    comment += `---\n`;
    comment += `*🤖 Posted by AI Code Reviewer | Finding ID: \`${finding.id}\`*`;

    return comment;
  }

  // Get pending comments for a PR
  getPendingComments(owner, repo, pullNumber) {
    const prKey = `${owner}/${repo}#${pullNumber}`;
    return this.pendingComments.get(prKey);
  }

  // Clean old pending comments (cleanup job)
  cleanOldPendingComments() {
    const maxAge = 24 * 60 * 60 * 1000; // 24 hours
    const now = Date.now();
    let cleaned = 0;

    for (const [prKey, data] of this.pendingComments.entries()) {
      if (now - data.createdAt > maxAge) {
        this.pendingComments.delete(prKey);
        cleaned++;
      }
    }

    if (cleaned > 0) {
      logger.info(`Cleaned ${cleaned} old pending comment entries`);
    }
  }

  // Get stats about pending comments
  getStats() {
    const stats = {
      totalPRs: this.pendingComments.size,
      totalPendingFindings: 0,
      totalPostedFindings: 0,
      oldestEntry: null,
      newestEntry: null
    };

    for (const [prKey, data] of this.pendingComments.entries()) {
      stats.totalPendingFindings += data.findings.filter(f => !f.posted).length;
      stats.totalPostedFindings += data.findings.filter(f => f.posted).length;
      
      if (!stats.oldestEntry || data.createdAt < stats.oldestEntry) {
        stats.oldestEntry = data.createdAt;
      }
      
      if (!stats.newestEntry || data.createdAt > stats.newestEntry) {
        stats.newestEntry = data.createdAt;
      }
    }

    return stats;
  }

  // Helper: Get severity emoji
  getSeverityEmoji(severity) {
    const emojiMap = {
      'BLOCKER': '🚫',
      'CRITICAL': '🔴',
      'MAJOR': '🟡',
      'MINOR': '🔵',
      'INFO': 'ℹ️'
    };
    return emojiMap[severity] || 'ℹ️';
  }

  // Helper: Get category emoji
  getCategoryEmoji(category) {
    const emojiMap = {
      'BUG': '🐛',
      'VULNERABILITY': '🔒',
      'SECURITY_HOTSPOT': '⚠️',
      'CODE_SMELL': '💨'
    };
    return emojiMap[category] || '💨';
  }

  // Generate comment action instructions
  generateCommentInstructions(trackingId, findingsCount) {
    if (findingsCount === 0) {
      return '';
    }

    let instructions = '\n\n📋 **COMMENT POSTING INSTRUCTIONS:**\n';
    instructions += `To post AI findings as inline comments, use these commands:\n\n`;
    
    instructions += `**Individual Comments:**\n`;
    instructions += `• \`/ai-comment ${trackingId}-finding-0\` (for finding #1)\n`;
    instructions += `• \`/ai-comment ${trackingId}-finding-1\` (for finding #2)\n`;
    instructions += `• ... and so on for each finding\n\n`;
    
    instructions += `**Post All Comments:**\n`;
    instructions += `• \`/ai-comment ${trackingId}-all\` (posts all findings at once)\n\n`;
    
    instructions += `*💡 Comments will be posted as line-specific review comments on the affected code.*`;

    return instructions;
  }
}

module.exports = new InteractiveCommentService();