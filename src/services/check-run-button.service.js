// src/services/check-run-button.service.js - Interactive Button Management for Check Runs

const githubService = require('./github.service');
const logger = require('../utils/logger');
const { generateTrackingId, truncateText } = require('../utils/helpers');

class CheckRunButtonService {
  constructor() {
    this.activeCheckRuns = new Map(); // Store active check runs with button data
  }

  // Create enhanced check run with interactive buttons for each finding
  async createInteractiveCheckRun(owner, repo, pullNumber, analysis, headSha) {
    try {
      const trackingId = analysis.trackingId || generateTrackingId();
      analysis.trackingId = trackingId;

      logger.info(`Creating interactive check run for PR #${pullNumber}`, { trackingId });

      // Filter postable findings (ones that can be posted as inline comments)
      const postableFindings = this.getPostableFindings(analysis.detailedFindings || []);
      
      // Create check run with completion status and interactive buttons
      const checkRunData = {
        name: 'AI Code Review',
        head_sha: headSha,
        status: 'completed',
        conclusion: this.determineConclusion(analysis),
        output: {
          title: 'AI Code Review Completed',
          summary: this.generateInteractiveSummary(analysis, postableFindings),
          text: this.generateDetailedOutput(analysis, postableFindings, trackingId)
        },
        actions: this.generateCheckRunActions(postableFindings)
      };

      const checkRun = await githubService.createCheckRun(owner, repo, checkRunData);

      // Store check run data for action handling
      this.activeCheckRuns.set(checkRun.id, {
        owner,
        repo,
        pullNumber,
        headSha,
        trackingId,
        analysis,
        postableFindings,
        createdAt: Date.now(),
        buttonStates: postableFindings.reduce((acc, finding, index) => {
          acc[`comment-finding-${index}`] = 'ready';
          return acc;
        }, { 'post-all': 'ready' })
      });

      logger.info(`Interactive check run created: ${checkRun.id}`, { 
        trackingId, 
        postableCount: postableFindings.length 
      });

      return checkRun;

    } catch (error) {
      logger.error('Error creating interactive check run:', error);
      throw new Error(`Failed to create interactive check run: ${error.message}`);
    }
  }

  // Generate actions (buttons) for the check run
  generateCheckRunActions(postableFindings) {
    const actions = [];
    // GitHub API only allows a max of 3 buttons in a check run
    const maxButtons = 2;
    const maxDescLength = 40; 
    
    // If there are more than two findings, only show the "Post All" button
    if (postableFindings.length > 2) {
      actions.push({
        label: `Post All Comments`,
        description: `Post all ${postableFindings.length} findings`,
        identifier: 'post-all'
      });
      return actions;
    }

    // Otherwise, show individual buttons and "Post All"
    postableFindings.forEach((finding, index) => {
      const truncatedFile = truncateText(finding.file, maxDescLength - 10);
      actions.push({
        label: `Comment #${index + 1}`,
        description: `${finding.severity}: ${truncatedFile}`,
        identifier: `comment-finding-${index}`
      });
    });

    // Always include the Post all comments button if there are any findings
    if (postableFindings.length > 0) {
      actions.push({
        label: `Post All Comments`,
        description: `Post all ${postableFindings.length} findings`,
        identifier: 'post-all'
      });
    }

    return actions;
  }

  // Generate interactive summary for check run
  generateInteractiveSummary(analysis, postableFindings) {
    const { automatedAnalysis, reviewAssessment } = analysis;
    
    let summary = `Analysis completed successfully!\n\n`;
    summary += `**Issues Found:** ${automatedAnalysis.totalIssues}\n`;
    summary += `**Critical:** ${automatedAnalysis.severityBreakdown.critical}\n`;
    summary += `**Assessment:** ${reviewAssessment}\n\n`;
    
    if (postableFindings.length > 0) {
      summary += `**Interactive Comments Available:** ${postableFindings.length} findings can be posted as inline comments\n`;
      summary += `Click the buttons below to post individual or all findings directly to the code.\n\n`;
    } else {
      summary += `No new issues found that can be posted as inline comments.\n`;
    }
    
    summary += `See detailed analysis in PR comments.`;
    
    return summary;
  }

