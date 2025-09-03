// src/services/github.service.js - Enhanced with Interactive Comment Support

const { Octokit } = require('@octokit/rest');
const { createAppAuth } = require('@octokit/auth-app');
const fs = require('fs');
const path = require('path');
const config = require('../config/config');
const logger = require('../utils/logger');

class GitHubService {
  constructor() {
    this.privateKey = this.getPrivateKey();
    this.octokit = new Octokit({
      authStrategy: createAppAuth,
      auth: {
        appId: config.github.appId,
        privateKey: this.privateKey,
        installationId: config.github.installationId,
      },
    });
  }

  // Enhanced private key retrieval with better validation
  getPrivateKey() {
    try {
      let privateKeyContent = null;

      // Method 1: Base64 encoded private key (for Render/Cloud deployment)
      if (process.env.GITHUB_PRIVATE_KEY_BASE64) {
        logger.info('Attempting to use base64 encoded private key from environment');
        
        try {
          const base64Key = process.env.GITHUB_PRIVATE_KEY_BASE64.trim();
          
          // Validate base64 format
          if (!this.isValidBase64(base64Key)) {
            throw new Error('Invalid base64 format');
          }
          
          privateKeyContent = Buffer.from(base64Key, 'base64').toString('utf-8');
          logger.info('Successfully decoded base64 private key');
          
        } catch (decodeError) {
          logger.error('Failed to decode base64 private key:', decodeError.message);
          throw new Error(`Base64 private key decode failed: ${decodeError.message}`);
        }
      }
      
      // Method 2: Direct private key content (fallback)
      else if (process.env.GITHUB_PRIVATE_KEY) {
        logger.info('Using direct private key content from environment');
        privateKeyContent = process.env.GITHUB_PRIVATE_KEY.replace(/\\n/g, '\n');
      }
      
      // Method 3: Private key file path (local development)
      else if (process.env.GITHUB_PRIVATE_KEY_PATH && fs.existsSync(process.env.GITHUB_PRIVATE_KEY_PATH)) {
        logger.info('Using private key from specified file path');
        privateKeyContent = fs.readFileSync(process.env.GITHUB_PRIVATE_KEY_PATH, 'utf8');
      }
      
      // Method 4: Default file location (local development fallback)
      else {
        const defaultPath = path.join(process.cwd(), 'private-key.pem');
        if (fs.existsSync(defaultPath)) {
          logger.info('Using private key from default location');
          privateKeyContent = fs.readFileSync(defaultPath, 'utf8');
        }
      }

      // Validate the private key content
      if (!privateKeyContent) {
        throw new Error('No private key content found. Please set GITHUB_PRIVATE_KEY_BASE64 environment variable.');
      }

      // Validate private key format
      if (!this.validatePrivateKeyFormat(privateKeyContent)) {
        logger.error('Private key validation failed');
        throw new Error('Invalid private key format. Expected PEM format starting with -----BEGIN');
      }

      logger.info('Private key loaded and validated successfully');
      return privateKeyContent;
      
    } catch (error) {
      logger.error('Error getting GitHub private key:', error);
      throw new Error(`Failed to load GitHub private key: ${error.message}`);
    }
  }

  // Validate base64 format
  isValidBase64(str) {
    try {
      const decoded = Buffer.from(str, 'base64').toString('base64');
      return decoded === str;
    } catch (error) {
      return false;
    }
  }

  // Validate private key format
  validatePrivateKeyFormat(keyContent) {
    if (!keyContent || typeof keyContent !== 'string') {
      return false;
    }

    const trimmedKey = keyContent.trim();
    const hasBeginMarker = trimmedKey.includes('-----BEGIN');
    const hasEndMarker = trimmedKey.includes('-----END');
    const hasPrivateKeyLabel = trimmedKey.includes('PRIVATE KEY');
    
    return hasBeginMarker && hasEndMarker && hasPrivateKeyLabel && trimmedKey.length > 200;
  }

  // Test GitHub App authentication
  async testAuthentication() {
    try {
      const { data: app } = await this.octokit.rest.apps.getAuthenticated();
      logger.info(`GitHub App authenticated successfully: ${app.name} (ID: ${app.id})`);
      return { success: true, app: app.name, id: app.id };
    } catch (error) {
      logger.error('GitHub App authentication failed:', error);
      return { success: false, error: error.message };
    }
  }

