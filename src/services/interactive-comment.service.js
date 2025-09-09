const githubService = require('./github.service');
const aiService = require('./ai.service');
const logger = require('../utils/logger');

class InteractiveCommentService {
  constructor() {
    this.activeComments = new Map(); // Track active interactive comments
  }

  /**
   * Posts an enhanced comment with fix suggestion
   * @param {string} owner - Repository owner
   * @param {string} repo - Repository name
   * @param {number} pullNumber - Pull request number
   * @param {Object} finding - The finding object
   * @param {Object} fixSuggestion - The fix suggestion object
   * @param {string} trackingId - The tracking ID
   * @returns {Object} The posted comment data
   */
  async postCommentWithFixSuggestion(owner, repo, pullNumber, finding, fixSuggestion, trackingId) {
    try {
      logger.info(`Posting enhanced comment with fix suggestion for ${finding.file}:${finding.line}`, {
        trackingId,
        severity: finding.severity
      });

      // Format the enhanced comment with both issue and fix
      const commentBody = this.formatEnhancedComment(finding, fixSuggestion, trackingId);

      // Post as review comment on the specific line
      const commentsToPost = [{
        path: finding.file,
        line: finding.line,
        body: commentBody,
      }];

      await githubService.postReviewComments(owner, repo, pullNumber, finding.headSha || 'HEAD', commentsToPost);

      // Store comment data for potential follow-up interactions
      const commentKey = `${owner}/${repo}#${pullNumber}:${finding.file}:${finding.line}`;
      this.activeComments.set(commentKey, {
        finding,
        fixSuggestion,
        trackingId,
        postedAt: Date.now()
      });

      logger.info(`Enhanced comment with fix suggestion posted successfully`);
      return true;

    } catch (error) {
      logger.error('Error posting enhanced comment with fix suggestion:', error);
      throw error;
    }
  }

  /**
   * Formats an enhanced comment with both issue and fix suggestion
   * @param {Object} finding - The finding object
   * @param {Object} fixSuggestion - The fix suggestion object
   * @param {string} trackingId - The tracking ID
   * @returns {string} The formatted comment body
   */
  formatEnhancedComment(finding, fixSuggestion, trackingId) {
    const severityEmoji = this.getSeverityEmoji(finding.severity);
    const categoryEmoji = this.getCategoryEmoji(finding.category);

    let comment = `${severityEmoji} ${categoryEmoji} **AI Code Review Finding with Fix Suggestion**\n\n`;
    
    // Original issue information
    comment += `## 🔍 Issue Identified\n`;
    comment += `**Issue:** ${finding.issue}\n`;
    comment += `**Technical Debt:** ${finding.technicalDebtMinutes || 0} minutes\n`;
    comment += `**Severity:** ${finding.severity} | **Category:** ${finding.category}\n\n`;
    
    // Fix suggestion section
    if (fixSuggestion && !fixSuggestion.error) {
      comment += `## 💡 AI-Generated Fix Suggestion\n\n`;
      
      if (fixSuggestion.current_code) {
        comment += `### ❌ Current Code\n`;
        comment += `\`\`\`javascript\n${fixSuggestion.current_code}\n\`\`\`\n\n`;
      }
      
      comment += `### ✅ Suggested Fix\n`;
      comment += `\`\`\`javascript\n${fixSuggestion.suggested_fix}\n\`\`\`\n\n`;
      
      comment += `### 📝 Explanation\n`;
      comment += `${fixSuggestion.explanation}\n\n`;
      
      if (fixSuggestion.additional_considerations) {
        comment += `### ⚠️ Additional Considerations\n`;
        comment += `${fixSuggestion.additional_considerations}\n\n`;
      }
      
      comment += `### 📊 Fix Details\n`;
      comment += `- **Estimated Effort:** ${fixSuggestion.estimated_effort}\n`;
      comment += `- **Confidence Level:** ${fixSuggestion.confidence}\n\n`;
    } else {
      // Fallback if fix suggestion failed
      comment += `## 💡 Fix Suggestion\n`;
      comment += `**Original Suggestion:** ${finding.suggestion}\n\n`;
      
      if (fixSuggestion?.error) {
        comment += `*Note: AI-generated fix suggestion failed: ${fixSuggestion.error_message}*\n\n`;
      }
    }

    comment += `---\n`;
    comment += `*Posted via AI Code Reviewer | Analysis ID: \`${trackingId}\`*`;

    return comment;
  }