  // Generate detailed output showing each finding with clear formatting
  generateDetailedOutput(analysis, postableFindings, trackingId) {
    let output = `## AI Code Review Results\n\n`;
    
    const { automatedAnalysis, reviewAssessment, recommendation } = analysis;
    
    // Summary section
    output += `### Summary\n`;
    output += `- **Total Issues:** ${automatedAnalysis.totalIssues}\n`;
    output += `- **Review Assessment:** ${reviewAssessment}\n`;
    output += `- **Technical Debt:** ${automatedAnalysis.technicalDebtMinutes} minutes\n\n`;
    
    // Severity breakdown
    const severity = automatedAnalysis.severityBreakdown || {};
    output += `### Severity Breakdown\n`;
    output += `- Blocker: ${severity.blocker || 0}\n`;
    output += `- Critical: ${severity.critical || 0}\n`;
    output += `- Major: ${severity.major || 0}\n`;
    output += `- Minor: ${severity.minor || 0}\n`;
    output += `- Info: ${severity.info || 0}\n\n`;

    // Interactive findings section
    if (postableFindings.length > 0) {
      output += `### Interactive Comment Options\n`;
      output += `Click the buttons above to post these findings as inline code comments:\n\n`;
      
      postableFindings.forEach((finding, index) => {
        output += `**#${index + 1} - ${finding.severity} ${finding.category}**\n`;
        output += `- File: \`${finding.file}:${finding.line}\`\n`;
        output += `- Issue: ${finding.issue}\n`;
        output += `- Suggestion: ${finding.suggestion}\n\n`;
      });
      
      if (postableFindings.length > 1) {
        output += `Use "Post All Comments" to post all ${postableFindings.length} findings at once.\n\n`;
      }
    } else {
      output += `### No New Interactive Comments\n`;
      output += `All findings are either general issues or have already been addressed by reviewers.\n\n`;
    }
    
    // Recommendation
    output += `### Recommendation\n`;
    output += `${recommendation}\n\n`;
    
    output += `---\n`;
    output += `Analysis ID: ${trackingId}\n`;
    output += `Generated: ${new Date().toISOString()}`;
    
    return output;
  }

  // Handle check run button actions
  async handleButtonAction(payload) {
    const { action, check_run, requested_action, repository } = payload;

    if (action !== 'requested_action' || check_run.name !== 'AI Code Review') {
      return false;
    }

    const checkRunId = check_run.id;
    const actionId = requested_action.identifier;
    
    logger.info(`Button action requested: ${actionId} for check run ${checkRunId}`);

    // Get stored check run data
    const checkRunData = this.activeCheckRuns.get(checkRunId);
    if (!checkRunData) {
      logger.error(`No data found for check run ${checkRunId}`);
      await this.updateCheckRunError(repository, checkRunId, 'Check run data not found. Please re-run AI review.');
      return true;
    }

    const { owner, repo, pullNumber, headSha, postableFindings, buttonStates } = checkRunData;

    try {
      // Update button state to processing
      buttonStates[actionId] = 'in_progress';
      await this.updateCheckRunProgress(repository, checkRunId, checkRunData, actionId);

      if (actionId === 'post-all') {
        // Post all comments as a single threaded review
        await this.postAllFindings(owner, repo, pullNumber, headSha, postableFindings, checkRunData);
        
        // Update all button states
        Object.keys(buttonStates).forEach(key => {
          if (buttonStates[key] === 'in_progress' || buttonStates[key] === 'ready') {
            buttonStates[key] = 'completed';
          }
        });
        
      } else if (actionId.startsWith('comment-finding-')) {
        // Post individual comment as a single review comment
        const findingIndex = parseInt(actionId.replace('comment-finding-', ''));
        const finding = postableFindings[findingIndex];
        
        if (!finding) {
          throw new Error(`Finding ${findingIndex} not found`);
        }

        await this.postIndividualFinding(owner, repo, pullNumber, headSha, finding, checkRunData);
        
        // Update button state
        buttonStates[actionId] = 'completed';
      }

      // Update check run with completion status
      await this.updateCheckRunCompleted(repository, checkRunId, checkRunData, actionId);
      
      logger.info(`Button action completed: ${actionId} for PR #${pullNumber}`);
      return true;

    } catch (error) {
      logger.error(`Error handling button action ${actionId}:`, error);
      
      // Update button state to error
      buttonStates[actionId] = 'error';
      await this.updateCheckRunError(repository, checkRunId, `Failed to ${actionId}: ${error.message}`);
      
      return true;
    }
  }

