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

  // Post individual AI finding as inline comment with proper line validation
  async postIndividualComment(owner, repo, pullNumber, finding, triggeredBy) {
    try {
      logger.info(`Posting individual AI comment for ${finding.file}:${finding.line}`, {
        pullNumber,
        findingId: finding.id,
        triggeredBy
      });

      // Get the PR data for commit SHA
      const { data: pr } = await githubService.octokit.rest.pulls.get({
        owner,
        repo,
        pull_number: pullNumber,
      });

      // Validate and potentially adjust the line number
      let commentLine = finding.line;
      let lineAdjusted = false;
      let originalLine = finding.line;

      // First check if the line is valid for commenting
      const isValidLine = await githubService.validateCommentableLine(owner, repo, pullNumber, finding.file, finding.line);

      if (!isValidLine) {
        // Try to find a nearby commentable line
        const adjustedLine = await githubService.findCommentableLine(owner, repo, pullNumber, finding.file, finding.line);

        if (!adjustedLine) {
          throw new Error(`Cannot find a commentable line near line ${finding.line} in file ${finding.file}. This line may not be part of the PR changes.`);
        }

        commentLine = adjustedLine;
        lineAdjusted = true;

        logger.info(`Adjusted comment line from ${originalLine} to ${commentLine} for ${finding.file}`);
      }

      // Format comment with line adjustment info if needed
      const commentBody = this.formatInlineCommentWithAdjustment(finding, lineAdjusted, originalLine, commentLine);

      // Create the review comment
      const { data: comment } = await githubService.octokit.rest.pulls.createReviewComment({
        owner,
        repo,
        pull_number: pullNumber,
        body: commentBody,
        commit_id: pr.head.sha,
        path: finding.file,
        line: commentLine,
      });

      // Mark as posted and update line info
      finding.posted = true;
      finding.commentId = comment.id;
      if (lineAdjusted) {
        finding.adjustedLine = commentLine;
        finding.originalLine = originalLine;
      }

      // Post confirmation with adjustment info
      let confirmationMessage = `✅ AI finding posted as inline comment by @${triggeredBy}\n\n`;
      confirmationMessage += `**File:** ${finding.file}:${commentLine}\n`;

      if (lineAdjusted) {
        confirmationMessage += `**Note:** Comment posted on line ${commentLine} (nearest commentable line to detected issue on line ${originalLine})\n`;
      }

      confirmationMessage += `**Issue:** ${finding.issue}\n`;
      confirmationMessage += `**Comment ID:** ${comment.id}`;

      await githubService.postGeneralComment(owner, repo, pullNumber, confirmationMessage);

      logger.info(`Individual AI comment posted successfully`, {
        pullNumber,
        commentId: comment.id,
        file: finding.file,
        finalLine: commentLine,
        originalLine: originalLine,
        adjusted: lineAdjusted
      });

    } catch (error) {
      logger.error('Error posting individual comment:', error);

      // Post detailed error message
      await githubService.postGeneralComment(
        owner, repo, pullNumber,
        `❌ Failed to post AI comment for ${finding.file}:${finding.line}\n\n` +
        `**Error:** ${error.message}\n` +
        `**Triggered by:** @${triggeredBy}\n` +
        `**Suggestion:** This line may not be part of the PR changes. Try running a new AI review after making more changes to this file.`
      );

      throw error;
    }
  }

  // Post all pending AI comments with line validation and adjustment tracking
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
      const adjustedLines = [];

      // Process each finding with line validation
      for (const finding of pendingComments.findings) {
        if (finding.posted) {
          successCount++;
          continue;
        }

        try {
          let commentLine = finding.line;
          let lineAdjusted = false;
          const originalLine = finding.line;

          // Validate the line number
          const isValidLine = await githubService.validateCommentableLine(owner, repo, pullNumber, finding.file, finding.line);

          if (!isValidLine) {
            const adjustedLine = await githubService.findCommentableLine(owner, repo, pullNumber, finding.file, finding.line);

            if (!adjustedLine) {
              throw new Error(`No commentable line found near line ${finding.line} in ${finding.file}`);
            }

            commentLine = adjustedLine;
            lineAdjusted = true;

            adjustedLines.push({
              file: finding.file,
              originalLine: originalLine,
              adjustedLine: commentLine
            });

            logger.info(`Line adjusted for ${finding.file}: ${originalLine} -> ${commentLine}`);
          }

          // Format and post comment
          const commentBody = this.formatInlineCommentWithAdjustment(finding, lineAdjusted, originalLine, commentLine);

          const { data: comment } = await githubService.octokit.rest.pulls.createReviewComment({
            owner,
            repo,
            pull_number: pullNumber,
            body: commentBody,
            commit_id: pr.head.sha,
            path: finding.file,
            line: commentLine,
          });

          // Update finding info
          finding.posted = true;
          finding.commentId = comment.id;
          if (lineAdjusted) {
            finding.adjustedLine = commentLine;
            finding.originalLine = originalLine;
          }

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

      // Post comprehensive summary
      const summaryMessage = this.formatBulkSummaryWithAdjustments(
        successCount,
        errorCount,
        errors,
        adjustedLines,
        triggeredBy
      );

      await githubService.postGeneralComment(owner, repo, pullNumber, summaryMessage);

      logger.info(`Bulk comment posting completed`, {
        pullNumber,
        successCount,
        errorCount,
        adjustedCount: adjustedLines.length,
        triggeredBy
      });

    } catch (error) {
      logger.error('Error posting all comments:', error);

      await githubService.postGeneralComment(
        owner, repo, pullNumber,
        `❌ Failed to post all AI comments\n\n` +
        `**Error:** ${error.message}\n` +
        `**Triggered by:** @${triggeredBy}\n` +
        `**Time:** ${new Date().toISOString()}\n\n` +
        `**Suggestion:** Some files may not have changes in this PR. Try making additional changes and running AI review again.`
      );

      throw error;
    }
  }

  // NEW: Format inline comment with line adjustment information
  formatInlineCommentWithAdjustment(finding, lineAdjusted, originalLine, commentLine) {
    const severityEmoji = this.getSeverityEmoji(finding.severity);
    const categoryEmoji = this.getCategoryEmoji(finding.category);

    let comment = `${severityEmoji} ${categoryEmoji} **AI Code Review Finding**\n\n`;
    comment += `**Issue:** ${finding.issue}\n\n`;
    comment += `**Severity:** ${finding.severity}\n`;
    comment += `**Category:** ${finding.category}\n\n`;

    // Add line adjustment note if applicable
    if (lineAdjusted) {
      comment += `**📍 Line Note:** This issue was detected near line ${originalLine} but is commented on line ${commentLine} (the nearest line that can receive comments in this PR).\n\n`;
    }

    comment += `**Suggestion:**\n${finding.suggestion}\n\n`;
    comment += `---\n`;
    comment += `*🤖 Posted by AI Code Reviewer | Finding ID: \`${finding.id}\`*`;

    return comment;
  }

  // NEW: Enhanced bulk summary with line adjustment reporting
  formatBulkSummaryWithAdjustments(successCount, errorCount, errors, adjustedLines, triggeredBy) {
    let summary = `🤖 **All AI Comments Posted** by @${triggeredBy}\n\n`;
    summary += `✅ **Successfully posted:** ${successCount} comments\n`;

    if (adjustedLines.length > 0) {
      summary += `📍 **Line adjustments:** ${adjustedLines.length} comments moved to nearby lines\n`;
    }

    if (errorCount > 0) {
      summary += `❌ **Failed to post:** ${errorCount} comments\n\n`;
      summary += `**Errors:**\n`;
      errors.forEach(error => {
        summary += `• ${error}\n`;
      });
      summary += `\n`;
    }

    if (adjustedLines.length > 0) {
      summary += `**📍 Line Adjustments Made:**\n`;
      summary += `Some comments were moved to nearby lines because the original lines are not part of the PR changes:\n\n`;
      adjustedLines.forEach(adj => {
        summary += `• \`${adj.file}\`: Line ${adj.originalLine} → Line ${adj.adjustedLine}\n`;
      });
      summary += `\n*This ensures comments appear on code that's actually changed in this PR.*\n\n`;
    }

    summary += `📝 **Location:** All comments posted as inline review comments on respective code lines\n`;
    summary += `🕒 **Posted at:** ${new Date().toISOString()}`;

    return summary;
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