  async updateCheckRunWithMergeStatus(owner, repo, checkRunId, mergeAssessment, trackingId) {
    try {
      logger.info(`Updating check run ${checkRunId} with merge readiness status: ${mergeAssessment.status}`);
  
      const statusEmoji = this.getMergeStatusEmoji(mergeAssessment.status);
      const conclusion = this.getCheckRunConclusion(mergeAssessment.status);
  
      // Create output without text field to prevent DETAILS section
      const output = {
        title: `${statusEmoji} Merge Readiness: ${mergeAssessment.status}`,
        summary: this.formatMergeReadinessSummary(mergeAssessment)
        // REMOVED: text field to prevent empty DETAILS section
      };
  
      // Only add text if there are actually outstanding issues or meaningful details
      const hasOutstandingIssues = mergeAssessment.outstanding_issues && mergeAssessment.outstanding_issues.length > 0;
      const hasQualityAssessment = mergeAssessment.review_quality_assessment;
      
      if (hasOutstandingIssues || hasQualityAssessment) {
        output.text = this.formatMergeReadinessDetails(mergeAssessment, trackingId);
      }
  
      await githubService.updateCheckRun(owner, repo, checkRunId, {
        conclusion: conclusion,
        output: output
      });
  
      logger.info(`Check run updated with merge readiness status successfully`);
      return true;
  
    } catch (error) {
      logger.error('Error updating check run with merge status:', error);
      throw error;
    }
  }
  

  /**
   * Formats merge readiness summary for check run
   * @param {Object} mergeAssessment - The merge assessment object
   * @returns {string} The formatted summary
   */
  formatMergeReadinessSummary(mergeAssessment) {
    let summary = `**Readiness Score:** ${mergeAssessment.merge_readiness_score}/100\n\n`;
    summary += `**Status:** ${mergeAssessment.status}\n\n`;
    summary += `${mergeAssessment.reason}`;

    return summary;
  }

  /**
   * Formats merge readiness details for check run
   * @param {Object} mergeAssessment - The merge assessment object
   * @param {string} trackingId - The tracking ID
   * @returns {string} The formatted details
   */
  formatMergeReadinessDetails(mergeAssessment, trackingId) {
    let details = `## Merge Readiness Assessment\n\n`;
    
    details += `**Overall Score:** ${mergeAssessment.merge_readiness_score}/100\n`;
    details += `**Decision:** ${mergeAssessment.status}\n`;
    details += `**Confidence:** ${mergeAssessment.confidence}\n\n`;
    
    details += `### Assessment Reasoning\n`;
    details += `${mergeAssessment.reason}\n\n`;
    
    details += `### Recommendation\n`;
    details += `${mergeAssessment.recommendation}\n\n`;
  
    // Outstanding issues
    if (mergeAssessment.outstanding_issues && mergeAssessment.outstanding_issues.length > 0) {
      details += `### Outstanding Issues (${mergeAssessment.outstanding_issues.length})\n`;
      mergeAssessment.outstanding_issues.forEach((issue, index) => {
        const issueEmoji = this.getSeverityEmoji(issue.severity);
        details += `${index + 1}. ${issueEmoji} **${issue.type}** - ${issue.severity}\n`;
        details += `   ${issue.description}\n`;
        if (issue.file && issue.file !== 'system') {
          details += `   📁 \`${issue.file}:${issue.line}\`\n`;
        }
        details += `   Status: ${issue.addressed ? '✅ Addressed' : '❌ Not Addressed'}\n\n`;
      });
    }
  
    // Review quality assessment
    if (mergeAssessment.review_quality_assessment) {
      const qa = mergeAssessment.review_quality_assessment;
      details += `### Review Quality Assessment\n`;
      details += `- **Human Review Coverage:** ${qa.human_review_coverage}\n`;
      details += `- **AI Analysis Coverage:** ${qa.ai_analysis_coverage}\n`;
      details += `- **Critical Issues Addressed:** ${qa.critical_issues_addressed ? '✅' : '❌'}\n`;
      details += `- **Security Issues Addressed:** ${qa.security_issues_addressed ? '✅' : '❌'}\n`;
      details += `- **Unresolved Issues:** ${qa.total_unresolved_issues}\n\n`;
    }
  
    details += `---\n`;
    details += `*Assessment completed at ${new Date().toISOString()}*\n`;
    details += `*Analysis ID: \`${trackingId}\`*`;
  
    return details;
  }
  