  // MODIFIED: Post individual finding as a single, unthreaded review comment.
  async postIndividualFinding(owner, repo, pullNumber, headSha, finding, checkRunData) {
    logger.info(`Posting individual finding for ${finding.file}:${finding.line}`, {
      pullNumber,
      trackingId: checkRunData.trackingId
    });

    const commentableLine = await githubService.findCommentableLine(owner, repo, pullNumber, finding.file, finding.line);
    
    if (!commentableLine) {
      const errorMessage = `Could not find a valid diff line for file "${finding.file}" near line "${finding.line}". This file/line may not be part of the changes in this pull request.`;
      logger.error(errorMessage);
      throw new Error(errorMessage);
    }
    
    const commentBody = githubService.formatInlineComment(finding, checkRunData.trackingId);

    // Post as a single, unthreaded review comment
    const comment = await githubService.postIndividualReviewComment(
      owner, 
      repo, 
      pullNumber, 
      headSha, 
      finding.file, 
      commentableLine, 
      commentBody
    );

    // Mark finding as posted
    finding.posted = true;
    finding.commentId = comment.id;

    logger.info(`Individual finding posted as a single review comment`, {
      file: finding.file,
      line: commentableLine,
      pullNumber,
      commentId: comment.id
    });
  }

  // MODIFIED: Post all findings as a single, threaded review.
  async postAllFindings(owner, repo, pullNumber, headSha, postableFindings, checkRunData) {
    logger.info(`Posting all findings for PR #${pullNumber}`, {
      count: postableFindings.length,
      trackingId: checkRunData.trackingId
    });

    const commentsToPost = [];
    let successCount = 0;
    const errors = [];

    for (const finding of postableFindings) {
      if (finding.posted) {
        successCount++;
        continue;
      }

      try {
        const commentableLine = await githubService.findCommentableLine(owner, repo, pullNumber, finding.file, finding.line);
        
        if (!commentableLine) {
          throw new Error(`Could not find a valid diff line near line ${finding.line} for file "${finding.file}". Skipping comment.`);
        }
        
        const commentBody = githubService.formatInlineComment(finding, checkRunData.trackingId);

        commentsToPost.push({
          path: finding.file,
          line: commentableLine,
          body: commentBody,
        });

        finding.posted = true;
        successCount++;

      } catch (error) {
        logger.error(`Error processing comment for ${finding.file}:${finding.line}:`, error);
        errors.push(`${finding.file}:${finding.line} - ${error.message}`);
      }
    }
    
    // Post all comments in a single review
    if (commentsToPost.length > 0) {
      const reviewBody = this.formatBulkPostSummary(successCount, errors.length, errors, checkRunData.trackingId);
      try {
        await githubService.postThreadedReview(owner, repo, pullNumber, headSha, reviewBody, commentsToPost);
      } catch (bulkPostError) {
        logger.error('Error in bulk posting to GitHub:', bulkPostError);
        errors.push(`Bulk posting failed: ${bulkPostError.message}`);
      }
    }

    logger.info(`Bulk posting completed`, {
      pullNumber,
      successCount,
      errorCount: errors.length,
      trackingId: checkRunData.trackingId
    });

    return { successCount, errorCount: errors.length, errors };
  }

  // Format bulk posting summary
  formatBulkPostSummary(successCount, errorCount, errors, trackingId) {
    let summary = `**All AI Comments Posted**\n\n`;
    summary += `Successfully posted: ${successCount} comments\n`;
    
    if (errorCount > 0) {
      summary += `Failed to post: ${errorCount} comments\n\n`;
      errors.forEach(error => {
        summary += `• ${error}\n`;
      });
    }

    summary += `\nAll comments have been posted as inline review comments on the respective code lines.\n`;
    summary += `Analysis ID: \`${trackingId}\`\n`;
    summary += `Posted at: ${new Date().toISOString()}`;

    return summary;
  }

  // Update check run to show progress WITHOUT changing status
  async updateCheckRunProgress(repository, checkRunId, checkRunData, actionId) {
    const { analysis, postableFindings, trackingId } = checkRunData;
    
    let progressMessage;
    if (actionId === 'post-all') {
      progressMessage = `Posting all ${postableFindings.length} findings as inline comments...`;
    } else {
      const findingIndex = parseInt(actionId.replace('comment-finding-', ''));
      const finding = postableFindings[findingIndex];
      progressMessage = `Posting comment for ${finding.file}:${finding.line}...`;
    }

    await githubService.updateCheckRun(repository.owner.login, repository.name, checkRunId, {
      output: {
        title: 'AI Code Review - Posting Comments',
        summary: progressMessage,
        text: this.generateDetailedOutput(analysis, postableFindings, trackingId)
      }
    });
  }

