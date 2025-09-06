// src/services/check-run-button.service.js - Updated to use PR-focused methods

const githubService = require('./github.service');
const aiService = require('./ai.service');
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
          summary: this.generateInteractiveSummary(analysis, postableFindings)
          // REMOVED: text field to prevent Details section from appearing
        },
        actions: this.generateCheckRunActions(postableFindings)
      };

      const checkRun = await githubService.createCheckRun(owner, repo, checkRunData);

      // Store check run data for action handling
      this.activeCheckRuns.set(checkRun.id, {
        checkRunId: checkRun.id,
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
          acc[`fix-suggestion-${index}`] = 'ready';
          return acc;
        }, {
          'post-all': 'ready',
          'commit-fixes': 'ready',
          'check-merge': 'ready'
        })
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

  // Generate actions (buttons) for the check run - ENHANCED with new buttons
  generateCheckRunActions(postableFindings) {
    const actions = [];
    const maxButtons = 3;

    if (postableFindings.length > 0) {
      actions.push({
        label: `Post All Comments`,
        description: `Post all ${postableFindings.length} findings`,
        identifier: 'post-all'
      });

      actions.push({
        label: `Commit Fixes`,
        description: `Apply all fixes to branch`,
        identifier: 'commit-fixes'
      });
    }

    actions.push({
      label: `Check Merge Ready`,
      description: `Assess if PR is ready to merge`,
      identifier: 'check-merge'
    });

    return actions.slice(0, maxButtons);
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

  // Handle check run button actions - UPDATED to use PR-focused methods
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

    const {
      owner,
      repo,
      pullNumber,
      headSha,
      postableFindings,
      buttonStates,
      analysis
    } = checkRunData;

    // Validate required variables
    if (!owner || !repo || !pullNumber) {
      const errorMsg = `Missing required data: owner=${owner}, repo=${repo}, pullNumber=${pullNumber}`;
      logger.error(errorMsg);
      await this.updateCheckRunError(repository, checkRunId, errorMsg);
      return true;
    }

    try {
      // Update button state to processing
      buttonStates[actionId] = 'in_progress';
      await this.updateCheckRunProgress(repository, checkRunId, checkRunData, actionId);

      // Handle different button actions
      if (actionId === 'post-all') {
        await this.postAllFindings(owner, repo, pullNumber, headSha, postableFindings, checkRunData);
        Object.keys(buttonStates).forEach(key => {
          if (key.startsWith('comment-finding-') && buttonStates[key] !== 'error') {
            buttonStates[key] = 'completed';
          }
        });
        buttonStates['post-all'] = 'completed';
        await this.updateCheckRunCompleted(repository, checkRunId, checkRunData, actionId);

      } else if (actionId === 'commit-fixes') {
        // UPDATED: Use new PR-focused commit method
        await this.commitFixesToPRBranch(owner, repo, pullNumber, postableFindings, checkRunData);
        buttonStates['commit-fixes'] = 'completed';
        await this.updateCheckRunCompleted(repository, checkRunId, checkRunData, actionId);

      } else if (actionId === 'check-merge') {
        logger.info(`Starting merge readiness analysis for PR #${pullNumber}`);

        const mergeAnalysis = await aiService.checkMergeReadiness(analysis, checkRunData);

        const isReady = mergeAnalysis.isReady;
        const statusIcon = isReady ? '✅' : '❌';
        const statusText = isReady ? 'Ready to Merge' : 'Not Ready to Merge';
        const conclusion = isReady ? 'success' : 'failure';

        const enhancedSummary = `${statusIcon} **${statusText}**\n\n` +
          `**Assessment:** ${mergeAnalysis.status || 'Analyzed'}\n` +
          `**Recommendation:** ${mergeAnalysis.recommendation || 'See details below'}`;

        // Create simple status without details to prevent Details section
        await githubService.updateCheckRun(owner, repo, checkRunId, {
          status: 'completed',
          conclusion: conclusion,
          output: {
            title: `${statusIcon} Merge Readiness: ${statusText}`,
            summary: enhancedSummary
            // REMOVED: text field to prevent Details section
          },
          actions: this.generateCheckRunActions(postableFindings)
        });

        buttonStates['check-merge'] = 'completed';
        logger.info(`Merge readiness analysis completed. Status: ${statusText}`);
      }

      return true;
    } catch (error) {
      logger.error(`Error handling action '${actionId}':`, error);
      buttonStates[actionId] = 'error';
      await this.updateCheckRunError(repository, checkRunId, `Failed to complete action '${actionId}': ${error.message}`);
      return true;
    }
  }

  // UPDATED: Commit all fix suggestions to PR branch using new PR-focused methods
  async commitFixesToPRBranch(owner, repo, pullNumber, postableFindings, checkRunData) {
    logger.info(`Committing fix suggestions to PR #${pullNumber} branch`, {
      findingsCount: postableFindings.length,
      trackingId: checkRunData.trackingId
    });

    try {
      // Prepare fixes in the format expected by commitFixesToPRBranch
      const fixes = postableFindings.map(finding => ({
        file: finding.file,
        line: finding.line,
        issue: finding.issue,
        suggestion: finding.suggestion,
        severity: finding.severity,
        category: finding.category
      }));

      // Use the new PR-focused commit method from github.service.js
      const commitResults = await githubService.commitFixesToPRBranch(
        owner, 
        repo, 
        pullNumber, 
        fixes, 
        `Apply AI-suggested code fixes\n\nTracking ID: ${checkRunData.trackingId}`
      );

      // Update check run with results
      await this.updateCheckRunWithCommitResults(
        owner,
        repo,
        checkRunData.checkRunId,
        checkRunData,
        commitResults
      );

      logger.info(`Commit fixes completed for PR #${pullNumber}`, {
        successful: commitResults.successful.length,
        failed: commitResults.failed.length,
        skipped: commitResults.skipped.length,
        trackingId: checkRunData.trackingId
      });

      return commitResults;

    } catch (error) {
      logger.error(`Error committing fixes to PR #${pullNumber}:`, error);
      
      // Update check run with error
      await this.updateCheckRunWithCommitError(
        owner,
        repo,
        checkRunData.checkRunId,
        error.message
      );
      
      throw error;
    }
  }

  // UPDATED: Update check run with commit results using new format
  async updateCheckRunWithCommitResults(owner, repo, checkRunId, checkRunData, commitResults) {
    try {
      const { successful, failed, skipped } = commitResults;
      const totalProcessed = successful.length + failed.length + skipped.length;

      let summary = `**Fix Commits Completed**\n\n`;
      
      if (successful.length > 0) {
        summary += `✅ **${successful.length} fixes committed successfully**\n`;
      }
      if (failed.length > 0) {
        summary += `❌ **${failed.length} fixes failed**\n`;
      }
      if (skipped.length > 0) {
        summary += `⏭️ **${skipped.length} fixes skipped**\n`;
      }

      // Only add details if there are failures worth showing
      let detailText = null;
      if (failed.length > 0 || successful.length > 0) {
        detailText = `## 🔧 Commit Results\n\n`;

        if (successful.length > 0) {
          detailText += `### ✅ Successfully Committed (${successful.length})\n\n`;
          successful.forEach((result, index) => {
            detailText += `**${index + 1}.** \`${result.file}\`\n`;
            detailText += `   └─ **Commit:** [\`${result.commitSha.substring(0, 7)}\`](${result.commitUrl || '#'})\n\n`;
          });
        }

        if (failed.length > 0) {
          detailText += `### ❌ Failed (${failed.length})\n\n`;
          failed.forEach((result, index) => {
            detailText += `**${index + 1}.** \`${result.file}\`: ${result.error}\n`;
          });
          detailText += '\n';
        }

        if (skipped.length > 0) {
          detailText += `### ⏭️ Skipped (${skipped.length})\n\n`;
          skipped.forEach((result, index) => {
            detailText += `**${index + 1}.** \`${result.file}\`: ${result.reason}\n`;
          });
          detailText += '\n';
        }

        detailText += `---\n*🤖 Fixes committed by AI Code Reviewer*`;
      }

      // Update check run
      const output = {
        title: 'AI Code Review - Fixes Committed',
        summary: summary
      };

      // Only add text if we have meaningful details
      if (detailText) {
        output.text = detailText;
      }

      await githubService.updateCheckRun(owner, repo, checkRunId, {
        conclusion: successful.length > 0 ? 'success' : (failed.length > 0 ? 'failure' : 'neutral'),
        output: output
      });

    } catch (error) {
      logger.error('Error updating check run with commit results:', error);
    }
  }

  // NEW: Update check run with commit error
  async updateCheckRunWithCommitError(owner, repo, checkRunId, errorMessage) {
    try {
      await githubService.updateCheckRun(owner, repo, checkRunId, {
        conclusion: 'failure',
        output: {
          title: 'AI Code Review - Commit Failed',
          summary: `Failed to commit fixes: ${errorMessage}\n\nThis may be due to file access issues or repository permissions.`
          // REMOVED: text field to prevent Details section
        }
      });
    } catch (error) {
      logger.error('Error updating check run with commit error:', error);
    }
  }

  // UPDATED: Post all findings with enhanced line validation
  async postAllFindings(owner, repo, pullNumber, headSha, postableFindings, checkRunData) {
    logger.info(`Posting all findings for PR #${pullNumber}`, {
      count: postableFindings.length,
      trackingId: checkRunData.trackingId
    });

    const commentsToPost = [];
    let successCount = 0;
    const errors = [];
    const adjustedLines = [];

    // Process each finding and validate/adjust line numbers
    for (let i = 0; i < postableFindings.length; i++) {
      const finding = postableFindings[i];

      if (finding.posted) {
        successCount++;
        continue;
      }

      try {
        // Validate the line number
        const isValidLine = await githubService.validateCommentableLine(owner, repo, pullNumber, finding.file, finding.line);

        if (!isValidLine) {
          // Try to find a commentable line near the target
          const commentableLine = await githubService.findCommentableLine(owner, repo, pullNumber, finding.file, finding.line);

          if (!commentableLine) {
            throw new Error(`Line ${finding.line} in ${finding.file} is not part of the PR changes or cannot receive comments`);
          }

          // Track line adjustments for reporting
          adjustedLines.push({
            file: finding.file,
            originalLine: finding.line,
            adjustedLine: commentableLine
          });

          // Update the finding
          finding.originalLine = finding.line;
          finding.line = commentableLine;
          finding.lineAdjusted = true;

          logger.info(`Adjusted line number for ${finding.file} from ${finding.originalLine} to ${commentableLine}`);
        }

        const commentBody = await this.formatInlineCommentWithFix(finding, checkRunData.trackingId, owner, repo, checkRunData);

        commentsToPost.push({
          path: finding.file,
          line: finding.line,
          body: commentBody,
        });

        finding.posted = true;
        successCount++;

      } catch (error) {
        const errorMsg = `${finding.file}:${finding.line} - ${error.message}`;
        logger.error(`Error processing finding ${i + 1}:`, error);
        errors.push(errorMsg);
      }
    }

    // Post all valid comments in a single review
    if (commentsToPost.length > 0) {
      try {
        await githubService.postReviewComments(owner, repo, pullNumber, headSha, commentsToPost);
        logger.info(`Successfully posted ${commentsToPost.length} comments in bulk review`);
      } catch (bulkPostError) {
        logger.error('Error in bulk posting to GitHub:', bulkPostError);
        errors.push(`Bulk posting failed: ${bulkPostError.message}`);

        // Attempt individual posting as fallback
        logger.info('Attempting individual comment posting as fallback...');
        await this.fallbackIndividualPosting(owner, repo, pullNumber, headSha, commentsToPost, postableFindings, errors);
      }
    }

    logger.info(`Bulk posting completed`, {
      pullNumber,
      successCount,
      errorCount: errors.length,
      adjustedLines: adjustedLines.length,
      trackingId: checkRunData.trackingId
    });

    return {
      successCount,
      errorCount: errors.length,
      errors,
      adjustedLines: adjustedLines.length
    };
  }

  // UPDATED: Format inline comment with fix suggestion
  async formatInlineCommentWithFix(finding, trackingId, owner, repo, checkRunData) {
    const severityEmoji = this.getSeverityEmoji(finding.severity);

    let comment = `${severityEmoji} **AI Finding**\n\n`;
    comment += `**Issue:** ${finding.issue}\n\n`;
    comment += `**Suggestion:**\n${finding.suggestion}\n\n`;

    // Add suggested code fix inline
    try {
      // Get file content for context using new PR-focused method
      const fileInfo = await githubService.getFileContentFromPR(owner, repo, checkRunData.pullNumber, finding.file);
      
      if (fileInfo && fileInfo.content) {
        // Generate AI fix suggestion
        const fixSuggestion = await aiService.generateCodeFixSuggestion(finding, fileInfo.content, checkRunData);

        if (fixSuggestion && !fixSuggestion.error && fixSuggestion.suggested_fix) {
          comment += `**💡 Suggested Fix:**\n`;
          comment += `\`\`\`javascript\n${fixSuggestion.suggested_fix}\`\`\`\n\n`;

          if (fixSuggestion.explanation) {
            comment += `**Explanation:** ${fixSuggestion.explanation}\n`;
          }
        }
      }
    } catch (error) {
      logger.error(`Error generating fix for inline comment: ${error.message}`);
      // Continue without the fix suggestion
    }

    return comment;
  }

  // NEW: Fallback individual posting when bulk posting fails
  async fallbackIndividualPosting(owner, repo, pullNumber, headSha, commentsToPost, postableFindings, errors) {
    let fallbackSuccess = 0;

    for (let i = 0; i < commentsToPost.length; i++) {
      const comment = commentsToPost[i];
      const finding = postableFindings.find(f => f.file === comment.path && f.line === comment.line);

      try {
        // Small delay between individual posts
        if (i > 0) {
          await new Promise(resolve => setTimeout(resolve, 500));
        }

        await githubService.postReviewComments(owner, repo, pullNumber, headSha, [comment]);
        fallbackSuccess++;

        logger.info(`Fallback: Individual comment posted for ${comment.path}:${comment.line}`);

      } catch (individualError) {
        logger.error(`Fallback failed for ${comment.path}:${comment.line}:`, individualError);
        errors.push(`${comment.path}:${comment.line} - Fallback failed: ${individualError.message}`);

        if (finding) {
          finding.posted = false; // Mark as failed
        }
      }
    }

    logger.info(`Fallback individual posting completed: ${fallbackSuccess}/${commentsToPost.length} successful`);
  }

  // Update check run to show progress WITHOUT creating Details section
  async updateCheckRunProgress(repository, checkRunId, checkRunData, actionId) {
    const { analysis, postableFindings, trackingId } = checkRunData;

    let progressMessage;
    if (actionId === 'post-all') {
      progressMessage = `Posting all ${postableFindings.length} findings as inline comments...`;
    } else if (actionId === 'commit-fixes') {
      progressMessage = `Committing fix suggestions to branch...`;
    } else if (actionId === 'check-merge') {
      progressMessage = `Checking merge readiness for PR #${checkRunData.pullNumber}...`;
    } else {
      const findingIndex = parseInt(actionId.replace('comment-finding-', ''));
      const finding = postableFindings[findingIndex];
      progressMessage = `Posting comment for ${finding.file}:${finding.line}...`;
    }

    await githubService.updateCheckRun(repository.owner.login, repository.name, checkRunId, {
      output: {
        title: 'AI Code Review - Processing',
        summary: progressMessage
        // REMOVED: text field to prevent Details section
      }
    });
  }

  // Update check run when action completed - KEEP BUTTONS PERSISTENT without Details
  async updateCheckRunCompleted(repository, checkRunId, checkRunData, actionId) {
    const { analysis, postableFindings, trackingId } = checkRunData;

    let completionMessage;
    if (actionId === 'post-all') {
      completionMessage = `All ${postableFindings.length} findings have been posted as inline comments.`;
    } else if (actionId === 'commit-fixes') {
      completionMessage = `All fix suggestions have been committed to the branch.`;
    } else if (actionId === 'check-merge') {
      completionMessage = `Merge readiness assessment completed.`;
    } else {
      const findingIndex = parseInt(actionId.replace('comment-finding-', ''));
      const finding = postableFindings[findingIndex];
      completionMessage = `Comment posted for ${finding.file}:${finding.line}.`;
    }

    const persistentActions = this.generateCheckRunActions(postableFindings);

    await githubService.updateCheckRun(repository.owner.login, repository.name, checkRunId, {
      conclusion: 'success',
      output: {
        title: 'AI Code Review - Action Completed',
        summary: completionMessage
        // REMOVED: text field to prevent Details section
      },
      actions: persistentActions
    });
  }

  // Update check run on error without Details section
  async updateCheckRunError(repository, checkRunId, errorMessage) {
    await githubService.updateCheckRun(repository.owner.login, repository.name, checkRunId, {
      conclusion: 'failure',
      output: {
        title: 'AI Code Review - Action Failed',
        summary: errorMessage
        // REMOVED: text field to prevent Details section
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