  // Health check
  async healthCheck() {
    try {
      const authResult = await this.testAuthentication();
      return {
        status: authResult.success ? 'healthy' : 'unhealthy',
        authenticated: authResult.success,
        timestamp: new Date().toISOString(),
        ...(authResult.success ? { appName: authResult.app, appId: authResult.id } : { error: authResult.error })
      };
    } catch (error) {
      return {
        status: 'unhealthy',
        error: error.message,
        timestamp: new Date().toISOString(),
      };
    }
  }

  // Fetch pull request data with additional context
  async getPullRequestData(owner, repo, pullNumber) {
    try {
      logger.info(`Fetching PR data for ${owner}/${repo}#${pullNumber}`);

      // Get PR details
      const { data: pr } = await this.octokit.rest.pulls.get({
        owner,
        repo,
        pull_number: pullNumber,
      });

      // Get PR files
      const { data: files } = await this.octokit.rest.pulls.listFiles({
        owner,
        repo,
        pull_number: pullNumber,
      });

      // Filter files based on configuration
      const filteredFiles = this.filterFiles(files);

      // Get PR diff
      const diff = await this.getPullRequestDiff(owner, repo, pullNumber);

      // Get existing review comments
      const comments = await this.getPullRequestComments(owner, repo, pullNumber);

      // Get reviewers list
      const reviewers = await this.getPullRequestReviewers(owner, repo, pullNumber);

      return {
        pr: {
          id: pr.id,
          number: pr.number,
          title: pr.title,
          description: pr.body || '',
          author: pr.user.login,
          targetBranch: pr.base.ref,
          sourceBranch: pr.head.ref,
          state: pr.state,
          filesChanged: filteredFiles.length,
          additions: pr.additions,
          deletions: pr.deletions,
          changedFiles: pr.changed_files,
          url: pr.html_url,
          repository: `${owner}/${repo}`,
        },
        files: filteredFiles,
        diff,
        comments,
        reviewers,
      };
    } catch (error) {
      logger.error('Error fetching PR data:', error);
      throw new Error(`Failed to fetch PR data: ${error.message}`);
    }
  }

  // Get PR reviewers
  async getPullRequestReviewers(owner, repo, pullNumber) {
    try {
      const { data: reviews } = await this.octokit.rest.pulls.listReviews({
        owner,
        repo,
        pull_number: pullNumber,
      });

      const reviewers = Array.from(new Set(
        reviews.map(review => review.user.login)
      ));

      return reviewers;
    } catch (error) {
      logger.error('Error fetching PR reviewers:', error);
      return [];
    }
  }

  // Get pull request diff
  async getPullRequestDiff(owner, repo, pullNumber) {
    try {
      const { data: diff } = await this.octokit.rest.pulls.get({
        owner,
        repo,
        pull_number: pullNumber,
        mediaType: {
          format: 'diff',
        },
      });

      return diff;
    } catch (error) {
      logger.error('Error fetching PR diff:', error);
      throw new Error(`Failed to fetch PR diff: ${error.message}`);
    }
  }

  // Get pull request review comments
  async getPullRequestComments(owner, repo, pullNumber) {
    try {
      const [reviewComments, issueComments] = await Promise.all([
        this.octokit.rest.pulls.listReviewComments({
          owner,
          repo,
          pull_number: pullNumber,
        }),
        this.octokit.rest.issues.listComments({
          owner,
          repo,
          issue_number: pullNumber,
        }),
      ]);

      const allComments = [
        ...reviewComments.data.map(comment => ({
          id: comment.id,
          body: comment.body,
          user: comment.user.login,
          createdAt: comment.created_at,
          path: comment.path,
          line: comment.line,
          type: 'review',
        })),
        ...issueComments.data.map(comment => ({
          id: comment.id,
          body: comment.body,
          user: comment.user.login,
          createdAt: comment.created_at,
          type: 'issue',
        })),
      ];

      return allComments.sort((a, b) => new Date(a.createdAt) - new Date(b.createdAt));
    } catch (error) {
      logger.error('Error fetching PR comments:', error);
      throw new Error(`Failed to fetch PR comments: ${error.message}`);
    }
  }

