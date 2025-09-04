// src/services/github.service.js - Updated with Hybrid Commenting Workflow

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
          head: { sha: pr.head.sha },
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
  
  // COMPLETELY REWRITTEN: This new function accurately finds a commentable line in the diff, fixing Bug #2.
  async findCommentableLine(owner, repo, pullNumber, filePath, targetLine) {
    try {
        const { data: files } = await this.octokit.rest.pulls.listFiles({
            owner,
            repo,
            pull_number: pullNumber,
        });

        const targetFile = files.find(file => file.filename === filePath);
        if (!targetFile || !targetFile.patch) {
            logger.warn(`File not found in PR diff or has no patch: ${filePath}`);
            return null;
        }

        const patchLines = targetFile.patch.split('\n');
        let currentFileLine = 0;
        let lastAddedLineInHunk = null;

        for (const line of patchLines) {
            if (line.startsWith('@@')) {
                const match = line.match(/\+(\d+)/);
                if (match && match[1]) {
                    currentFileLine = parseInt(match[1], 10);
                    lastAddedLineInHunk = null; // Reset for new hunk
                }
                continue;
            }
            
            // We only care about lines that exist in the "new" version of the file.
            if (!line.startsWith('-')) {
              // If the line is an addition, it's a potential anchor for our comment.
              if (line.startsWith('+')) {
                lastAddedLineInHunk = currentFileLine;
              }
              
              // If we've found our target line number...
              if (currentFileLine === targetLine) {
                  // ...and it's an added line, it's a perfect match.
                  if (line.startsWith('+')) {
                    logger.info(`Found exact match for commentable line ${targetLine} in ${filePath}.`);
                    return currentFileLine;
                  } else {
                    // ...but it's a context line, we snap to the last added line in this hunk.
                    logger.info(`Target line ${targetLine} for ${filePath} is a context line. Snapping to the last added line in the hunk: ${lastAddedLineInHunk || 'N/A'}.`);
                    return lastAddedLineInHunk;
                  }
              }

              currentFileLine++;
            }
        }
        
        // Fallback if the exact line is not found (e.g., AI was off by a few lines).
        // Return the last added line in the diff as the best possible guess.
        logger.warn(`Could not find exact line ${targetLine} for ${filePath}. Falling back to last added line: ${lastAddedLineInHunk || 'N/A'}.`);
        return lastAddedLineInHunk;

    } catch (error) {
        logger.error(`Error in findCommentableLine for ${filePath}:${targetLine}:`, error);
        return null;
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

  // MODIFIED: Posts a single review comment. This is used for individual comments.
  async postIndividualReviewComment(owner, repo, pullNumber, headSha, filePath, line, body) {
    try {
      const { data: comment } = await this.octokit.rest.pulls.createReviewComment({
        owner,
        repo,
        pull_number: pullNumber,
        commit_id: headSha,
        path: filePath,
        line: line,
        body: body,
      });
      logger.info(`Individual review comment posted: ${comment.id}`);
      return comment;
    } catch (error) {
      logger.error('Error posting individual review comment:', error);
      throw new Error(`Failed to post individual review comment: ${error.message}`);
    }
  }
  
  // NEW: Posts a full review with a main body and multiple threaded comments.
  // This is used for the "Post All Comments" action.
  async postThreadedReview(owner, repo, pullNumber, headSha, body, inlineComments) {
    try {
      logger.info(`Posting threaded review with ${inlineComments.length} comments for ${owner}/${repo}#${pullNumber}`);
      
      const review = await this.octokit.rest.pulls.createReview({
        owner,
        repo,
        pull_number: pullNumber,
        commit_id: headSha,
        event: 'COMMENT', // Use 'COMMENT' to submit without approving/requesting changes
        body: body, // The main review comment body
        comments: inlineComments.map(comment => ({
          path: comment.path,
          line: comment.line,
          body: comment.body,
        })),
      });

      logger.info(`Threaded review posted successfully: ${review.data.id}`);
      return review;
    } catch (error) {
      logger.error('Error posting threaded review:', error);
      throw new Error(`Failed to post threaded review: ${error.message}`);
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

  // MODIFIED: Post structured comment as a general comment on the PR.
  // This is for the initial review summary, as requested.
  async postStructuredReviewComment(owner, repo, pullNumber, analysis) {
    try {
      logger.info(`Posting enhanced structured review as general comment for ${owner}/${repo}#${pullNumber}`);

      // Generate the main comment body
      const commentBody = this.formatEnhancedStructuredComment(analysis);
      
      const { data: comment } = await this.octokit.rest.issues.createComment({
        owner,
        repo,
        issue_number: pullNumber,
        body: commentBody,
      });

      logger.info(`Enhanced structured review as general comment posted: ${comment.id}`);
      return comment;
    } catch (error) {
      logger.error('Error posting enhanced structured review comment:', error);
      throw new Error(`Failed to post enhanced structured review comment: ${error.message}`);
    }
  }

  // MODIFIED: Format structured comment (for main review body)
  formatEnhancedStructuredComment(analysis) {
    const { 
      prInfo, 
      automatedAnalysis, 
      humanReviewAnalysis, 
      reviewAssessment, 
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
    comment += `💨 ${categories.codeSmell || 0}\n`;
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

    // Recommendation
    comment += `🎯 **RECOMMENDATION:**\n`;
    comment += `${recommendation || 'No specific recommendation available'}\n\n`;
    
    // Interactive Commenting Instructions (now as a footer)
    comment += `---
    *🔧 Analysis completed by AI Code Reviewer using SonarQube Standards*
    *⏱️ Generated at: ${new Date().toISOString()}*
    *🆔 Analysis ID: \`${analysis.trackingId}\`*\n\n`;
    
    comment += `💬 **How to Post Code Suggestions:**
    *Use the interactive buttons in the AI Code Review check run to post individual or all findings directly to the code.*
    *Individual comments will be posted as separate review comments. Clicking "Post All Comments" will create a single, consolidated review with threaded comments.*`;

    return comment;
  }

  // MODIFIED: Format inline comment with code suggestions
  formatInlineComment(finding, trackingId) {
    const severityEmoji = this.getSeverityEmoji(finding.severity);
    const categoryEmoji = this.getCategoryEmoji(finding.category);

    let comment = `${severityEmoji} ${categoryEmoji} **AI Code Review Finding**\n\n`;
    comment += `**Issue:** ${finding.issue}\n\n`;
    comment += `**Severity:** ${finding.severity}\n`;
    comment += `**Category:** ${finding.category}\n\n`;
    comment += `**Suggestion:**\n\`\`\`suggestion\n${finding.suggestion}\n\`\`\`\n\n`;
    comment += `---\n`;
    comment += `*Posted via AI Code Reviewer | Analysis ID: \`${trackingId}\`*`;

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

      logger.info(`Check run updated: ${checkRunId} - Status: ${updateData.status || 'updated'}`);
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

