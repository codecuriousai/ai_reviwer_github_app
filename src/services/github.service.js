// src/services/github.service.js - Updated for Single Comment Format

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

  // Post single structured comment (main function)
  async postStructuredReviewComment(owner, repo, pullNumber, analysis) {
    try {
      logger.info(`Posting structured review comment for ${owner}/${repo}#${pullNumber}`);

      const commentBody = this.formatStructuredReviewComment(analysis);
      
      const { data: comment } = await this.octokit.rest.issues.createComment({
        owner,
        repo,
        issue_number: pullNumber,
        body: commentBody,
      });

      logger.info(`Structured review comment posted: ${comment.id}`);
      return comment;
    } catch (error) {
      logger.error('Error posting structured review comment:', error);
      throw new Error(`Failed to post structured review comment: ${error.message}`);
    }
  }

  // Format the structured review comment matching your expected format
  formatStructuredReviewComment(analysis) {
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
    comment += `• PR ID: ${prInfo.prId}\n`;
    comment += `• Title: ${prInfo.title}\n`;
    comment += `• Repository: ${prInfo.repository}\n`;
    comment += `• Author: ${prInfo.author}\n`;
    comment += `• Reviewer(s): ${prInfo.reviewers.length > 0 ? prInfo.reviewers.join(', ') : 'None yet'}\n`;
    comment += `• URL: ${prInfo.url}\n\n`;

    // Automated Analysis Results
    comment += `🤖 **AUTOMATED ANALYSIS RESULTS:**\n`;
    comment += `• Issues Found: ${automatedAnalysis.totalIssues}\n`;
    comment += `• Severity Breakdown: 🚫 ${automatedAnalysis.severityBreakdown.blocker} | `;
    comment += `🔴 ${automatedAnalysis.severityBreakdown.critical} | `;
    comment += `🟡 ${automatedAnalysis.severityBreakdown.major} | `;
    comment += `🔵 ${automatedAnalysis.severityBreakdown.minor} | `;
    comment += `ℹ️ ${automatedAnalysis.severityBreakdown.info}\n`;
    comment += `• Categories: 🐛 ${automatedAnalysis.categories.bugs} | `;
    comment += `🔒 ${automatedAnalysis.categories.vulnerabilities} | `;
    comment += `⚠️ ${automatedAnalysis.categories.securityHotspots} | `;
    comment += `💨 ${automatedAnalysis.categories.codeSmells}\n`;
    comment += `• Technical Debt: ${automatedAnalysis.technicalDebtMinutes} minutes\n\n`;

    // Human Review Analysis
    comment += `👥 **HUMAN REVIEW ANALYSIS:**\n`;
    comment += `• Review Comments: ${humanReviewAnalysis.reviewComments}\n`;
    comment += `• Issues Addressed by Reviewers: ${humanReviewAnalysis.issuesAddressedByReviewers}\n`;
    comment += `• Security Issues Caught: ${humanReviewAnalysis.securityIssuesCaught}\n`;
    comment += `• Code Quality Issues Caught: ${humanReviewAnalysis.codeQualityIssuesCaught}\n\n`;

    // Review Assessment
    comment += `⚖️ **REVIEW ASSESSMENT:**\n`;
    comment += `${reviewAssessment}\n\n`;

    // Detailed Findings
    if (detailedFindings && detailedFindings.length > 0) {
      comment += `📝 **DETAILED FINDINGS:**\n`;
      detailedFindings.forEach((finding, index) => {
        const severityEmoji = {
          'BLOCKER': '🚫',
          'CRITICAL': '🔴', 
          'MAJOR': '🟡',
          'MINOR': '🔵',
          'INFO': 'ℹ️'
        };
        
        const categoryEmoji = {
          'BUG': '🐛',
          'VULNERABILITY': '🔒',
          'SECURITY_HOTSPOT': '⚠️',
          'CODE_SMELL': '💨'
        };

        comment += `${index + 1}. ${severityEmoji[finding.severity]} ${categoryEmoji[finding.category]} **${finding.file}:${finding.line}**\n`;
        comment += `   └ ${finding.issue}\n`;
        comment += `   └ *Suggestion: ${finding.suggestion}*\n\n`;
      });
    } else {
      comment += `📝 **DETAILED FINDINGS:**\n`;
      comment += `No additional issues found that were missed by reviewers.\n\n`;
    }

    // Recommendation
    comment += `🎯 **RECOMMENDATION:**\n`;
    comment += `${recommendation}\n\n`;

    // Footer
    comment += `---\n`;
    comment += `*🔧 Analysis completed by AI Code Reviewer using SonarQube Standards*\n`;
    comment += `*⏱️ Generated at: ${new Date().toISOString()}*`;

    return comment;
  }

  // Check if branch is in target branches list
  isTargetBranch(branch) {
    return config.review.targetBranches.includes(branch);
  }
}

module.exports = new GitHubService();