// src/services/github.service.js - Enhanced with Interactive Comment Support and Correct Line Finding

const { Octokit } = require('@octokit/rest');
const { createAppAuth } = require('@octokit/auth-app');
const fs = require('fs');
const path = require('path');
const config = require('../config/config');
const logger = require('../utils/logger');

// Import interactive comment service to avoid loading issues
let interactiveCommentService;
try {
  interactiveCommentService = require('./interactive-comment.service');
} catch (error) {
  logger.warn('Interactive comment service not available:', error.message);
}

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

  // NEW: Finds the closest line in the diff that can be commented on.
  async findCommentableLine(owner, repo, pullNumber, filePath, targetLine) {
    try {
      logger.info(`Finding commentable line for ${filePath}:${targetLine} in PR #${pullNumber}`);

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

      // Parse the diff to build accurate line mapping
      const lineMapping = this.parseDiffLineMapping(targetFile.patch);

      // Find the exact commentable line for the target
      const commentableLine = this.findExactCommentableLine(lineMapping, targetLine);

      if (commentableLine) {
        logger.info(`Found exact commentable line ${commentableLine} for target ${targetLine} in ${filePath}`);
        return commentableLine;
      }

      // If exact line not found, try to find nearest commentable line in same context
      const nearestLine = this.findNearestCommentableLine(lineMapping, targetLine);

      if (nearestLine) {
        logger.info(`Using nearest commentable line ${nearestLine} for target ${targetLine} in ${filePath} (original line not in diff)`);
        return nearestLine;
      }

      logger.error(`No commentable line found near ${targetLine} for file ${filePath}`);
      return null;

    } catch (error) {
      logger.error(`Error finding commentable line for ${filePath}:${targetLine}:`, error);
      return null;
    }
  }

  // NEW: Parse diff patch to create accurate line mapping
  parseDiffLineMapping(patch) {
    const lines = patch.split('\n');
    const mapping = {
      commentableLines: new Set(), // Lines that can receive comments (added or modified)
      fileLineToCommentLine: new Map(), // Maps file line number to commentable line number
      contextLines: new Map(), // Maps file line to context info
      hunks: []
    };

    let currentHunk = null;
    let oldLineNum = 0;
    let newLineNum = 0;

    for (let i = 0; i < lines.length; i++) {
      const line = lines[i];

      // Parse hunk header: @@ -oldStart,oldCount +newStart,newCount @@
      if (line.startsWith('@@')) {
        const hunkMatch = line.match(/@@\s*-(\d+),?\d*\s*\+(\d+),?\d*\s*@@/);
        if (hunkMatch) {
          oldLineNum = parseInt(hunkMatch[1]) - 1; // -1 because we increment before processing
          newLineNum = parseInt(hunkMatch[2]) - 1; // -1 because we increment before processing

          currentHunk = {
            oldStart: parseInt(hunkMatch[1]),
            newStart: parseInt(hunkMatch[2]),
            lines: []
          };
          mapping.hunks.push(currentHunk);
        }
        continue;
      }

      if (!currentHunk) continue;

      const lineType = line.charAt(0);
      const content = line.slice(1);

      if (lineType === '-') {
        // Deleted line - only increment old line number
        oldLineNum++;
        currentHunk.lines.push({
          type: 'deleted',
          oldLine: oldLineNum,
          newLine: null,
          content
        });
      }
      else if (lineType === '+') {
        // Added line - increment new line number and mark as commentable
        newLineNum++;
        mapping.commentableLines.add(newLineNum);
        mapping.fileLineToCommentLine.set(newLineNum, newLineNum);

        currentHunk.lines.push({
          type: 'added',
          oldLine: null,
          newLine: newLineNum,
          content,
          commentable: true
        });
      }
      else if (lineType === ' ') {
        // Context line - increment both line numbers
        oldLineNum++;
        newLineNum++;
        mapping.contextLines.set(newLineNum, {
          oldLine: oldLineNum,
          newLine: newLineNum,
          content
        });

        currentHunk.lines.push({
          type: 'context',
          oldLine: oldLineNum,
          newLine: newLineNum,
          content
        });
      }
    }

    logger.debug(`Parsed diff mapping for file`, {
      commentableLines: Array.from(mapping.commentableLines),
      totalHunks: mapping.hunks.length,
      fileLineMapping: Array.from(mapping.fileLineToCommentLine.entries())
    });

    return mapping;
  }

  // NEW: Find exact commentable line for target
  findExactCommentableLine(mapping, targetLine) {
    // Check if target line is directly commentable (was added/modified)
    if (mapping.commentableLines.has(targetLine)) {
      return targetLine;
    }

    // Check if we have a direct mapping
    if (mapping.fileLineToCommentLine.has(targetLine)) {
      return mapping.fileLineToCommentLine.get(targetLine);
    }

    return null;
  }

  // NEW: Find nearest commentable line within reasonable range
  findNearestCommentableLine(mapping, targetLine) {
    const commentableLines = Array.from(mapping.commentableLines).sort((a, b) => a - b);

    if (commentableLines.length === 0) {
      return null;
    }

    // Find the closest commentable line within a reasonable range (±10 lines)
    const maxDistance = 10;
    let closest = null;
    let minDistance = Infinity;

    for (const commentableLine of commentableLines) {
      const distance = Math.abs(commentableLine - targetLine);
      if (distance <= maxDistance && distance < minDistance) {
        minDistance = distance;
        closest = commentableLine;
      }
    }

    // Prefer lines after the target over lines before (more natural for code review)
    if (closest === null) {
      const linesAfter = commentableLines.filter(line => line > targetLine && line - targetLine <= maxDistance);
      if (linesAfter.length > 0) {
        closest = linesAfter[0]; // First line after target
      }
    }

    return closest;
  }

  // NEW: Validate that a line can receive comments
  async validateCommentableLine(owner, repo, pullNumber, filePath, lineNumber) {
    try {
      const { data: files } = await this.octokit.rest.pulls.listFiles({
        owner,
        repo,
        pull_number: pullNumber,
      });

      const targetFile = files.find(file => file.filename === filePath);
      if (!targetFile || !targetFile.patch) {
        return false;
      }

      const mapping = this.parseDiffLineMapping(targetFile.patch);
      return mapping.commentableLines.has(lineNumber);

    } catch (error) {
      logger.error(`Error validating commentable line ${filePath}:${lineNumber}:`, error);
      return false;
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

  // NEW: Post multiple comments in a single review
  async postReviewComments(owner, repo, pullNumber, headSha, comments) {
    try {
      if (!Array.isArray(comments) || comments.length === 0) {
        logger.info('No comments to post, skipping review creation.');
        return;
      }

      logger.info(`Posting ${comments.length} review comments for ${owner}/${repo}#${pullNumber}`);

      const review = await this.octokit.rest.pulls.createReview({
        owner,
        repo,
        pull_number: pullNumber,
        commit_id: headSha,
        event: 'COMMENT', // Use 'COMMENT' to submit without approving/requesting changes
        comments: comments.map(comment => ({
          path: comment.path,
          line: comment.line,
          body: comment.body,
          // You may also want to include start_line/start_side for multi-line comments
        })),
      });

      logger.info(`Review with comments posted successfully: ${review.data.id}`);
      return review;
    } catch (error) {
      logger.error('Error posting review with comments:', error);
      throw new Error(`Failed to post review with comments: ${error.message}`);
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

      // Store pending comments for interactive posting
      const trackingId = analysis.trackingId || `analysis-${Date.now()}`;
      analysis.trackingId = trackingId; // Ensure trackingId is set

      if (analysis.detailedFindings && analysis.detailedFindings.length > 0 && interactiveCommentService) {
        try {
          interactiveCommentService.storePendingComments(
            owner, repo, pullNumber,
            analysis.detailedFindings,
            trackingId
          );
        } catch (error) {
          logger.warn('Failed to store pending comments:', error.message);
          // Continue with normal flow even if this fails
        }
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

      // COMMENTED OUT: Interactive comment instructions - no longer needed with button interface
      /*
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
      */

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

    // COMMENTED OUT: Interactive Instructions Section - no longer needed with button interface
    /*
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
    */

    // Recommendation
    comment += `🎯 **RECOMMENDATION:**\n`;
    comment += `${recommendation || 'No specific recommendation available'}\n\n`;

    // REMOVED: Footer clutter for cleaner UI
    // comment += `---\n`;
    // comment += `*🔧 Analysis completed by AI Code Reviewer using SonarQube Standards*\n`;
    // comment += `*⏱️ Generated at: ${new Date().toISOString()}*\n`;
    // comment += `*🆔 Analysis ID: \`${trackingId}\`*`;

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

  // NEW: Post reply to an existing comment (threaded comment)
  async postCommentReply(owner, repo, pullNumber, parentCommentId, body) {
    try {
      // GitHub doesn't support true threaded replies, so we'll post a new comment
      // that references the parent comment
      const replyBody = `> Reply to [comment #${parentCommentId}]\n\n${body}`;
      
      const { data: comment } = await this.octokit.rest.issues.createComment({
        owner,
        repo,
        issue_number: pullNumber,
        body: replyBody,
      });

      logger.info(`Reply comment posted: ${comment.id} (parent: ${parentCommentId})`);
      return comment;
    } catch (error) {
      logger.error('Error posting reply comment:', error);
      throw new Error(`Failed to post reply comment: ${error.message}`);
    }
  }

  // NEW: Get file content from repository
  async getFileContent(owner, repo, path, ref = 'main') {
    try {
      const { data } = await this.octokit.rest.repos.getContent({
        owner,
        repo,
        path,
        ref
      });

      if (data.type === 'file') {
        return {
          content: Buffer.from(data.content, 'base64').toString('utf8'),
          sha: data.sha,
          size: data.size
        };
      }
      
      return null;
    } catch (error) {
      logger.error(`Error getting file content for ${path}:`, error);
      return null;
    }
  }

  // NEW: Update file content in repository
  async updateFileContent(owner, repo, path, branch, content, message, sha) {
    try {
      const { data } = await this.octokit.rest.repos.createOrUpdateFileContents({
        owner,
        repo,
        path,
        message,
        content: Buffer.from(content).toString('base64'),
        branch,
        sha
      });

      logger.info(`File updated: ${path} on branch ${branch}`);
      return data;
    } catch (error) {
      logger.error(`Error updating file content for ${path}:`, error);
      throw new Error(`Failed to update file: ${error.message}`);
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

      // Validate GitHub API limits before sending
      this.validateCheckRunData(checkRunData);

      const { data: checkRun } = await this.octokit.rest.checks.create({
        owner,
        repo,
        ...checkRunData,
      });

      logger.info(`Check run created: ${checkRun.id}`);
      return checkRun;
    } catch (error) {
      logger.error('Error creating check run:', error);
      logger.error('Check run data that failed:', {
        name: checkRunData.name,
        status: checkRunData.status,
        conclusion: checkRunData.conclusion,
        summaryLength: checkRunData.output?.summary?.length,
        textLength: checkRunData.output?.text?.length,
        actionsCount: checkRunData.actions?.length,
        actions: checkRunData.actions?.map(a => ({ label: a.label, identifier: a.identifier }))
      });
      throw new Error(`Failed to create check run: ${error.message}`);
    }
  }

  // Validate check run data against GitHub limits
  validateCheckRunData(checkRunData) {
    const { name, output, actions } = checkRunData;

    // Check name length (20 characters max)
    if (name && name.length > 20) {
      throw new Error(`Check run name too long: ${name.length} chars (max 20)`);
    }

    // Check output limits
    if (output) {
      if (output.title && output.title.length > 255) {
        throw new Error(`Output title too long: ${output.title.length} chars (max 255)`);
      }
      if (output.summary && output.summary.length > 65535) {
        throw new Error(`Output summary too long: ${output.summary.length} chars (max 65535)`);
      }
      if (output.text && output.text.length > 65535) {
        throw new Error(`Output text too long: ${output.text.length} chars (max 65535)`);
      }
    }

    // Check actions limits
    if (actions) {
      if (actions.length > 3) {
        throw new Error(`Too many actions: ${actions.length} (max 3)`);
      }
      actions.forEach((action, index) => {
        if (action.label && action.label.length > 20) {
          throw new Error(`Action ${index} label too long: ${action.label.length} chars (max 20)`);
        }
        if (action.description && action.description.length > 40) {
          throw new Error(`Action ${index} description too long: ${action.description.length} chars (max 40)`);
        }
        if (action.identifier && action.identifier.length > 20) {
          throw new Error(`Action ${index} identifier too long: ${action.identifier.length} chars (max 20)`);
        }
      });
    }

    logger.info('Check run data validation passed', {
      nameLength: name?.length,
      titleLength: output?.title?.length,
      summaryLength: output?.summary?.length,
      textLength: output?.text?.length,
      actionsCount: actions?.length
    });
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



  // Debug method to analyze line mapping issues
  async debugLineMapping(owner, repo, pullNumber, filePath) {
    try {
      logger.info(`Debugging line mapping for ${filePath} in PR #${pullNumber}`);

      const { data: files } = await this.octokit.rest.pulls.listFiles({
        owner,
        repo,
        pull_number: pullNumber,
      });

      const targetFile = files.find(file => file.filename === filePath);
      if (!targetFile) {
        logger.error(`File ${filePath} not found in PR #${pullNumber}`);
        return null;
      }

      if (!targetFile.patch) {
        logger.warn(`No patch data for ${filePath} in PR #${pullNumber}`);
        return { file: filePath, hasPatch: false, status: targetFile.status };
      }

      // Parse and analyze the diff
      const mapping = this.parseDiffLineMapping(targetFile.patch);

      const debugInfo = {
        file: filePath,
        status: targetFile.status,
        additions: targetFile.additions,
        deletions: targetFile.deletions,
        changes: targetFile.changes,
        hasPatch: true,
        commentableLines: Array.from(mapping.commentableLines).sort((a, b) => a - b),
        totalHunks: mapping.hunks.length,
        hunks: mapping.hunks.map(hunk => ({
          oldStart: hunk.oldStart,
          newStart: hunk.newStart,
          lineCount: hunk.lines.length,
          addedLines: hunk.lines.filter(l => l.type === 'added').map(l => l.newLine),
          contextLines: hunk.lines.filter(l => l.type === 'context').map(l => l.newLine)
        })),
        patchPreview: targetFile.patch.split('\n').slice(0, 10).join('\n')
      };

      logger.info(`Line mapping debug info for ${filePath}:`, debugInfo);
      return debugInfo;

    } catch (error) {
      logger.error(`Error debugging line mapping for ${filePath}:`, error);
      return { error: error.message };
    }
  }

  // Enhanced validation with detailed error reporting
  async validateAndReportLineIssues(owner, repo, pullNumber, findings) {
    const validationReport = {
      totalFindings: findings.length,
      validFindings: 0,
      invalidFindings: 0,
      adjustableFindings: 0,
      unadjustableFindings: 0,
      issues: []
    };

    for (let i = 0; i < findings.length; i++) {
      const finding = findings[i];

      try {
        const isValid = await this.validateCommentableLine(owner, repo, pullNumber, finding.file, finding.line);

        if (isValid) {
          validationReport.validFindings++;
        } else {
          validationReport.invalidFindings++;

          // Try to find an alternative
          const adjustedLine = await this.findCommentableLine(owner, repo, pullNumber, finding.file, finding.line);

          if (adjustedLine) {
            validationReport.adjustableFindings++;
            validationReport.issues.push({
              index: i,
              file: finding.file,
              originalLine: finding.line,
              adjustedLine: adjustedLine,
              type: 'adjustable',
              message: `Line ${finding.line} not commentable, can adjust to line ${adjustedLine}`
            });
          } else {
            validationReport.unadjustableFindings++;
            validationReport.issues.push({
              index: i,
              file: finding.file,
              originalLine: finding.line,
              type: 'unadjustable',
              message: `Line ${finding.line} not commentable and no nearby alternative found`
            });
          }
        }
      } catch (error) {
        validationReport.unadjustableFindings++;
        validationReport.issues.push({
          index: i,
          file: finding.file,
          originalLine: finding.line,
          type: 'error',
          message: `Validation error: ${error.message}`
        });
      }
    }

    logger.info(`Line validation report for PR #${pullNumber}:`, {
      summary: {
        total: validationReport.totalFindings,
        valid: validationReport.validFindings,
        adjustable: validationReport.adjustableFindings,
        problematic: validationReport.unadjustableFindings
      },
      issueCount: validationReport.issues.length
    });

    return validationReport;
  }

  // Add to ai.service.js for better error context in analysis
  enhanceAnalysisWithLineValidation(analysis, owner, repo, pullNumber) {
    // Add a validation promise that can be awaited later
    analysis.lineValidation = this.validateFindings(analysis.detailedFindings, owner, repo, pullNumber);
    return analysis;
  }

  async validateFindings(findings, owner, repo, pullNumber) {
    if (!findings || findings.length === 0) {
      return { valid: true, issues: [] };
    }

    const issues = [];
    let validCount = 0;

    for (const finding of findings) {
      if (!finding.file || !finding.line || finding.line <= 0) {
        issues.push({
          file: finding.file || 'unknown',
          line: finding.line || 0,
          issue: 'Missing or invalid file/line information',
          severity: 'warning'
        });
        continue;
      }

      try {
        const githubService = require('./github.service');
        const isValid = await githubService.validateCommentableLine(owner, repo, pullNumber, finding.file, finding.line);

        if (isValid) {
          validCount++;
        } else {
          const adjustedLine = await githubService.findCommentableLine(owner, repo, pullNumber, finding.file, finding.line);

          if (adjustedLine) {
            issues.push({
              file: finding.file,
              line: finding.line,
              adjustedLine: adjustedLine,
              issue: 'Line not in diff, can be adjusted',
              severity: 'info'
            });
          } else {
            issues.push({
              file: finding.file,
              line: finding.line,
              issue: 'Line not in PR changes and no nearby alternative',
              severity: 'warning'
            });
          }
        }
      } catch (error) {
        issues.push({
          file: finding.file,
          line: finding.line,
          issue: `Validation error: ${error.message}`,
          severity: 'error'
        });
      }
    }

    return {
      valid: issues.filter(i => i.severity === 'error').length === 0,
      validCount,
      totalCount: findings.length,
      issues
    };
  }
}

module.exports = new GitHubService();