  // Filter files based on configuration
  filterFiles(files) {
    const { excludeFiles, maxFilesToAnalyze, maxFileSizeBytes } = config.review;
    
    return files
      .filter(file => {
        // Check file extension exclusions
        const isExcluded = excludeFiles.some(pattern => {
          const regex = new RegExp(pattern.replace('*', '.*'));
          return regex.test(file.filename);
        });
        
        // Check file size
        const isTooLarge = file.changes > maxFileSizeBytes;
        
        // Only include added or modified files
        const isRelevant = ['added', 'modified'].includes(file.status);
        
        return !isExcluded && !isTooLarge && isRelevant;
      })
      .slice(0, maxFilesToAnalyze);
  }

  // ENHANCED: Post structured comment with interactive buttons
  async postStructuredReviewComment(owner, repo, pullNumber, analysis) {
    try {
      logger.info(`Posting enhanced structured review comment for ${owner}/${repo}#${pullNumber}`);

      // Import interactive comment service
      const interactiveCommentService = require('./interactive-comment.service');

      // Store pending comments for interactive posting
      const trackingId = analysis.trackingId || `analysis-${Date.now()}`;
      analysis.trackingId = trackingId; // Ensure trackingId is set
      
      if (analysis.detailedFindings && analysis.detailedFindings.length > 0) {
        interactiveCommentService.storePendingComments(
          owner, repo, pullNumber, 
          analysis.detailedFindings, 
          trackingId
        );
      }

      // Generate enhanced comment with interactive elements
      const commentBody = this.formatEnhancedStructuredComment(analysis, trackingId);
      
      const { data: comment } = await this.octokit.rest.issues.createComment({
        owner,
        repo,
        issue_number: pullNumber,
        body: commentBody,
      });

      logger.info(`Enhanced structured review comment posted: ${comment.id}`);
      return comment;
    } catch (error) {
      logger.error('Error posting enhanced structured review comment:', error);
      throw new Error(`Failed to post enhanced structured review comment: ${error.message}`);
    }
  }