  // NEW: Get check run conclusion based on merge status
  getCheckRunConclusion(status) {
    switch (status) {
      case 'READY_FOR_MERGE':
        return 'success';
      case 'NOT_READY_FOR_MERGE':
        return 'failure';
      case 'REVIEW_REQUIRED':
      default:
        return 'neutral';
    }
  }

  // NEW: Create comprehensive PR status comment
  async postPRStatusComment(owner, repo, pullNumber, analysis, mergeAssessment, trackingId) {
    try {
      logger.info(`Posting comprehensive PR status comment for PR #${pullNumber}`, { trackingId });

      const statusComment = this.formatPRStatusComment(analysis, mergeAssessment, trackingId);
      
      await githubService.postGeneralComment(owner, repo, pullNumber, statusComment);

      logger.info(`PR status comment posted successfully`);
      return true;

    } catch (error) {
      logger.error('Error posting PR status comment:', error);
      throw error;
    }
  }

  // NEW: Format comprehensive PR status comment
  formatPRStatusComment(analysis, mergeAssessment, trackingId) {
    const statusEmoji = this.getMergeStatusEmoji(mergeAssessment.status);
    
    let comment = `${statusEmoji} **Pull Request Review Summary**\n\n`;
    
    // High-level status
    comment += `## 📊 Overall Assessment\n`;
    comment += `- **Merge Status:** ${mergeAssessment.status}\n`;
    comment += `- **Readiness Score:** ${mergeAssessment.merge_readiness_score}/100\n`;
    comment += `- **Issues Found:** ${analysis.automatedAnalysis.totalIssues}\n`;
    comment += `- **Review Assessment:** ${analysis.reviewAssessment}\n\n`;

    // Issue breakdown
    if (analysis.automatedAnalysis.totalIssues > 0) {
      comment += `## 🔍 Issue Breakdown\n`;
      const severity = analysis.automatedAnalysis.severityBreakdown;
      comment += `- 🚫 Blocker: ${severity.blocker}\n`;
      comment += `- 🔴 Critical: ${severity.critical}\n`;
      comment += `- 🟡 Major: ${severity.major}\n`;
      comment += `- 🔵 Minor: ${severity.minor}\n`;
      comment += `- ℹ️ Info: ${severity.info}\n\n`;

      const { bugs, vulnerabilities, securityHotspots, codeSmells } = analysis.automatedAnalysis.categories;
      comment += `**By Category:**\n`;
      comment += `- 🐛 Bugs: ${bugs}\n`;
      comment += `- 🔒 Vulnerabilities: ${vulnerabilities}\n`;
      comment += `- ⚠️ Security Hotspots: ${securityHotspots}\n`;
      comment += `- 💨 Code Smells: ${codeSmells}\n\n`;
    }

    // Merge readiness details
    comment += `## 🚀 Merge Readiness\n`;
    comment += `${mergeAssessment.reason}\n\n`;
    comment += `**Recommendation:** ${mergeAssessment.recommendation}\n\n`;

    // Next steps
    if (mergeAssessment.status === 'READY_FOR_MERGE') {
      comment += `## ✅ Next Steps\n`;
      comment += `This PR has passed all checks and is ready for merge! 🎉\n\n`;
    } else if (mergeAssessment.status === 'NOT_READY_FOR_MERGE') {
      comment += `## ❌ Required Actions\n`;
      if (mergeAssessment.outstanding_issues && mergeAssessment.outstanding_issues.length > 0) {
        comment += `Please address the following issues before merging:\n\n`;
        mergeAssessment.outstanding_issues.forEach((issue, index) => {
          const issueEmoji = this.getSeverityEmoji(issue.severity);
          comment += `${index + 1}. ${issueEmoji} **${issue.type}**: ${issue.description}\n`;
        });
        comment += `\n`;
      }
    } else {
      comment += `## ⏳ Pending Review\n`;
      comment += `This PR requires additional human review before merge determination.\n\n`;
    }

    comment += `---\n`;
    comment += `*Generated by AI Code Reviewer | Analysis ID: \`${trackingId}\`*\n`;
    comment += `*Last updated: ${new Date().toISOString()}*`;

    return comment;
  }