  // Update check run when action completed
  async updateCheckRunCompleted(repository, checkRunId, checkRunData, actionId) {
    const { analysis, postableFindings, trackingId } = checkRunData;
    
    let completionMessage;
    if (actionId === 'post-all') {
      completionMessage = `All ${postableFindings.length} findings have been posted as inline comments.`;
    } else {
      const findingIndex = parseInt(actionId.replace('comment-finding-', ''));
      const finding = postableFindings[findingIndex];
      completionMessage = `Comment posted for ${finding.file}:${finding.line}.`;
    }

    await githubService.updateCheckRun(repository.owner.login, repository.name, checkRunId, {
      conclusion: 'success', // Conclusion can be updated on a completed run
      output: {
        title: 'AI Code Review - Comments Posted',
        summary: completionMessage,
        text: this.generateDetailedOutput(analysis, postableFindings, trackingId)
      },
      // Note: `actions` and `status` properties are intentionally omitted to avoid validation errors.
    });
  }
  
  // Update check run on error
  async updateCheckRunError(repository, checkRunId, errorMessage) {
    await githubService.updateCheckRun(repository.owner.login, repository.name, checkRunId, {
      conclusion: 'failure',
      output: {
          title: 'AI Code Review - Action Failed',
          summary: errorMessage,
      },
    });
  }

  // Filter findings that can be posted as inline comments
  getPostableFindings(detailedFindings) {
    if (!detailedFindings || !Array.isArray(detailedFindings)) {
      return [];
    }

    return detailedFindings.filter(finding => 
      finding.file && 
      finding.file !== 'unknown-file' && 
      finding.file !== 'AI_ANALYSIS_ERROR' &&
      finding.line && 
      finding.line > 0 &&
      !finding.posted
    );
  }

  // Determine check run conclusion based on analysis
  determineConclusion(analysis) {
    const { automatedAnalysis, reviewAssessment } = analysis;
    
    const hasBlockerIssues = automatedAnalysis.severityBreakdown.blocker > 0;
    const hasCriticalIssues = automatedAnalysis.severityBreakdown.critical > 0;
    
    if (hasBlockerIssues) return 'failure';
    if (hasCriticalIssues) return 'neutral';
    if (reviewAssessment === 'PROPERLY REVIEWED') return 'success';
    return 'neutral';
  }

  // Helper methods for emojis and colors
  getSeverityEmoji(severity) {
    const emojiMap = {
      'BLOCKER': '🚫',
      'CRITICAL': '🔴',
      'MAJOR': '🟡',
      'MINOR': '🔵',
      'INFO': 'ℹ️'
    };
    return emojiMap[severity.toUpperCase()] || 'ℹ️';
  }

  getCategoryEmoji(category) {
    const emojiMap = {
      'BUG': '🐛',
      'VULNERABILITY': '🔒',
      'SECURITY_HOTSPOT': '⚠️',
      'CODE_SMELL': '💨'
    };
    return emojiMap[category.toUpperCase()] || '💨';
  }

  getSeverityColor(severity) {
    const colorMap = {
      'BLOCKER': 'red',
      'CRITICAL': 'red',
      'MAJOR': 'orange',
      'MINOR': 'blue',
      'INFO': 'gray'
    };
    return colorMap[severity.toUpperCase()] || 'gray';
  }

  // Get statistics about active check runs
  getStats() {
    const stats = {
      activeCheckRuns: this.activeCheckRuns.size,
      totalFindings: 0,
      postedFindings: 0,
      pendingFindings: 0
    };

    for (const [checkRunId, data] of this.activeCheckRuns.entries()) {
      stats.totalFindings += data.postableFindings.length;
      stats.postedFindings += data.postableFindings.filter(f => f.posted).length;
      stats.pendingFindings += data.postableFindings.filter(f => !f.posted).length;
    }

    return stats;
  }

  // Clean old check run data
  cleanOldCheckRuns() {
    const maxAge = 24 * 60 * 60 * 1000; // 24 hours
    const now = Date.now();
    let cleaned = 0;

    for (const [checkRunId, data] of this.activeCheckRuns.entries()) {
      if (now - data.createdAt > maxAge) {
        this.activeCheckRuns.delete(checkRunId);
        cleaned++;
      }
    }

    if (cleaned > 0) {
      logger.info(`Cleaned ${cleaned} old check run entries`);
    }
  }
}

module.exports = new CheckRunButtonService();