  // ENHANCED: Format structured comment with interactive commenting features
  formatEnhancedStructuredComment(analysis, trackingId) {
    const { 
      prInfo, 
      automatedAnalysis, 
      humanReviewAnalysis, 
      reviewAssessment, 
      detailedFindings, 
      recommendation 
    } = analysis;

    let comment = `🔍 **MERGE REQUEST REVIEW ANALYSIS**\n`;
    comment += `==================================================\n\n`;
    
    // PR Information Section
    comment += `📋 **Pull Request Information:**\n`;
    comment += `• PR ID: ${prInfo.prId || 'unknown'}\n`;
    comment += `• Title: ${prInfo.title || 'No title'}\n`;
    comment += `• Repository: ${prInfo.repository || 'unknown/unknown'}\n`;
    comment += `• Author: ${prInfo.author || 'unknown'}\n`;
    comment += `• Reviewer(s): ${(prInfo.reviewers && prInfo.reviewers.length > 0) ? prInfo.reviewers.join(', ') : 'None yet'}\n`;
    comment += `• URL: ${prInfo.url || '#'}\n\n`;

    // Automated Analysis Results
    comment += `🤖 **AUTOMATED ANALYSIS RESULTS:**\n`;
    comment += `• Issues Found: ${automatedAnalysis.totalIssues || 0}\n`;
    
    const severity = automatedAnalysis.severityBreakdown || {};
    comment += `• Severity Breakdown: 🚫 ${severity.blocker || 0} | `;
    comment += `🔴 ${severity.critical || 0} | `;
    comment += `🟡 ${severity.major || 0} | `;
    comment += `🔵 ${severity.minor || 0} | `;
    comment += `ℹ️ ${severity.info || 0}\n`;
    
    const categories = automatedAnalysis.categories || {};
    comment += `• Categories: 🐛 ${categories.bugs || 0} | `;
    comment += `🔒 ${categories.vulnerabilities || 0} | `;
    comment += `⚠️ ${categories.securityHotspots || 0} | `;
    comment += `💨 ${categories.codeSmells || 0}\n`;
    comment += `• Technical Debt: ${automatedAnalysis.technicalDebtMinutes || 0} minutes\n\n`;

    // Human Review Analysis
    comment += `👥 **HUMAN REVIEW ANALYSIS:**\n`;
    comment += `• Review Comments: ${humanReviewAnalysis.reviewComments || 0}\n`;
    comment += `• Issues Addressed by Reviewers: ${humanReviewAnalysis.issuesAddressedByReviewers || 0}\n`;
    comment += `• Security Issues Caught: ${humanReviewAnalysis.securityIssuesCaught || 0}\n`;
    comment += `• Code Quality Issues Caught: ${humanReviewAnalysis.codeQualityIssuesCaught || 0}\n\n`;

    // Review Assessment
    comment += `⚖️ **REVIEW ASSESSMENT:**\n`;
    comment += `${reviewAssessment || 'REVIEW REQUIRED'}\n\n`;

    // ENHANCED: Detailed Findings with Interactive Comment Buttons
    comment += `🔍 **DETAILED FINDINGS:**\n`;
    
    if (detailedFindings && Array.isArray(detailedFindings) && detailedFindings.length > 0) {
      // Filter postable findings (ones with valid file/line info)
      const postableFindings = detailedFindings.filter(finding => 
        finding.file && 
        finding.file !== 'unknown-file' && 
        finding.line && 
        finding.line > 0 &&
        finding.file !== 'AI_ANALYSIS_ERROR'
      );

      const nonPostableFindings = detailedFindings.filter(finding => 
        !finding.file || 
        finding.file === 'unknown-file' || 
        !finding.line || 
        finding.line <= 0 ||
        finding.file === 'AI_ANALYSIS_ERROR'
      );

      // Show postable findings with interactive buttons
      if (postableFindings.length > 0) {
        comment += `\n**📝 Issues that can be posted as inline comments:**\n\n`;
        
        postableFindings.forEach((finding, index) => {
          const severityEmoji = this.getSeverityEmoji(finding.severity);
          const categoryEmoji = this.getCategoryEmoji(finding.category);
          
          comment += `**${index + 1}.** ${severityEmoji} ${categoryEmoji} **${finding.file}:${finding.line}**\n`;
          comment += `   └─ **Issue:** ${finding.issue}\n`;
          comment += `   └─ **Suggestion:** ${finding.suggestion}\n`;
          comment += `   └─ **Actions:** Comment with \`/ai-comment ${trackingId}-finding-${index}\` to post as inline comment\n\n`;
        });

        // Post all comments button
        comment += `🔄 **BULK ACTION:**\n`;
        comment += `Comment with \`/ai-comment ${trackingId}-all\` to post all ${postableFindings.length} findings as inline comments at once.\n\n`;
      }

      // Show non-postable findings (general issues)
      if (nonPostableFindings.length > 0) {
        comment += `\n**📋 General issues (cannot be posted as inline comments):**\n\n`;
        
        nonPostableFindings.forEach((finding, index) => {
          const severityEmoji = this.getSeverityEmoji(finding.severity);
          const categoryEmoji = this.getCategoryEmoji(finding.category);
          
          comment += `**${postableFindings.length + index + 1}.** ${severityEmoji} ${categoryEmoji} **${finding.file || 'General'}**\n`;
          comment += `   └─ **Issue:** ${finding.issue}\n`;
          comment += `   └─ **Suggestion:** ${finding.suggestion}\n\n`;
        });
      }

      if (postableFindings.length === 0 && nonPostableFindings.length === 0) {
        comment += `No specific issues found that were missed by reviewers.\n\n`;
      }

    } else {
      comment += `No additional issues found that were missed by reviewers.\n\n`;
    }

    // Interactive Instructions Section
    const postableCount = detailedFindings ? detailedFindings.filter(finding => 
      finding.file && 
      finding.file !== 'unknown-file' && 
      finding.line && 
      finding.line > 0 &&
      finding.file !== 'AI_ANALYSIS_ERROR'
    ).length : 0;

    if (postableCount > 0) {
      comment += `📝 **HOW TO POST INLINE COMMENTS:**\n`;
      comment += `1. **Individual Comments:** Reply with \`/ai-comment ${trackingId}-finding-X\` (replace X with finding number 0, 1, 2...)\n`;
      comment += `2. **All Comments:** Reply with \`/ai-comment ${trackingId}-all\` to post all findings at once\n`;
      comment += `3. **Result:** AI findings will be posted as line-specific review comments on the affected code\n\n`;
      comment += `💡 **Example:** To post the first finding as an inline comment, reply with:\n`;
      comment += `\`/ai-comment ${trackingId}-finding-0\`\n\n`;
    }

    // Recommendation
    comment += `🎯 **RECOMMENDATION:**\n`;
    comment += `${recommendation || 'No specific recommendation available'}\n\n`;

    // Footer
    comment += `---\n`;
    comment += `*🔧 Analysis completed by AI Code Reviewer using SonarQube Standards*\n`;
    comment += `*⏱️ Generated at: ${new Date().toISOString()}*\n`;
    comment += `*🆔 Analysis ID: \`${trackingId}\`*`;

    return comment;
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

  // Post a general comment on the PR (for notifications)
  async postGeneralComment(owner, repo, pullNumber, body) {
    try {
      const { data: comment } = await this.octokit.rest.issues.createComment({
        owner,
        repo,
        issue_number: pullNumber,
        body,
      });

      logger.info(`General comment posted: ${comment.id}`);
      return comment;
    } catch (error) {
      logger.error('Error posting general comment:', error);
      throw new Error(`Failed to post general comment: ${error.message}`);
    }
  }

  // Post review comment (for compatibility)
  async postReviewComment(owner, repo, pullNumber, comments) {
    try {
      logger.info(`Posting review comments for ${owner}/${repo}#${pullNumber}`);

      const reviewBody = typeof comments === 'string' ? comments : this.formatReviewBody(comments);
      
      const { data: review } = await this.octokit.rest.pulls.createReview({
        owner,
        repo,
        pull_number: pullNumber,
        event: 'COMMENT',
        body: reviewBody,
        comments: comments.inlineComments || [],
      });

      logger.info(`Review posted successfully: ${review.id}`);
      return review;
    } catch (error) {
      logger.error('Error posting review comment:', error);
      throw new Error(`Failed to post review comment: ${error.message}`);
    }
  }

  // Format review body (legacy compatibility)
  formatReviewBody(analysis) {
    if (typeof analysis === 'string') {
      return analysis;
    }
    
    // If it's the new structured format, use the enhanced formatter
    if (analysis.prInfo) {
      return this.formatEnhancedStructuredComment(analysis, analysis.trackingId || 'unknown');
    }
    
    // Legacy format handling
    const { summary, issues, recommendations } = analysis;
    
    let body = `## 🤖 AI Code Review Summary\n\n`;
    body += `**Overall Rating:** ${summary?.overallRating || 'UNKNOWN'}\n`;
    body += `**Total Issues:** ${summary?.totalIssues || 0}\n\n`;
    
    if (recommendations && recommendations.length > 0) {
      body += `### 💡 Recommendations\n`;
      recommendations.forEach(rec => {
        body += `- ${rec}\n`;
      });
    }
    
    return body;
  }

  // Create check run for AI Review button
  async createCheckRun(owner, repo, checkRunData) {
    try {
      logger.info(`Creating check run: ${checkRunData.name} for ${owner}/${repo}`);
      
      const { data: checkRun } = await this.octokit.rest.checks.create({
        owner,
        repo,
        ...checkRunData,
      });

      logger.info(`Check run created: ${checkRun.id}`);
      return checkRun;
    } catch (error) {
      logger.error('Error creating check run:', error);
      throw new Error(`Failed to create check run: ${error.message}`);
    }
  }

  // Update existing check run
  async updateCheckRun(owner, repo, checkRunId, updateData) {
    try {
      const { data: checkRun } = await this.octokit.rest.checks.update({
        owner,
        repo,
        check_run_id: checkRunId,
        ...updateData,
      });

      logger.info(`Check run updated: ${checkRunId} - ${updateData.status}`);
      return checkRun;
    } catch (error) {
      logger.error(`Error updating check run ${checkRunId}:`, error);
      throw new Error(`Failed to update check run: ${error.message}`);
    }
  }

  // Update an existing comment
  async updateComment(owner, repo, commentId, body) {
    try {
      const { data: comment } = await this.octokit.rest.issues.updateComment({
        owner,
        repo,
        comment_id: commentId,
        body,
      });

      logger.info(`Comment updated: ${commentId}`);
      return comment;
    } catch (error) {
      logger.error('Error updating comment:', error);
      throw new Error(`Failed to update comment: ${error.message}`);
    }
  }

  // Delete a comment
  async deleteComment(owner, repo, commentId) {
    try {
      await this.octokit.rest.issues.deleteComment({
        owner,
        repo,
        comment_id: commentId,
      });
      logger.info(`Comment deleted: ${commentId}`);
    } catch (error) {
      logger.warn(`Failed to delete comment ${commentId}:`, error.message);
    }
  }

  // Check if branch is in target branches list
  isTargetBranch(branch) {
    return config.review.targetBranches.includes(branch);
  }
}

module.exports = new GitHubService();