  /**
   * Get emoji for severity level
   * @param {string} severity - The severity level
   * @returns {string} The corresponding emoji
   */
  getSeverityEmoji(severity) {
    const emojiMap = {
      'BLOCKER': '🚫',
      'CRITICAL': '🔴',
      'MAJOR': '🟡',
      'MINOR': '🔵',
      'INFO': 'ℹ️'
    };
    return emojiMap[severity?.toUpperCase()] || 'ℹ️';
  }

  /**
   * Get emoji for category type
   * @param {string} category - The category type
   * @returns {string} The corresponding emoji
   */
  getCategoryEmoji(category) {
    const emojiMap = {
      'BUG': '🐛',
      'VULNERABILITY': '🔒',
      'SECURITY_HOTSPOT': '⚠️',
      'CODE_SMELL': '💨'
    };
    return emojiMap[category?.toUpperCase()] || '💨';
  }

  /**
   * Get emoji for merge status
   * @param {string} status - The merge status
   * @returns {string} The corresponding emoji
   */
  getMergeStatusEmoji(status) {
    const emojiMap = {
      'READY_FOR_MERGE': '✅',
      'NOT_READY_FOR_MERGE': '❌',
      'REVIEW_REQUIRED': '⏳'
    };
    return emojiMap[status] || '❓';
  }

  /**
   * Clean up old comment data from memory
   * Removes comments older than 24 hours
   */
  cleanupOldComments() {
    const maxAge = 24 * 60 * 60 * 1000; // 24 hours
    const now = Date.now();
    let cleaned = 0;

    for (const [key, data] of this.activeComments.entries()) {
      if (now - data.postedAt > maxAge) {
        this.activeComments.delete(key);
        cleaned++;
      }
    }

    if (cleaned > 0) {
      logger.info(`Cleaned ${cleaned} old comment entries`);
    }
  }

  /**
   * Store pending comments for interactive posting
   * @param {string} owner - Repository owner
   * @param {string} repo - Repository name
   * @param {number} pullNumber - Pull request number
   * @param {Array} findings - Array of findings to store
   * @param {string} trackingId - Tracking ID for the analysis
   */
  storePendingComments(owner, repo, pullNumber, findings, trackingId) {
    try {
      // Validate inputs
      if (!findings || !Array.isArray(findings)) {
        logger.warn('No findings provided to store as pending comments');
        return;
      }

      logger.info(`Storing pending comments for PR #${pullNumber}`, {
        findingsCount: findings.length,
        trackingId
      });

      // Store findings for potential interactive use
      findings.forEach((finding, index) => {
        if (finding?.file && finding?.line) {
          const commentKey = `${owner}/${repo}#${pullNumber}:${finding.file}:${finding.line}`;
          this.activeComments.set(commentKey, {
            finding,
            trackingId,
            owner,
            repo,
            pullNumber,
            index,
            postedAt: Date.now(),
            status: 'pending'
          });
        }
      });

      logger.info(`Stored ${findings.length} pending comments for interactive posting`);
    } catch (error) {
      logger.error('Error storing pending comments:', error);
      // Don't throw - this is not critical to the main workflow
    }
  }

  /**
   * Get service statistics
   * @returns {Object} Statistics object with active comments count
   */
  getStats() {
    return {
      activeComments: this.activeComments.size
    };
  }
}

module.exports = new InteractiveCommentService();