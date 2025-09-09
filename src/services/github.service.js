// src/services/github.service.js - Enhanced with Interactive Comment Support and Correct Line Finding

const { Octokit } = require("@octokit/rest");
const { createAppAuth } = require("@octokit/auth-app");
const fs = require("fs");
const path = require("path");
const config = require("../config/config");
const logger = require("../utils/logger");
const aiService = require('./ai.service');
const fixHistoryService = require('./fix-history.service');
// Import interactive comment service to avoid loading issues
let interactiveCommentService;
try {
  interactiveCommentService = require("./interactive-comment.service");
} catch (error) {
  logger.warn("Interactive comment service not available:", error.message);
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
        logger.info(
          "Attempting to use base64 encoded private key from environment"
        );

        try {
          const base64Key = process.env.GITHUB_PRIVATE_KEY_BASE64.trim();

          // Validate base64 format
          if (!this.isValidBase64(base64Key)) {
            throw new Error("Invalid base64 format");
          }

          privateKeyContent = Buffer.from(base64Key, "base64").toString(
            "utf-8"
          );
          logger.info("Successfully decoded base64 private key");
        } catch (decodeError) {
          logger.error(
            "Failed to decode base64 private key:",
            decodeError.message
          );
          throw new Error(
            `Base64 private key decode failed: ${decodeError.message}`
          );
        }
      }

      // Method 2: Direct private key content (fallback)
      else if (process.env.GITHUB_PRIVATE_KEY) {
        logger.info("Using direct private key content from environment");
        privateKeyContent = process.env.GITHUB_PRIVATE_KEY.replace(
          /\\n/g,
          "\n"
        );
      }

      // Method 3: Private key file path (local development)
      else if (
        process.env.GITHUB_PRIVATE_KEY_PATH &&
        fs.existsSync(process.env.GITHUB_PRIVATE_KEY_PATH)
      ) {
        logger.info("Using private key from specified file path");
        privateKeyContent = fs.readFileSync(
          process.env.GITHUB_PRIVATE_KEY_PATH,
          "utf8"
        );
      }

      // Method 4: Default file location (local development fallback)
      else {
        const defaultPath = path.join(process.cwd(), "private-key.pem");
        if (fs.existsSync(defaultPath)) {
          logger.info("Using private key from default location");
          privateKeyContent = fs.readFileSync(defaultPath, "utf8");
        }
      }

      // Validate the private key content
      if (!privateKeyContent) {
        throw new Error(
          "No private key content found. Please set GITHUB_PRIVATE_KEY_BASE64 environment variable."
        );
      }

      // Validate private key format
      if (!this.validatePrivateKeyFormat(privateKeyContent)) {
        logger.error("Private key validation failed");
        throw new Error(
          "Invalid private key format. Expected PEM format starting with -----BEGIN"
        );
      }

      logger.info("Private key loaded and validated successfully");
      return privateKeyContent;
    } catch (error) {
      logger.error("Error getting GitHub private key:", error);
      throw new Error(`Failed to load GitHub private key: ${error.message}`);
    }
  }

  // Validate base64 format
  isValidBase64(str) {
    try {
      const decoded = Buffer.from(str, "base64").toString("base64");
      return decoded === str;
    } catch (error) {
      return false;
    }
  }

  // Validate private key format
  validatePrivateKeyFormat(keyContent) {
    if (!keyContent || typeof keyContent !== "string") {
      return false;
    }

    const trimmedKey = keyContent.trim();
    const hasBeginMarker = trimmedKey.includes("-----BEGIN");
    const hasEndMarker = trimmedKey.includes("-----END");
    const hasPrivateKeyLabel = trimmedKey.includes("PRIVATE KEY");

    return (
      hasBeginMarker &&
      hasEndMarker &&
      hasPrivateKeyLabel &&
      trimmedKey.length > 200
    );
  }

  // Test GitHub App authentication
  async testAuthentication() {
    try {
      const { data: app } = await this.octokit.rest.apps.getAuthenticated();
      logger.info(
        `GitHub App authenticated successfully: ${app.name} (ID: ${app.id})`
      );
      return { success: true, app: app.name, id: app.id };
    } catch (error) {
      logger.error("GitHub App authentication failed:", error);
      return { success: false, error: error.message };
    }
  }

  // Health check
  async healthCheck() {
    try {
      const authResult = await this.testAuthentication();
      return {
        status: authResult.success ? "healthy" : "unhealthy",
        authenticated: authResult.success,
        timestamp: new Date().toISOString(),
        ...(authResult.success
          ? { appName: authResult.app, appId: authResult.id }
          : { error: authResult.error }),
      };
    } catch (error) {
      return {
        status: "unhealthy",
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
      const comments = await this.getPullRequestComments(
        owner,
        repo,
        pullNumber
      );

      // Get reviewers list
      const reviewers = await this.getPullRequestReviewers(
        owner,
        repo,
        pullNumber
      );

      return {
        pr: {
          id: pr.id,
          number: pr.number,
          title: pr.title,
          description: pr.body || "",
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
      logger.error("Error fetching PR data:", error);
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

      const reviewers = Array.from(
        new Set(reviews.map((review) => review.user.login))
      );

      return reviewers;
    } catch (error) {
      logger.error("Error fetching PR reviewers:", error);
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
          format: "diff",
        },
      });

      return diff;
    } catch (error) {
      logger.error("Error fetching PR diff:", error);
      throw new Error(`Failed to fetch PR diff: ${error.message}`);
    }
  }

  // NEW: Finds the closest line in the diff that can be commented on.
  async findCommentableLine(owner, repo, pullNumber, filePath, targetLine) {
    try {
      logger.info(
        `Finding commentable line for ${filePath}:${targetLine} in PR #${pullNumber}`
      );

      const { data: files } = await this.octokit.rest.pulls.listFiles({
        owner,
        repo,
        pull_number: pullNumber,
      });

      const targetFile = files.find((file) => file.filename === filePath);
      if (!targetFile || !targetFile.patch) {
        logger.warn(`File not found in PR diff or has no patch: ${filePath}`);
        return null;
      }

      // Parse the diff to build accurate line mapping
      const lineMapping = this.parseDiffLineMapping(targetFile.patch);

      // Find the exact commentable line for the target
      const commentableLine = this.findExactCommentableLine(
        lineMapping,
        targetLine
      );

      if (commentableLine) {
        logger.info(
          `Found exact commentable line ${commentableLine} for target ${targetLine} in ${filePath}`
        );
        return commentableLine;
      }

      // If exact line not found, try to find nearest commentable line in same context
      const nearestLine = this.findNearestCommentableLine(
        lineMapping,
        targetLine
      );

      if (nearestLine) {
        logger.info(
          `Using nearest commentable line ${nearestLine} for target ${targetLine} in ${filePath} (original line not in diff)`
        );
        return nearestLine;
      }

      logger.error(
        `No commentable line found near ${targetLine} for file ${filePath}`
      );
      return null;
    } catch (error) {
      logger.error(
        `Error finding commentable line for ${filePath}:${targetLine}:`,
        error
      );
      return null;
    }
  }

  // NEW: Parse diff patch to create accurate line mapping
  parseDiffLineMapping(patch) {
    const lines = patch.split("\n");
    const mapping = {
      commentableLines: new Set(), // Lines that can receive comments (added or modified)
      fileLineToCommentLine: new Map(), // Maps file line number to commentable line number
      contextLines: new Map(), // Maps file line to context info
      hunks: [],
    };

    let currentHunk = null;
    let oldLineNum = 0;
    let newLineNum = 0;

    for (let i = 0; i < lines.length; i++) {
      const line = lines[i];

      // Parse hunk header: @@ -oldStart,oldCount +newStart,newCount @@
      if (line.startsWith("@@")) {
        const hunkMatch = line.match(/@@\s*-(\d+),?\d*\s*\+(\d+),?\d*\s*@@/);
        if (hunkMatch) {
          oldLineNum = parseInt(hunkMatch[1]) - 1; // -1 because we increment before processing
          newLineNum = parseInt(hunkMatch[2]) - 1; // -1 because we increment before processing

          currentHunk = {
            oldStart: parseInt(hunkMatch[1]),
            newStart: parseInt(hunkMatch[2]),
            lines: [],
          };
          mapping.hunks.push(currentHunk);
        }
        continue;
      }

      if (!currentHunk) continue;

      const lineType = line.charAt(0);
      const content = line.slice(1);

      if (lineType === "-") {
        // Deleted line - only increment old line number
        oldLineNum++;
        currentHunk.lines.push({
          type: "deleted",
          oldLine: oldLineNum,
          newLine: null,
          content,
        });
      } else if (lineType === "+") {
        // Added line - increment new line number and mark as commentable
        newLineNum++;
        mapping.commentableLines.add(newLineNum);
        mapping.fileLineToCommentLine.set(newLineNum, newLineNum);

        currentHunk.lines.push({
          type: "added",
          oldLine: null,
          newLine: newLineNum,
          content,
          commentable: true,
        });
      } else if (lineType === " ") {
        // Context line - increment both line numbers
        oldLineNum++;
        newLineNum++;
        mapping.contextLines.set(newLineNum, {
          oldLine: oldLineNum,
          newLine: newLineNum,
          content,
        });

        currentHunk.lines.push({
          type: "context",
          oldLine: oldLineNum,
          newLine: newLineNum,
          content,
        });
      }
    }

    logger.debug(`Parsed diff mapping for file`, {
      commentableLines: Array.from(mapping.commentableLines),
      totalHunks: mapping.hunks.length,
      fileLineMapping: Array.from(mapping.fileLineToCommentLine.entries()),
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
    const commentableLines = Array.from(mapping.commentableLines).sort(
      (a, b) => a - b
    );

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
      const linesAfter = commentableLines.filter(
        (line) => line > targetLine && line - targetLine <= maxDistance
      );
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

      const targetFile = files.find((file) => file.filename === filePath);
      if (!targetFile || !targetFile.patch) {
        return false;
      }

      const mapping = this.parseDiffLineMapping(targetFile.patch);
      return mapping.commentableLines.has(lineNumber);
    } catch (error) {
      logger.error(
        `Error validating commentable line ${filePath}:${lineNumber}:`,
        error
      );
      return false;
    }
  }

  // Get pull request review comments
 async getPullRequestComments(owner, repo, pullNumber) {
  try {
    // Fetch all types of comments including PR reviews
    const [reviewComments, issueComments, reviews] = await Promise.all([
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
      this.octokit.rest.pulls.listReviews({
        owner,
        repo,
        pull_number: pullNumber,
      })
    ]);

    const allComments = [
      // Review comments (line-specific)
      ...reviewComments.data.map((comment) => ({
        id: comment.id,
        user: {
          login: comment.user?.login,
          type: comment.user?.type || 'User'
        },
        body: comment.body || '',
        created_at: comment.created_at,
        updated_at: comment.updated_at,
        createdAt: comment.created_at, // Keep your existing field for backward compatibility
        
        // Review comment specific fields - CRITICAL for merge readiness
        path: comment.path,
        line: comment.line,
        original_line: comment.original_line,
        diff_hunk: comment.diff_hunk,
        pull_request_review_id: comment.pull_request_review_id,
        in_reply_to_id: comment.in_reply_to_id,
        
        // GitHub resolution status - MOST IMPORTANT for merge readiness
        resolved: comment.resolved || false,
        conversation_resolved: comment.conversation_resolved || false,
        
        // Author association for bot filtering
        author_association: comment.author_association || 'NONE',
        
        // Additional GitHub fields
        url: comment.url,
        html_url: comment.html_url,
        pull_request_url: comment.pull_request_url,
        
        // Your existing fields
        user: comment.user?.login, // Keep for backward compatibility
        type: "review",
      })),

      // Issue comments (general PR comments)
      ...issueComments.data.map((comment) => ({
        id: comment.id,
        user: {
          login: comment.user?.login,
          type: comment.user?.type || 'User'
        },
        body: comment.body || '',
        created_at: comment.created_at,
        updated_at: comment.updated_at,
        createdAt: comment.created_at, // Keep your existing field
        
        // No line-specific fields for issue comments
        path: null,
        line: null,
        original_line: null,
        diff_hunk: null,
        pull_request_review_id: null,
        in_reply_to_id: null,
        
        // Issue comments don't have resolved status in GitHub API
        resolved: false,
        conversation_resolved: false,
        
        // Author association for bot filtering
        author_association: comment.author_association || 'NONE',
        
        // Additional GitHub fields
        url: comment.url,
        html_url: comment.html_url,
        issue_url: comment.issue_url,
        
        // Your existing fields
        user: comment.user?.login, // Keep for backward compatibility
        type: "issue",
      })),

      // PR Reviews (APPROVED, CHANGES_REQUESTED, etc.)
      ...reviews.data
        .filter(review => review.body && review.body.trim()) // Only reviews with content
        .map((review) => ({
          id: review.id,
          user: {
            login: review.user?.login,
            type: review.user?.type || 'User'
          },
          body: review.body || '',
          created_at: review.submitted_at || review.created_at,
          updated_at: review.submitted_at || review.updated_at,
          createdAt: review.submitted_at || review.created_at, // Keep your existing field
          
          // No line-specific fields for review submissions
          path: null,
          line: null,
          original_line: null,
          diff_hunk: null,
          pull_request_review_id: review.id,
          in_reply_to_id: null,
          
          // Reviews don't have individual resolved status
          resolved: false,
          conversation_resolved: false,
          
          // Author association
          author_association: review.author_association || 'NONE',
          
          // Review-specific fields
          state: review.state, // APPROVED, CHANGES_REQUESTED, COMMENTED
          
          // Additional GitHub fields
          url: review.html_url,
          html_url: review.html_url,
          
          // Your existing fields
          user: review.user?.login, // Keep for backward compatibility
          type: "review_submission",
        }))
    ];

    // Sort by creation time (keep your existing sorting)
    return allComments.sort(
      (a, b) => new Date(a.createdAt) - new Date(b.createdAt)
    );
  } catch (error) {
    logger.error("Error fetching PR comments:", error);
    throw new Error(`Failed to fetch PR comments: ${error.message}`);
  }
}

  // NEW: Post multiple comments in a single review
  async postReviewComments(owner, repo, pullNumber, headSha, comments) {
    try {
      if (!Array.isArray(comments) || comments.length === 0) {
        logger.info("No comments to post, skipping review creation.");
        return;
      }

      logger.info(
        `Posting ${comments.length} review comments for ${owner}/${repo}#${pullNumber}`
      );

      const review = await this.octokit.rest.pulls.createReview({
        owner,
        repo,
        pull_number: pullNumber,
        commit_id: headSha,
        event: "COMMENT", // Use 'COMMENT' to submit without approving/requesting changes
        comments: comments.map((comment) => ({
          path: comment.path,
          line: comment.line,
          body: comment.body,
          // You may also want to include start_line/start_side for multi-line comments
        })),
      });

      logger.info(
        `Review with comments posted successfully: ${review.data.id}`
      );
      return review;
    } catch (error) {
      logger.error("Error posting review with comments:", error);
      throw new Error(`Failed to post review with comments: ${error.message}`);
    }
  }

  // Filter files based on configuration
  filterFiles(files) {
    const { excludeFiles, maxFilesToAnalyze, maxFileSizeBytes } = config.review;

    // Define coding file extensions to focus analysis on
    const codingExtensions = [
      '.js', '.jsx', '.ts', '.tsx', '.py', '.java', '.cpp', '.c', '.cs', '.php', 
      '.rb', '.go', '.rs', '.swift', '.kt', '.scala', '.dart', '.vue', '.svelte',
      '.html', '.css', '.scss', '.sass', '.less', '.styl', '.jsx', '.tsx'
    ];

    return files
      .filter((file) => {
        // Check file extension exclusions
        const isExcluded = excludeFiles.some((pattern) => {
          const regex = new RegExp(pattern.replace("*", ".*"));
          return regex.test(file.filename);
        });

        // Check if it's a coding file
        const isCodingFile = codingExtensions.some(ext => 
          file.filename.toLowerCase().endsWith(ext)
        );

        // Check file size
        const isTooLarge = file.changes > maxFileSizeBytes;

        // Only include added or modified files
        const isRelevant = ["added", "modified"].includes(file.status);

        // Focus on coding files only
        return !isExcluded && !isTooLarge && isRelevant && isCodingFile;
      })
      .slice(0, maxFilesToAnalyze);
  }

  // ENHANCED: Post structured comment with interactive buttons
  async postStructuredReviewComment(owner, repo, pullNumber, analysis) {
    try {
      logger.info(
        `Posting enhanced structured review comment for ${owner}/${repo}#${pullNumber}`
      );

      // Store pending comments for interactive posting
      const trackingId = analysis.trackingId || `analysis-${Date.now()}`;
      analysis.trackingId = trackingId; // Ensure trackingId is set

      if (
        analysis.detailedFindings &&
        analysis.detailedFindings.length > 0 &&
        interactiveCommentService
      ) {
        try {
          interactiveCommentService.storePendingComments(
            owner,
            repo,
            pullNumber,
            analysis.detailedFindings,
            trackingId
          );
        } catch (error) {
          logger.warn("Failed to store pending comments:", error.message);
          // Continue with normal flow even if this fails
        }
      }

      // Generate enhanced comment with interactive elements
      const commentBody = this.formatEnhancedStructuredComment(
        analysis,
        trackingId
      );

      const { data: comment } = await this.octokit.rest.issues.createComment({
        owner,
        repo,
        issue_number: pullNumber,
        body: commentBody,
      });

      logger.info(`Enhanced structured review comment posted: ${comment.id}`);
      return comment;
    } catch (error) {
      logger.error("Error posting enhanced structured review comment:", error);
      throw new Error(
        `Failed to post enhanced structured review comment: ${error.message}`
      );
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
      recommendation,
    } = analysis;

    let comment = `🔍 **MERGE REQUEST REVIEW ANALYSIS**\n`;
    comment += `==================================================\n\n`;

    // PR Information Section
    comment += `📋 **Pull Request Information:**\n`;
    comment += `• PR ID: ${prInfo.prId || "unknown"}\n`;
    comment += `• Title: ${prInfo.title || "No title"}\n`;
    comment += `• Repository: ${prInfo.repository || "unknown/unknown"}\n`;
    comment += `• Author: ${prInfo.author || "unknown"}\n`;
    comment += `• Reviewer(s): ${
      prInfo.reviewers && prInfo.reviewers.length > 0
        ? prInfo.reviewers.join(", ")
        : "None yet"
    }\n`;
    comment += `• URL: ${prInfo.url || "#"}\n\n`;

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
    comment += `• Technical Debt: ${
      automatedAnalysis.technicalDebtMinutes || 0
    } minutes\n\n`;

    // Human Review Analysis
    comment += `👥 **HUMAN REVIEW ANALYSIS:**\n`;
    comment += `• Review Comments: ${
      humanReviewAnalysis.reviewComments || 0
    }\n`;
    comment += `• Issues Addressed by Reviewers: ${
      humanReviewAnalysis.issuesAddressedByReviewers || 0
    }\n`;
    comment += `• Security Issues Caught: ${
      humanReviewAnalysis.securityIssuesCaught || 0
    }\n`;
    comment += `• Code Quality Issues Caught: ${
      humanReviewAnalysis.codeQualityIssuesCaught || 0
    }\n\n`;

    // Review Assessment
    comment += `⚖️ **REVIEW ASSESSMENT:**\n`;
    comment += `${reviewAssessment || "REVIEW REQUIRED"}\n\n`;

    // COMMENTED OUT: Detailed Findings heading for cleaner UI
    // comment += `🔍 **DETAILED FINDINGS:**\n`;

    if (
      detailedFindings &&
      Array.isArray(detailedFindings) &&
      detailedFindings.length > 0
    ) {
      // Filter postable findings (ones with valid file/line info)
      const postableFindings = detailedFindings.filter(
        (finding) =>
          finding.file &&
          finding.file !== "unknown-file" &&
          finding.line &&
          finding.line > 0 &&
          finding.file !== "AI_ANALYSIS_ERROR"
      );

      const nonPostableFindings = detailedFindings.filter(
        (finding) =>
          !finding.file ||
          finding.file === "unknown-file" ||
          !finding.line ||
          finding.line <= 0 ||
          finding.file === "AI_ANALYSIS_ERROR"
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

          comment += `**${
            postableFindings.length + index + 1
          }.** ${severityEmoji} ${categoryEmoji} **${
            finding.file || "General"
          }**\n`;
          comment += `   └─ **Issue:** ${finding.issue}\n`;
          comment += `   └─ **Technical Debt:** ${finding.technicalDebtMinutes || 0} minutes\n`;
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
    comment += `${
      recommendation || "No specific recommendation available"
    }\n\n`;

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
      BLOCKER: "🚫",
      CRITICAL: "🔴",
      MAJOR: "🟡",
      MINOR: "🔵",
      INFO: "ℹ️",
    };
    return emojiMap[severity] || "ℹ️";
  }

  // Helper: Get category emoji
  getCategoryEmoji(category) {
    const emojiMap = {
      BUG: "🐛",
      VULNERABILITY: "🔒",
      SECURITY_HOTSPOT: "⚠️",
      CODE_SMELL: "💨",
    };
    return emojiMap[category] || "💨";
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
      logger.error("Error posting general comment:", error);
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

      logger.info(
        `Reply comment posted: ${comment.id} (parent: ${parentCommentId})`
      );
      return comment;
    } catch (error) {
      logger.error("Error posting reply comment:", error);
      throw new Error(`Failed to post reply comment: ${error.message}`);
    }
  }

  // MODIFIED: Get file content from repository with fallback branches
  // async getFileContent(owner, repo, path, ref = 'main') {
  //   const branchesToTry = [ref];

  //   // If not main branch, also try main as fallback
  //   if (ref !== 'main') {
  //     branchesToTry.push('main');
  //   }

  //   // Also try common default branches
  //   if (!branchesToTry.includes('master')) {
  //     branchesToTry.push('master');
  //   }

  //   for (const branch of branchesToTry) {
  //     try {
  //       logger.info(`Attempting to get file content for ${path} from branch: ${branch}`);

  //       const { data } = await this.octokit.rest.repos.getContent({
  //         owner,
  //         repo,
  //         path,
  //         ref: branch
  //       });

  //       if (data.type === 'file') {
  //         logger.info(`Successfully found file ${path} on branch: ${branch}`);
  //         return {
  //           content: Buffer.from(data.content, 'base64').toString('utf8'),
  //           sha: data.sha,
  //           size: data.size,
  //           branch: branch // Include which branch was used
  //         };
  //       }
  //     } catch (error) {
  //       logger.warn(`File ${path} not found on branch ${branch}: ${error.message}`);
  //       // Continue to next branch
  //     }
  //   }

  //   logger.error(`File ${path} not found on any branch: ${branchesToTry.join(', ')}`);
  //   return null;
  // }
  async getFileContent(owner, repo, path, ref = null) {
    try {
      // Step 1: If no ref provided, get the default branch
      let branchesToTry = [];

      if (ref) {
        branchesToTry.push(ref);
      } else {
        // Get repository info to find the actual default branch
        try {
          const { data: repoInfo } = await this.octokit.rest.repos.get({
            owner,
            repo,
          });
          const defaultBranch = repoInfo.default_branch;
          branchesToTry.push(defaultBranch);
          logger.info(`Repository default branch: ${defaultBranch}`);
        } catch (repoError) {
          logger.warn(
            "Could not get repository info, using common branch names:",
            repoError.message
          );
          branchesToTry = ["main", "master", "develop"];
        }
      }

      // Add common fallback branches if not already included
      const fallbackBranches = ["main", "master", "develop"];
      for (const branch of fallbackBranches) {
        if (!branchesToTry.includes(branch)) {
          branchesToTry.push(branch);
        }
      }

      logger.info(
        `Attempting to get file content for ${path} from branches: ${branchesToTry.join(
          ", "
        )}`
      );

      // Step 2: Try each branch until we find the file
      for (const branch of branchesToTry) {
        try {
          logger.info(
            `Attempting to get file content for ${path} from branch: ${branch}`
          );

          const { data } = await this.octokit.rest.repos.getContent({
            owner,
            repo,
            path,
            ref: branch,
          });

          if (data.type === "file") {
            logger.info(`Successfully found file ${path} on branch: ${branch}`);
            return {
              content: Buffer.from(data.content, "base64").toString("utf8"),
              sha: data.sha,
              size: data.size,
              branch: branch,
            };
          }
        } catch (error) {
          // Log different error types with appropriate levels
          if (error.status === 404) {
            logger.warn(
              `File ${path} not found on branch ${branch}: ${error.message}`
            );
          } else {
            logger.error(
              `Error accessing file ${path} on branch ${branch}: ${error.message}`
            );
          }
          // Continue to next branch
          continue;
        }
      }

      // Step 3: If file not found in any branch, try to find it in the PR's changed files
      logger.info(
        `File ${path} not found on any branch, checking if it's a new file in PR changes`
      );

      // This will be used by the calling function to determine if it's a new file
      logger.error(
        `File ${path} not found on any branch: ${branchesToTry.join(", ")}`
      );
      return null;
    } catch (error) {
      logger.error(`Error in getFileContent for ${path}:`, error);
      throw new Error(`Failed to get file content: ${error.message}`);
    }
  }

  // NEW: Update file content in repository
  // async updateFileContent(owner, repo, path, branch, content, message, sha) {
  //   try {
  //     const { data } = await this.octokit.rest.repos.createOrUpdateFileContents({
  //       owner,
  //       repo,
  //       path,
  //       message,
  //       content: Buffer.from(content).toString('base64'),
  //       branch,
  //       sha
  //     });

  //     logger.info(`File updated: ${path} on branch ${branch}`);
  //     return data;
  //   } catch (error) {
  //     logger.error(`Error updating file content for ${path}:`, error);
  //     throw new Error(`Failed to update file: ${error.message}`);
  //   }
  // }
  async updateFileContent(
    owner,
    repo,
    path,
    branch,
    content,
    message,
    sha = null
  ) {
    try {
      logger.info(`Updating file ${path} on branch ${branch}`, {
        hasContent: !!content,
        contentLength: content.length,
        hasSha: !!sha,
        branch,
      });

      const updateParams = {
        owner,
        repo,
        path,
        message,
        content: Buffer.from(content).toString("base64"),
        branch,
      };

      // Only include sha if provided (for existing files)
      if (sha) {
        updateParams.sha = sha;
      }

      const { data } = await this.octokit.rest.repos.createOrUpdateFileContents(
        updateParams
      );

      logger.info(`File ${sha ? "updated" : "created"} successfully: ${path}`, {
        commitSha: data.commit.sha,
        commitUrl: data.commit.html_url,
        branch,
      });

      return data;
    } catch (error) {
      logger.error(
        `Error ${
          sha ? "updating" : "creating"
        } file ${path} on branch ${branch}:`,
        {
          error: error.message,
          status: error.status,
          response: error.response?.data,
        }
      );

      // Provide more specific error messages
      if (error.status === 404) {
        throw new Error(
          `Repository or branch not found: ${owner}/${repo}:${branch}`
        );
      } else if (error.status === 409) {
        throw new Error(
          `File ${path} has been modified. Please refresh and try again.`
        );
      } else if (error.status === 422) {
        throw new Error(
          `Invalid file content or path: ${path}. Details: ${JSON.stringify(
            error.response?.data
          )}`
        );
      }

      throw new Error(
        `Failed to ${sha ? "update" : "create"} file: ${error.message}`
      );
    }
  }
  // Post review comment (for compatibility)
  async postReviewComment(owner, repo, pullNumber, comments) {
    try {
      logger.info(`Posting review comments for ${owner}/${repo}#${pullNumber}`);

      const reviewBody =
        typeof comments === "string"
          ? comments
          : this.formatReviewBody(comments);

      const { data: review } = await this.octokit.rest.pulls.createReview({
        owner,
        repo,
        pull_number: pullNumber,
        event: "COMMENT",
        body: reviewBody,
        comments: comments.inlineComments || [],
      });

      logger.info(`Review posted successfully: ${review.id}`);
      return review;
    } catch (error) {
      logger.error("Error posting review comment:", error);
      throw new Error(`Failed to post review comment: ${error.message}`);
    }
  }

  // Format review body (legacy compatibility)
  formatReviewBody(analysis) {
    if (typeof analysis === "string") {
      return analysis;
    }

    // If it's the new structured format, use the enhanced formatter
    if (analysis.prInfo) {
      return this.formatEnhancedStructuredComment(
        analysis,
        analysis.trackingId || "unknown"
      );
    }

    // Legacy format handling
    const { summary, issues, recommendations } = analysis;

    let body = `## 🤖 AI Code Review Summary\n\n`;
    body += `**Overall Rating:** ${summary?.overallRating || "UNKNOWN"}\n`;
    body += `**Total Issues:** ${summary?.totalIssues || 0}\n\n`;

    if (recommendations && recommendations.length > 0) {
      body += `### 💡 Recommendations\n`;
      recommendations.forEach((rec) => {
        body += `- ${rec}\n`;
      });
    }

    return body;
  }

  // Create check run for AI Review button
  // async createCheckRun(owner, repo, checkRunData) {
  //   try {
  //     logger.info(`Creating check run: ${checkRunData.name} for ${owner}/${repo}`);

  //     // Validate GitHub API limits before sending
  //     this.validateCheckRunData(checkRunData);

  //     const { data: checkRun } = await this.octokit.rest.checks.create({
  //       owner,
  //       repo,
  //       ...checkRunData,
  //     });

  //     logger.info(`Check run created: ${checkRun.id}`);
  //     return checkRun;
  //   } catch (error) {
  //     logger.error('Error creating check run:', error);
  //     logger.error('Check run data that failed:', {
  //       name: checkRunData.name,
  //       status: checkRunData.status,
  //       conclusion: checkRunData.conclusion,
  //       summaryLength: checkRunData.output?.summary?.length,
  //       textLength: checkRunData.output?.text?.length,
  //       actionsCount: checkRunData.actions?.length,
  //       actions: checkRunData.actions?.map(a => ({ label: a.label, identifier: a.identifier }))
  //     });
  //     throw new Error(`Failed to create check run: ${error.message}`);
  //   }
  // }

  // async createCheckRun(owner, repo, checkRunData) {
  //   try {
  //     logger.info(`Creating check run: ${checkRunData.name} for ${owner}/${repo}`);

  //     // Clean the output to remove empty DETAILS sections
  //     if (checkRunData.output) {
  //       checkRunData.output = this.cleanCheckRunOutput(checkRunData.output);
  //     }

  //     // Validate GitHub API limits before sending
  //     this.validateCheckRunData(checkRunData);

  //     const { data: checkRun } = await this.octokit.rest.checks.create({
  //       owner,
  //       repo,
  //       ...checkRunData,
  //     });

  //     logger.info(`Check run created: ${checkRun.id}`);
  //     return checkRun;
  //   } catch (error) {
  //     logger.error('Error creating check run:', error);
  //     logger.error('Check run data that failed:', {
  //       name: checkRunData.name,
  //       status: checkRunData.status,
  //       conclusion: checkRunData.conclusion,
  //       summaryLength: checkRunData.output?.summary?.length,
  //       textLength: checkRunData.output?.text?.length || 0,
  //       actionsCount: checkRunData.actions?.length,
  //       actions: checkRunData.actions?.map(a => ({ label: a.label, identifier: a.identifier }))
  //     });
  //     throw new Error(`Failed to create check run: ${error.message}`);
  //   }
  // }

  async createCheckRun(owner, repo, checkRunData) {
    try {
      logger.info(
        `Creating check run: ${checkRunData.name} for ${owner}/${repo}`
      );

      // Clean the output to remove empty DETAILS sections
      if (checkRunData.output) {
        checkRunData.output = this.cleanCheckRunOutput(checkRunData.output);
      }

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
      logger.error("Error creating check run:", error);
      logger.error("Check run data that failed:", {
        name: checkRunData.name,
        status: checkRunData.status,
        conclusion: checkRunData.conclusion,
        summaryLength: checkRunData.output?.summary?.length,
        textLength: checkRunData.output?.text?.length || 0,
        actionsCount: checkRunData.actions?.length,
        actions: checkRunData.actions?.map((a) => ({
          label: a.label,
          identifier: a.identifier,
        })),
      });
      throw new Error(`Failed to create check run: ${error.message}`);
    }
  }

  // Validate check run data against GitHub limits
  // validateCheckRunData(checkRunData) {
  //   const { name, output, actions } = checkRunData;

  //   // Check name length (20 characters max)
  //   if (name && name.length > 20) {
  //     throw new Error(`Check run name too long: ${name.length} chars (max 20)`);
  //   }

  //   // Check output limits
  //   if (output) {
  //     if (output.title && output.title.length > 255) {
  //       throw new Error(`Output title too long: ${output.title.length} chars (max 255)`);
  //     }
  //     if (output.summary && output.summary.length > 65535) {
  //       throw new Error(`Output summary too long: ${output.summary.length} chars (max 65535)`);
  //     }
  //     if (output.text && output.text.length > 65535) {
  //       throw new Error(`Output text too long: ${output.text.length} chars (max 65535)`);
  //     }
  //   }

  //   // Check actions limits
  //   if (actions) {
  //     if (actions.length > 3) {
  //       throw new Error(`Too many actions: ${actions.length} (max 3)`);
  //     }
  //     actions.forEach((action, index) => {
  //       if (action.label && action.label.length > 20) {
  //         throw new Error(`Action ${index} label too long: ${action.label.length} chars (max 20)`);
  //       }
  //       if (action.description && action.description.length > 40) {
  //         throw new Error(`Action ${index} description too long: ${action.description.length} chars (max 40)`);
  //       }
  //       if (action.identifier && action.identifier.length > 20) {
  //         throw new Error(`Action ${index} identifier too long: ${action.identifier.length} chars (max 20)`);
  //       }
  //     });
  //   }

  //   logger.info('Check run data validation passed', {
  //     nameLength: name?.length,
  //     titleLength: output?.title?.length,
  //     summaryLength: output?.summary?.length,
  //     textLength: output?.text?.length,
  //     actionsCount: actions?.length
  //   });
  // }

  // validateCheckRunData(checkRunData) {
  //   const { name, output, actions } = checkRunData;

  //   // Check name length (20 characters max)
  //   if (name && name.length > 20) {
  //     throw new Error(`Check run name too long: ${name.length} chars (max 20)`);
  //   }

  //   // Check output limits
  //   if (output) {
  //     if (output.title && output.title.length > 255) {
  //       throw new Error(`Output title too long: ${output.title.length} chars (max 255)`);
  //     }
  //     if (output.summary && output.summary.length > 65535) {
  //       throw new Error(`Output summary too long: ${output.summary.length} chars (max 65535)`);
  //     }
  //     // MODIFIED: Only validate text if it exists (since we're removing empty text fields)
  //     if (output.text && output.text.length > 65535) {
  //       throw new Error(`Output text too long: ${output.text.length} chars (max 65535)`);
  //     }
  //   }

  //   // Check actions limits
  //   if (actions) {
  //     if (actions.length > 3) {
  //       throw new Error(`Too many actions: ${actions.length} (max 3)`);
  //     }
  //     actions.forEach((action, index) => {
  //       if (action.label && action.label.length > 20) {
  //         throw new Error(`Action ${index} label too long: ${action.label.length} chars (max 20)`);
  //       }
  //       if (action.description && action.description.length > 40) {
  //         throw new Error(`Action ${index} description too long: ${action.description.length} chars (max 40)`);
  //       }
  //       if (action.identifier && action.identifier.length > 20) {
  //         throw new Error(`Action ${index} identifier too long: ${action.identifier.length} chars (max 20)`);
  //       }
  //     });
  //   }

  //   logger.info('Check run data validation passed', {
  //     nameLength: name?.length,
  //     titleLength: output?.title?.length,
  //     summaryLength: output?.summary?.length,
  //     textLength: output?.text?.length || 0, // Show 0 if no text field
  //     actionsCount: actions?.length
  //   });
  // }

  validateCheckRunData(checkRunData) {
    const { name, output, actions } = checkRunData;

    // Check name length (20 characters max)
    if (name && name.length > 20) {
      throw new Error(`Check run name too long: ${name.length} chars (max 20)`);
    }

    // Check output limits
    if (output) {
      if (output.title && output.title.length > 255) {
        throw new Error(
          `Output title too long: ${output.title.length} chars (max 255)`
        );
      }
      if (output.summary && output.summary.length > 65535) {
        throw new Error(
          `Output summary too long: ${output.summary.length} chars (max 65535)`
        );
      }
      // MODIFIED: Only validate text if it exists (since we're removing empty text fields)
      if (output.text && output.text.length > 65535) {
        throw new Error(
          `Output text too long: ${output.text.length} chars (max 65535)`
        );
      }
    }

    // Check actions limits
    if (actions) {
      if (actions.length > 3) {
        throw new Error(`Too many actions: ${actions.length} (max 3)`);
      }
      actions.forEach((action, index) => {
        if (action.label && action.label.length > 20) {
          throw new Error(
            `Action ${index} label too long: ${action.label.length} chars (max 20)`
          );
        }
        if (action.description && action.description.length > 40) {
          throw new Error(
            `Action ${index} description too long: ${action.description.length} chars (max 40)`
          );
        }
        if (action.identifier && action.identifier.length > 20) {
          throw new Error(
            `Action ${index} identifier too long: ${action.identifier.length} chars (max 20)`
          );
        }
      });
    }

    logger.info("Check run data validation passed", {
      nameLength: name?.length,
      titleLength: output?.title?.length,
      summaryLength: output?.summary?.length,
      textLength: output?.text?.length || 0, // Show 0 if no text field
      actionsCount: actions?.length,
    });
  }

  // Update existing check run
  // async updateCheckRun(owner, repo, checkRunId, updateData) {
  //   try {
  //     const { data: checkRun } = await this.octokit.rest.checks.update({
  //       owner,
  //       repo,
  //       check_run_id: checkRunId,
  //       ...updateData,
  //     });

  //     logger.info(`Check run updated: ${checkRunId} - Status: ${updateData.status || 'updated'}`);
  //     return checkRun;
  //   } catch (error) {
  //     logger.error(`Error updating check run ${checkRunId}:`, error);
  //     throw new Error(`Failed to update check run: ${error.message}`);
  //   }
  // }
  // async updateCheckRun(owner, repo, checkRunId, updateData) {
  //   try {
  //     // Clean the output to remove empty DETAILS sections
  //     if (updateData.output) {
  //       updateData.output = this.cleanCheckRunOutput(updateData.output);
  //     }

  //     const { data: checkRun } = await this.octokit.rest.checks.update({
  //       owner,
  //       repo,
  //       check_run_id: checkRunId,
  //       ...updateData,
  //     });

  //     logger.info(`Check run updated: ${checkRunId} - Status: ${updateData.status || 'updated'}`);
  //     return checkRun;
  //   } catch (error) {
  //     logger.error(`Error updating check run ${checkRunId}:`, error);
  //     throw new Error(`Failed to update check run: ${error.message}`);
  //   }
  // }
  async updateCheckRun(owner, repo, checkRunId, updateData) {
    try {
      // Clean the output to remove empty DETAILS sections
      if (updateData.output) {
        updateData.output = this.cleanCheckRunOutput(updateData.output);
      }

      const { data: checkRun } = await this.octokit.rest.checks.update({
        owner,
        repo,
        check_run_id: checkRunId,
        ...updateData,
      });

      logger.info(
        `Check run updated: ${checkRunId} - Status: ${
          updateData.status || "updated"
        }`
      );
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
      logger.error("Error updating comment:", error);
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
      logger.info(
        `Debugging line mapping for ${filePath} in PR #${pullNumber}`
      );

      const { data: files } = await this.octokit.rest.pulls.listFiles({
        owner,
        repo,
        pull_number: pullNumber,
      });

      const targetFile = files.find((file) => file.filename === filePath);
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
        commentableLines: Array.from(mapping.commentableLines).sort(
          (a, b) => a - b
        ),
        totalHunks: mapping.hunks.length,
        hunks: mapping.hunks.map((hunk) => ({
          oldStart: hunk.oldStart,
          newStart: hunk.newStart,
          lineCount: hunk.lines.length,
          addedLines: hunk.lines
            .filter((l) => l.type === "added")
            .map((l) => l.newLine),
          contextLines: hunk.lines
            .filter((l) => l.type === "context")
            .map((l) => l.newLine),
        })),
        patchPreview: targetFile.patch.split("\n").slice(0, 10).join("\n"),
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
      issues: [],
    };

    for (let i = 0; i < findings.length; i++) {
      const finding = findings[i];

      try {
        const isValid = await this.validateCommentableLine(
          owner,
          repo,
          pullNumber,
          finding.file,
          finding.line
        );

        if (isValid) {
          validationReport.validFindings++;
        } else {
          validationReport.invalidFindings++;

          // Try to find an alternative
          const adjustedLine = await this.findCommentableLine(
            owner,
            repo,
            pullNumber,
            finding.file,
            finding.line
          );

          if (adjustedLine) {
            validationReport.adjustableFindings++;
            validationReport.issues.push({
              index: i,
              file: finding.file,
              originalLine: finding.line,
              adjustedLine: adjustedLine,
              type: "adjustable",
              message: `Line ${finding.line} not commentable, can adjust to line ${adjustedLine}`,
            });
          } else {
            validationReport.unadjustableFindings++;
            validationReport.issues.push({
              index: i,
              file: finding.file,
              originalLine: finding.line,
              type: "unadjustable",
              message: `Line ${finding.line} not commentable and no nearby alternative found`,
            });
          }
        }
      } catch (error) {
        validationReport.unadjustableFindings++;
        validationReport.issues.push({
          index: i,
          file: finding.file,
          originalLine: finding.line,
          type: "error",
          message: `Validation error: ${error.message}`,
        });
      }
    }

    logger.info(`Line validation report for PR #${pullNumber}:`, {
      summary: {
        total: validationReport.totalFindings,
        valid: validationReport.validFindings,
        adjustable: validationReport.adjustableFindings,
        problematic: validationReport.unadjustableFindings,
      },
      issueCount: validationReport.issues.length,
    });

    return validationReport;
  }

  // Add to ai.service.js for better error context in analysis
  enhanceAnalysisWithLineValidation(analysis, owner, repo, pullNumber) {
    // Add a validation promise that can be awaited later
    analysis.lineValidation = this.validateFindings(
      analysis.detailedFindings,
      owner,
      repo,
      pullNumber
    );
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
          file: finding.file || "unknown",
          line: finding.line || 0,
          issue: "Missing or invalid file/line information",
          severity: "warning",
        });
        continue;
      }

      try {
        const githubService = require("./github.service");
        const isValid = await githubService.validateCommentableLine(
          owner,
          repo,
          pullNumber,
          finding.file,
          finding.line
        );

        if (isValid) {
          validCount++;
        } else {
          const adjustedLine = await githubService.findCommentableLine(
            owner,
            repo,
            pullNumber,
            finding.file,
            finding.line
          );

          if (adjustedLine) {
            issues.push({
              file: finding.file,
              line: finding.line,
              adjustedLine: adjustedLine,
              issue: "Line not in diff, can be adjusted",
              severity: "info",
            });
          } else {
            issues.push({
              file: finding.file,
              line: finding.line,
              issue: "Line not in PR changes and no nearby alternative",
              severity: "warning",
            });
          }
        }
      } catch (error) {
        issues.push({
          file: finding.file,
          line: finding.line,
          issue: `Validation error: ${error.message}`,
          severity: "error",
        });
      }
    }

    return {
      valid: issues.filter((i) => i.severity === "error").length === 0,
      validCount,
      totalCount: findings.length,
      issues,
    };
  }

  // cleanCheckRunOutput(output) {
  //   if (!output) return output;

  //   const cleanedOutput = {
  //     title: output.title,
  //     summary: output.summary
  //   };

  //   // Only include text if it has meaningful content (not empty or whitespace only)
  //   if (output.text && output.text.trim() && output.text.trim().length > 0) {
  //     cleanedOutput.text = output.text;
  //   }
  //   // REMOVED: Empty text field to prevent DETAILS section

  //   return cleanedOutput;
  // }

  // ENHANCED: Get file content with PR context for better handling of new files
  async getFileContentWithPRContext(owner, repo, path, ref, pullNumber = null) {
    try {
      // First, try the normal getFileContent method
      const fileContent = await this.getFileContent(owner, repo, path, ref);

      if (fileContent) {
        return fileContent;
      }

      // If file not found and we have a PR number, check if it's a new file in the PR
      if (pullNumber) {
        const prFileInfo = await this.isFileInPRChanges(
          owner,
          repo,
          pullNumber,
          path
        );

        if (prFileInfo.exists && prFileInfo.status === "added") {
          logger.info(`File ${path} is a new file added in PR #${pullNumber}`);

          // For new files, we can't get the "before" content, but we can indicate it's new
          return {
            content: "", // Empty content for new files
            sha: null, // No SHA for new files
            size: 0,
            branch: ref || "main",
            isNewFile: true,
            prStatus: prFileInfo.status,
          };
        }
      }

      return null;
    } catch (error) {
      logger.error(`Error in getFileContentWithPRContext for ${path}:`, error);
      throw error;
    }
  }
  // NEW: Helper method to check if a file exists in PR changes (for new files)
  async isFileInPRChanges(owner, repo, pullNumber, filePath) {
    try {
      const { data: files } = await this.octokit.rest.pulls.listFiles({
        owner,
        repo,
        pull_number: pullNumber,
      });

      const fileInPR = files.find((file) => file.filename === filePath);

      if (fileInPR) {
        logger.info(
          `File ${filePath} found in PR changes with status: ${fileInPR.status}`
        );
        return {
          exists: true,
          status: fileInPR.status, // 'added', 'modified', 'removed'
          additions: fileInPR.additions,
          deletions: fileInPR.deletions,
        };
      }

      return { exists: false };
    } catch (error) {
      logger.error(
        `Error checking if file ${filePath} is in PR changes:`,
        error
      );
      return { exists: false, error: error.message };
    }
  }

  cleanCheckRunOutput(output) {
    if (!output) return output;

    const cleanedOutput = {
      title: output.title,
      summary: output.summary,
    };

    // Only include text if it has meaningful content (not empty or whitespace only)
    if (output.text && output.text.trim() && output.text.trim().length > 0) {
      // Additional check: don't include text if it's just formatting or empty sections
      const meaningfulContent = output.text
        .trim()
        .replace(/#{1,6}\s*\w+\s*/g, "") // Remove headers
        .replace(/\*{1,2}\w+\*{1,2}/g, "") // Remove bold text markers
        .replace(/[-*]\s*/g, "") // Remove list markers
        .replace(/\s+/g, " ") // Normalize whitespace
        .trim();

      if (meaningfulContent && meaningfulContent.length > 10) {
        cleanedOutput.text = output.text;
      }
    }
    // COMPLETELY REMOVED: Empty text field to prevent DETAILS section

    return cleanedOutput;
  }

  // ENHANCED: Get file content from PR source branch with fallback to target branch
  async getFileContentFromPR(owner, repo, pullNumber, filePath) {
    try {
      logger.info(
        `Getting file content for ${filePath} from PR #${pullNumber}`
      );

      // First, get PR information to know the branches
      const { data: pr } = await this.octokit.rest.pulls.get({
        owner,
        repo,
        pull_number: pullNumber,
      });

      const sourceBranch = pr.head.ref; // Branch with changes (where we want to commit fixes)
      const targetBranch = pr.base.ref; // Target branch (usually main/master)

      logger.info(
        `PR branches - source: ${sourceBranch}, target: ${targetBranch}`
      );

      // Try to get file from source branch first (the PR branch)
      let fileContent = await this.getFileContent(
        owner,
        repo,
        filePath,
        sourceBranch
      );

      if (fileContent) {
        logger.info(`Found ${filePath} in PR source branch: ${sourceBranch}`);
        return {
          ...fileContent,
          sourceBranch,
          targetBranch,
          pullNumber,
        };
      }

      // If not in source branch, try target branch (for newly added files)
      logger.info(
        `File ${filePath} not found in source branch, trying target branch: ${targetBranch}`
      );
      fileContent = await this.getFileContent(
        owner,
        repo,
        filePath,
        targetBranch
      );

      if (fileContent) {
        logger.info(`Found ${filePath} in PR target branch: ${targetBranch}`);
        return {
          ...fileContent,
          sourceBranch,
          targetBranch,
          pullNumber,
          foundInTarget: true, // Flag to indicate file was found in target, not source
        };
      }

      // Check if it's a new file in the PR
      const prFileInfo = await this.isFileInPRChanges(
        owner,
        repo,
        pullNumber,
        filePath
      );

      if (prFileInfo.exists && prFileInfo.status === "added") {
        logger.info(`${filePath} is a new file added in PR #${pullNumber}`);

        // For new files, get the content from the PR diff if possible
        const newFileContent = await this.getNewFileContentFromPR(
          owner,
          repo,
          pullNumber,
          filePath
        );

        return {
          content: newFileContent || "",
          sha: null, // No SHA for new files
          size: newFileContent?.length || 0,
          branch: sourceBranch,
          sourceBranch,
          targetBranch,
          pullNumber,
          isNewFile: true,
          prStatus: prFileInfo.status,
        };
      }

      logger.error(
        `File ${filePath} not found in either PR source (${sourceBranch}) or target (${targetBranch}) branch`
      );
      return null;
    } catch (error) {
      logger.error(
        `Error getting file content from PR #${pullNumber} for ${filePath}:`,
        error
      );
      throw error;
    }
  }

  // NEW: Get content of a new file from PR changes
  async getNewFileContentFromPR(owner, repo, pullNumber, filePath) {
    try {
      const { data: files } = await this.octokit.rest.pulls.listFiles({
        owner,
        repo,
        pull_number: pullNumber,
      });

      const targetFile = files.find((file) => file.filename === filePath);

      if (targetFile && targetFile.status === "added" && targetFile.patch) {
        // Extract content from patch (this is a simplified approach)
        const patchLines = targetFile.patch.split("\n");
        const contentLines = patchLines
          .filter((line) => line.startsWith("+") && !line.startsWith("+++"))
          .map((line) => line.substring(1)); // Remove the '+' prefix

        return contentLines.join("\n");
      }

      return null;
    } catch (error) {
      logger.error(`Error extracting new file content for ${filePath}:`, error);
      return null;
    }
  }

  // NEW: Helper method to check if a file exists in PR changes (for new files)
  async isFileInPRChanges(owner, repo, pullNumber, filePath) {
    try {
      const { data: files } = await this.octokit.rest.pulls.listFiles({
        owner,
        repo,
        pull_number: pullNumber,
      });

      const fileInPR = files.find((file) => file.filename === filePath);

      if (fileInPR) {
        logger.info(
          `File ${filePath} found in PR changes with status: ${fileInPR.status}`
        );
        return {
          exists: true,
          status: fileInPR.status, // 'added', 'modified', 'removed'
          additions: fileInPR.additions,
          deletions: fileInPR.deletions,
        };
      }

      return { exists: false };
    } catch (error) {
      logger.error(
        `Error checking if file ${filePath} is in PR changes:`,
        error
      );
      return { exists: false, error: error.message };
    }
  }

  // ENHANCED: Commit fixes to PR source branch with detailed logging
  // async commitFixesToPRBranch(owner, repo, pullNumber, fixes, commitMessage = 'Apply AI-suggested code fixes') {
  //   try {
  //     logger.info(`Starting commitFixesToPRBranch for PR #${pullNumber}`, {
  //       fixesCount: fixes.length,
  //       fixes: fixes.map(f => ({ file: f.file, line: f.line, issue: f.issue }))
  //     });

  //     const results = {
  //       successful: [],
  //       failed: [],
  //       skipped: []
  //     };

  //     for (let i = 0; i < fixes.length; i++) {
  //       const fix = fixes[i];
  //       logger.info(`Processing fix ${i + 1}/${fixes.length} for ${fix.file}:${fix.line}`);

  //       try {
  //         // Step 1: Get current file content from PR context
  //         logger.info(`Step 1: Getting file content for ${fix.file} from PR #${pullNumber}`);
  //         const fileInfo = await this.getFileContentFromPR(owner, repo, pullNumber, fix.file);

  //         if (!fileInfo) {
  //           logger.warn(`Step 1 FAILED: File ${fix.file} not found in repository`);
  //           results.skipped.push({
  //             file: fix.file,
  //             reason: 'File not found in repository',
  //             fix: fix
  //           });
  //           continue;
  //         }

  //         logger.info(`Step 1 SUCCESS: File ${fix.file} found`, {
  //           branch: fileInfo.sourceBranch,
  //           hasContent: !!fileInfo.content,
  //           contentLength: fileInfo.content?.length,
  //           hasSha: !!fileInfo.sha
  //         });

  //         // Step 2: Generate AI fix suggestion first
  //         logger.info(`Step 2: Generating AI fix suggestion for ${fix.file}:${fix.line}`);
  //         let fixSuggestion = null;

  //         try {
  //           // Get detailed fix suggestion from AI service
  //           fixSuggestion = await aiService.generateCodeFixSuggestion(fix, fileInfo.content, {
  //             files: [{ filename: fix.file, patch: null }],
  //             pr: { number: pullNumber }
  //           });

  //           if (fixSuggestion && !fixSuggestion.error) {
  //             logger.info(`Step 2 SUCCESS: AI fix generated`, {
  //               hasCurrentCode: !!fixSuggestion.current_code,
  //               hasSuggestedFix: !!fixSuggestion.suggested_fix,
  //               explanation: fixSuggestion.explanation?.substring(0, 100) + '...'
  //             });
  //           } else {
  //             throw new Error(fixSuggestion?.error_message || 'AI fix generation failed');
  //           }
  //         } catch (aiError) {
  //           logger.warn(`Step 2 PARTIAL: AI fix failed, using basic fix: ${aiError.message}`);
  //           // Fallback to basic fix
  //           fixSuggestion = {
  //             current_code: null,
  //             suggested_fix: fix.suggestion,
  //             explanation: fix.issue
  //           };
  //         }

  //         // Step 3: Apply the fix to the current content
  //         logger.info(`Step 3: Applying fix to content for ${fix.file}`);
  //         const updatedContent = this.applyAdvancedFixToContent(fileInfo.content, fix, fixSuggestion);

  //         if (!updatedContent || updatedContent === fileInfo.content) {
  //           logger.warn(`Step 3 FAILED: No changes could be applied to ${fix.file}`);
  //           results.skipped.push({
  //             file: fix.file,
  //             reason: 'No changes could be applied - content unchanged',
  //             fix: fix,
  //             details: {
  //               originalLength: fileInfo.content.length,
  //               updatedLength: updatedContent?.length || 0,
  //               hasFixSuggestion: !!fixSuggestion?.suggested_fix
  //             }
  //           });
  //           continue;
  //         }

  //         logger.info(`Step 3 SUCCESS: Content updated for ${fix.file}`, {
  //           originalLength: fileInfo.content.length,
  //           updatedLength: updatedContent.length,
  //           changesMade: updatedContent !== fileInfo.content
  //         });

  //         // Step 4: Commit the updated content to the PR source branch
  //         logger.info(`Step 4: Committing changes to ${fileInfo.sourceBranch} for ${fix.file}`);

  //         const detailedCommitMessage = [
  //           commitMessage,
  //           '',
  //           `Fix for ${fix.file}:${fix.line}`,
  //           `Issue: ${fix.issue}`,
  //           `Suggestion: ${fix.suggestion}`,
  //           fixSuggestion?.explanation ? `AI Explanation: ${fixSuggestion.explanation}` : '',
  //           '',
  //           `Applied via AI Code Reviewer`
  //         ].filter(Boolean).join('\n');

  //         const commitResult = await this.updateFileContent(
  //           owner,
  //           repo,
  //           fix.file,
  //           fileInfo.sourceBranch,
  //           updatedContent,
  //           detailedCommitMessage,
  //           fileInfo.sha
  //         );

  //         logger.info(`Step 4 SUCCESS: Committed fix for ${fix.file}`, {
  //           commitSha: commitResult.commit.sha,
  //           commitUrl: commitResult.commit.html_url,
  //           branch: fileInfo.sourceBranch
  //         });

  //         results.successful.push({
  //           file: fix.file,
  //           branch: fileInfo.sourceBranch,
  //           commitSha: commitResult.commit.sha,
  //           commitUrl: commitResult.commit.html_url,
  //           fix: fix,
  //           appliedFix: fixSuggestion
  //         });

  //         // Small delay to avoid rate limiting
  //         await new Promise(resolve => setTimeout(resolve, 200));

  //       } catch (error) {
  //         logger.error(`Error processing fix ${i + 1} for ${fix.file}:`, error);
  //         results.failed.push({
  //           file: fix.file,
  //           error: error.message,
  //           stack: error.stack,
  //           fix: fix
  //         });
  //       }
  //     }

  //     logger.info(`commitFixesToPRBranch completed for PR #${pullNumber}`, {
  //       successful: results.successful.length,
  //       failed: results.failed.length,
  //       skipped: results.skipped.length,
  //       successfulFiles: results.successful.map(r => `${r.file} (${r.commitSha.substring(0, 7)})`),
  //       failedFiles: results.failed.map(r => `${r.file}: ${r.error}`),
  //       skippedFiles: results.skipped.map(r => `${r.file}: ${r.reason}`)
  //     });

  //     return results;

  //   } catch (error) {
  //     logger.error(`Critical error in commitFixesToPRBranch for PR #${pullNumber}:`, error);
  //     throw error;
  //   }
  // }
  async commitFixesToPRBranch(owner, repo, pullNumber, fixes, commitMessage = 'Apply AI-suggested code fixes') {
    try {
      logger.info(`Starting commitFixesToPRBranch for PR #${pullNumber}`, {
        fixesCount: fixes.length
      });
      
      const results = {
        successful: [],
        failed: [],
        skipped: []
      };
      
      // Process all fixes individually
      for (let i = 0; i < fixes.length; i++) {
        const fix = fixes[i];
        logger.info(`Processing fix ${i + 1}/${fixes.length} for ${fix.file}:${fix.line}`);
        
        try {
          // Step 1: Get current file content from PR context
          const fileInfo = await this.getFileContentFromPR(owner, repo, pullNumber, fix.file);
          
          if (!fileInfo) {
            logger.warn(`File ${fix.file} not found in repository`);
            results.skipped.push({
              file: fix.file,
              reason: 'File not found in repository',
              fix: fix
            });
            continue;
          }
          
          // Step 2: Use existing generateCodeFixSuggestion method
          logger.info(`Generating AI fix suggestion for ${fix.file}:${fix.line}`);
          
          const prData = {
            files: [{ filename: fix.file, patch: null }],
            pr: { number: pullNumber }
          };
          
          // Use the existing method that's already working in your system
          const fixSuggestion = await aiService.generateCodeFixSuggestion(fix, fileInfo.content, prData);
          
          if (!fixSuggestion || fixSuggestion.error) {
            throw new Error(fixSuggestion?.error_message || 'AI fix generation failed');
          }
          
          logger.info(`AI fix generated successfully`, {
            hasCurrentCode: !!fixSuggestion.current_code,
            hasSuggestedFix: !!fixSuggestion.suggested_fix,
            explanation: fixSuggestion.explanation?.substring(0, 100)
          });
          
          // Step 3: Apply the fix using enhanced replacement logic
          const updatedContent = this.applyAdvancedFixToContent(fileInfo.content, fix, fixSuggestion);
          
          if (!updatedContent || updatedContent === fileInfo.content) {
            logger.warn(`No changes could be applied to ${fix.file} - trying fallback approach`);
            
            // Fallback: Create a better fix based on the issue type
            const fallbackFix = this.createFallbackFix(fix, fileInfo.content);
            const fallbackUpdatedContent = this.applyAdvancedFixToContent(fileInfo.content, fix, fallbackFix);
            
            if (fallbackUpdatedContent && fallbackUpdatedContent !== fileInfo.content) {
              logger.info(`Fallback fix applied successfully for ${fix.file}`);
              const commitResult = await this.commitSingleFile(owner, repo, fix, fileInfo, fallbackUpdatedContent, commitMessage);
              results.successful.push(commitResult);
              
              // Mark fix as committed in history
              await fixHistoryService.markAsCommitted(owner, repo, fix.file, fix.line, fix.issue, commitResult.commitSha);
            } else {
              results.skipped.push({
                file: fix.file,
                reason: 'No changes could be applied - both AI and fallback fixes failed',
                fix: fix
              });
            }
            continue;
          }
          
          logger.info(`Content successfully updated for ${fix.file}`, {
            originalLength: fileInfo.content.length,
            updatedLength: updatedContent.length
          });
          
          // Step 4: Commit the fix using new PR-focused method
          const commitResult = await this.commitSingleFile(owner, repo, fix, fileInfo, updatedContent, commitMessage);
          results.successful.push(commitResult);
          
          // Mark fix as committed in history
          await fixHistoryService.markAsCommitted(owner, repo, fix.file, fix.line, fix.issue, commitResult.commitSha);
          
          // Small delay to avoid rate limiting
          await new Promise(resolve => setTimeout(resolve, 200));
          
        } catch (error) {
          logger.error(`Error processing fix for ${fix.file}:`, error);
          results.failed.push({
            file: fix.file,
            error: error.message,
            fix: fix
          });
        }
      }
      
      
      logger.info(`commitFixesToPRBranch completed`, {
        successful: results.successful.length,
        failed: results.failed.length,
        skipped: results.skipped.length
      });
      
      return results;
      
    } catch (error) {
      logger.error(`Critical error in commitFixesToPRBranch:`, error);
      throw error;
    }
  }
  
  // NEW: Helper method to commit multiple files in a single commit
  async commitMultipleFiles(owner, repo, fileChanges, commitMessage, pullNumber) {
    try {
      // Get the source branch from PR
      const pr = await this.octokit.rest.pulls.get({
        owner,
        repo,
        pull_number: pullNumber
      });
      
      const sourceBranch = pr.data.head.ref;
      
      // Prepare the commit message with details
      const detailedCommitMessage = [
        commitMessage,
        '',
        `Files changed: ${fileChanges.size}`,
        `Fixes applied: ${Array.from(fileChanges.values()).reduce((sum, file) => sum + file.fixes.length, 0)}`,
        '',
        'Applied via AI Code Reviewer'
      ].join('\n');
      
      // Create tree with all file changes
      const tree = [];
      for (const [file, fileData] of fileChanges.entries()) {
        tree.push({
          path: file,
          mode: '100644',
          type: 'blob',
          content: fileData.content
        });
      }
      
      // Create the commit
      const commit = await this.octokit.rest.git.createCommit({
        owner,
        repo,
        message: detailedCommitMessage,
        tree: tree,
        parents: [pr.data.head.sha]
      });
      
      // Update the branch reference
      await this.octokit.rest.git.updateRef({
        owner,
        repo,
        ref: `heads/${sourceBranch}`,
        sha: commit.data.sha
      });
      
      logger.info(`Successfully committed ${fileChanges.size} files in single commit`, {
        commitSha: commit.data.sha,
        filesChanged: fileChanges.size
      });
      
      return {
        commitSha: commit.data.sha,
        commitUrl: commit.data.html_url,
        filesChanged: fileChanges.size,
        totalFixes: Array.from(fileChanges.values()).reduce((sum, file) => sum + file.fixes.length, 0)
      };
      
    } catch (error) {
      logger.error('Error committing multiple files:', error);
      throw error;
    }
  }

  // NEW: Helper method to commit a single file
  async commitSingleFile(owner, repo, fix, fileInfo, updatedContent, commitMessage) {
    const detailedCommitMessage = [
      commitMessage,
      '',
      `Fix: ${fix.issue}`,
      `File: ${fix.file}:${fix.line}`,
      '',
      fix.suggestion,
      '',
      `Applied via AI Code Reviewer`
    ].join('\n');
    
    const commitResult = await this.updateFileContent(
      owner,
      repo,
      fix.file,
      fileInfo.sourceBranch,
      updatedContent,
      detailedCommitMessage,
      fileInfo.sha
    );
    
    logger.info(`Successfully committed fix for ${fix.file}`, {
      commitSha: commitResult.commit.sha,
      commitUrl: commitResult.commit.html_url
    });
    
    return {
      file: fix.file,
      branch: fileInfo.sourceBranch,
      commitSha: commitResult.commit.sha,
      commitUrl: commitResult.commit.html_url,
      fix: fix
    };
  }
  
  // NEW: Create fallback fixes for common issues when AI fails
  createFallbackFix(fix, fileContent) {
    logger.info(`Creating fallback fix for ${fix.file}:${fix.line} - Issue: ${fix.issue}`);
    
    const issue = fix.issue.toLowerCase();
    const lines = fileContent.split('\n');
    const lineIndex = fix.line - 1;
    const problematicLine = lines[lineIndex] || '';
    
    // SQL Injection fixes
    if (issue.includes('sql injection')) {
      if (problematicLine.includes('${') || problematicLine.includes('`')) {
        // Template literal injection
        const currentCode = problematicLine.trim();
        let suggestedFix = currentCode;
        
        // Convert template literal to parameterized query
        if (problematicLine.includes('SELECT') && problematicLine.includes('WHERE')) {
          suggestedFix = "const query = 'SELECT * FROM users WHERE username = ? AND password = ?';";
          // Add the executeQuery line if it doesn't exist
          if (!fileContent.includes('executeQuery(query, [')) {
            suggestedFix += '\n    executeQuery(query, [username, password]);';
          }
        }
        
        return {
          current_code: currentCode,
          suggested_fix: suggestedFix,
          explanation: 'Converted to parameterized query to prevent SQL injection'
        };
      }
    }
    
    // XSS fixes
    if (issue.includes('xss') || issue.includes('cross-site scripting')) {
      if (problematicLine.includes('innerHTML')) {
        const currentCode = problematicLine.trim();
        const suggestedFix = currentCode.replace('innerHTML', 'textContent');
        return {
          current_code: currentCode,
          suggested_fix: suggestedFix,
          explanation: 'Use textContent instead of innerHTML to prevent XSS'
        };
      }
    }
    
    // Path traversal fixes
    if (issue.includes('path traversal') || issue.includes('directory traversal')) {
      if (problematicLine.includes('fs.readFile') || problematicLine.includes('readFile')) {
        const currentCode = problematicLine.trim();
        const suggestedFix = currentCode.replace(
          /readFile\((.*?)\)/,
          'readFile(path.resolve(path.join(__dirname, $1)))'
        );
        return {
          current_code: currentCode,
          suggested_fix: suggestedFix,
          explanation: 'Use path.resolve to prevent path traversal'
        };
      }
    }
    
    // Generic fallback
    return {
      current_code: problematicLine.trim(),
      suggested_fix: `// FIXME: ${fix.issue}\n    // TODO: ${fix.suggestion}\n    ${problematicLine.trim()}`,
      explanation: `Manual fix required: ${fix.suggestion}`
    };
  }

  // ENHANCED: Advanced fix application with multiple strategies
  // applyAdvancedFixToContent(currentContent, fix, fixSuggestion) {
  //   try {
  //     logger.info(`Attempting to apply fix to ${fix.file}:${fix.line}`, {
  //       hasCurrentCode: !!fixSuggestion?.current_code,
  //       hasSuggestedFix: !!fixSuggestion?.suggested_fix,
  //       fixLine: fix.line,
  //       contentLines: currentContent.split('\n').length
  //     });

  //     // Strategy 1: Use AI-generated current_code and suggested_fix for exact replacement
  //     if (fixSuggestion?.current_code && fixSuggestion?.suggested_fix) {
  //       const currentCode = fixSuggestion.current_code.trim();
  //       const suggestedFix = fixSuggestion.suggested_fix.trim();

  //       logger.info(`Strategy 1: Trying exact code replacement`, {
  //         currentCodeLength: currentCode.length,
  //         suggestedFixLength: suggestedFix.length,
  //         currentCodePreview: currentCode.substring(0, 100)
  //       });

  //       // Try exact match first
  //       if (currentContent.includes(currentCode)) {
  //         const updatedContent = currentContent.replace(currentCode, suggestedFix);
  //         logger.info(`Strategy 1 SUCCESS: Exact replacement applied`);
  //         return updatedContent;
  //       }

  //       // Try with normalized whitespace
  //       const normalizedContent = currentContent.replace(/\s+/g, ' ');
  //       const normalizedCurrentCode = currentCode.replace(/\s+/g, ' ');
  //       const normalizedSuggestedFix = suggestedFix.replace(/\s+/g, ' ');

  //       if (normalizedContent.includes(normalizedCurrentCode)) {
  //         const updatedContent = currentContent.replace(
  //           new RegExp(normalizedCurrentCode.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'), 'g'),
  //           suggestedFix
  //         );
  //         logger.info(`Strategy 1 PARTIAL: Normalized replacement applied`);
  //         return updatedContent;
  //       }
  //     }

  //     // Strategy 2: Line-based replacement using fix.line
  //     if (fix.line && typeof fix.line === 'number' && fixSuggestion?.suggested_fix) {
  //       logger.info(`Strategy 2: Trying line-based replacement at line ${fix.line}`);

  //       const lines = currentContent.split('\n');
  //       const lineIndex = fix.line - 1; // Convert to 0-based index

  //       if (lineIndex >= 0 && lineIndex < lines.length) {
  //         const originalLine = lines[lineIndex];
  //         const suggestedFix = fixSuggestion.suggested_fix.trim();

  //         // Preserve indentation from original line
  //         const indentMatch = originalLine.match(/^(\s*)/);
  //         const indent = indentMatch ? indentMatch[1] : '';

  //         lines[lineIndex] = indent + suggestedFix;

  //         const updatedContent = lines.join('\n');
  //         logger.info(`Strategy 2 SUCCESS: Line replacement applied`, {
  //           originalLine: originalLine.trim(),
  //           newLine: (indent + suggestedFix).trim()
  //         });
  //         return updatedContent;
  //       }
  //     }

  //     // Strategy 3: Pattern-based replacement using the issue description
  //     if (fix.suggestion && fixSuggestion?.suggested_fix) {
  //       logger.info(`Strategy 3: Trying pattern-based replacement`);

  //       // Look for common patterns in the issue and try to replace them
  //       const lines = currentContent.split('\n');
  //       let foundLine = -1;

  //       // Search for lines that might match the issue context
  //       for (let i = 0; i < lines.length; i++) {
  //         const line = lines[i].toLowerCase();

  //         // Look for keywords from the issue in the line
  //         const issueKeywords = fix.issue.toLowerCase().split(' ').filter(word =>
  //           word.length > 3 && !['the', 'and', 'for', 'with', 'this', 'that', 'should', 'could', 'would'].includes(word)
  //         );

  //         const matchingKeywords = issueKeywords.filter(keyword => line.includes(keyword));

  //         if (matchingKeywords.length > 0) {
  //           foundLine = i;
  //           logger.info(`Strategy 3: Found potential line ${i + 1} with keywords: ${matchingKeywords.join(', ')}`);
  //           break;
  //         }
  //       }

  //       if (foundLine >= 0) {
  //         const originalLine = lines[foundLine];
  //         const indentMatch = originalLine.match(/^(\s*)/);
  //         const indent = indentMatch ? indentMatch[1] : '';

  //         lines[foundLine] = indent + fixSuggestion.suggested_fix.trim();

  //         const updatedContent = lines.join('\n');
  //         logger.info(`Strategy 3 SUCCESS: Pattern replacement applied at line ${foundLine + 1}`);
  //         return updatedContent;
  //       }
  //     }

  //     // Strategy 4: Append fix as comment (fallback)
  //     if (fixSuggestion?.suggested_fix || fix.suggestion) {
  //       logger.info(`Strategy 4: Fallback - adding fix as comment`);

  //       const fixToApply = fixSuggestion?.suggested_fix || fix.suggestion;
  //       const fixComment = [
  //         '',
  //         `// AI Fix Suggestion for line ${fix.line || 'unknown'}:`,
  //         `// Issue: ${fix.issue}`,
  //         `// Suggested fix:`,
  //         fixToApply.split('\n').map(line => `// ${line}`).join('\n'),
  //         ''
  //       ].join('\n');

  //       const updatedContent = currentContent + fixComment;
  //       logger.info(`Strategy 4 SUCCESS: Fix added as comment`);
  //       return updatedContent;
  //     }

  //     logger.warn(`All strategies failed: Could not apply fix for ${fix.file}:${fix.line}`);
  //     return currentContent;

  //   } catch (error) {
  //     logger.error(`Error applying fix to content for ${fix.file}:`, error);
  //     return currentContent;
  //   }
  // }
  applyAdvancedFixToContent(currentContent, fix, fixSuggestion) {
    try {
      logger.info(`Attempting to apply fix to ${fix.file}:${fix.line}`, {
        hasCurrentCode: !!fixSuggestion?.current_code,
        hasSuggestedFix: !!fixSuggestion?.suggested_fix,
        fixLine: fix.line,
        contentLines: currentContent.split("\n").length,
      });

      // Strategy 1: Use AI-generated current_code and suggested_fix for exact replacement
      if (fixSuggestion?.current_code && fixSuggestion?.suggested_fix) {
        const currentCode = fixSuggestion.current_code.trim();
        const suggestedFix = fixSuggestion.suggested_fix.trim();

        logger.info(`Strategy 1: Trying exact code replacement`, {
          currentCodePreview: currentCode.substring(0, 200),
          suggestedFixPreview: suggestedFix.substring(0, 200),
        });

        // Try exact match first
        if (currentContent.includes(currentCode)) {
          const updatedContent = currentContent.replace(
            currentCode,
            suggestedFix
          );
          logger.info(`Strategy 1 SUCCESS: Exact replacement applied`);
          return updatedContent;
        }

        // Try with normalized whitespace and line breaks
        const lines = currentContent.split("\n");
        const currentCodeLines = currentCode.split("\n").map((l) => l.trim());
        const suggestedFixLines = suggestedFix.split("\n");

        // Find the starting line that matches the first line of current code
        for (let i = 0; i < lines.length; i++) {
          if (lines[i].trim() === currentCodeLines[0]) {
            // Check if subsequent lines also match
            let allMatch = true;
            for (let j = 1; j < currentCodeLines.length; j++) {
              if (
                i + j >= lines.length ||
                lines[i + j].trim() !== currentCodeLines[j]
              ) {
                allMatch = false;
                break;
              }
            }

            if (allMatch) {
              // Replace the matching lines with suggested fix
              const beforeLines = lines.slice(0, i);
              const afterLines = lines.slice(i + currentCodeLines.length);

              // Preserve indentation from the first line
              const indent = lines[i].match(/^(\s*)/)[0];
              const indentedSuggestedLines = suggestedFixLines.map(
                (line, idx) =>
                  idx === 0
                    ? indent + line.trim()
                    : line.trim()
                    ? indent + line.trim()
                    : line
              );

              const updatedContent = [
                ...beforeLines,
                ...indentedSuggestedLines,
                ...afterLines,
              ].join("\n");

              logger.info(
                `Strategy 1 MULTI-LINE SUCCESS: Multi-line replacement applied`,
                {
                  startLine: i + 1,
                  replacedLines: currentCodeLines.length,
                  newLines: suggestedFixLines.length,
                }
              );
              return updatedContent;
            }
          }
        }
      }

      // Strategy 2: Line-based replacement using fix.line with AI suggested fix
      if (
        fix.line &&
        typeof fix.line === "number" &&
        fixSuggestion?.suggested_fix
      ) {
        logger.info(
          `Strategy 2: Trying line-based replacement at line ${fix.line}`
        );

        const lines = currentContent.split("\n");
        const lineIndex = fix.line - 1; // Convert to 0-based index

        if (lineIndex >= 0 && lineIndex < lines.length) {
          const originalLine = lines[lineIndex];
          const suggestedFixLines = fixSuggestion.suggested_fix.split("\n");

          // Preserve indentation from original line
          const indentMatch = originalLine.match(/^(\s*)/);
          const indent = indentMatch ? indentMatch[1] : "";

          // Replace single line or insert multiple lines
          if (suggestedFixLines.length === 1) {
            // Single line replacement
            lines[lineIndex] = indent + suggestedFixLines[0].trim();
          } else {
            // Multi-line replacement - remove original line and insert new lines
            const beforeLines = lines.slice(0, lineIndex);
            const afterLines = lines.slice(lineIndex + 1);

            const indentedNewLines = suggestedFixLines.map((line) =>
              line.trim() ? indent + line.trim() : line
            );

            lines.splice(lineIndex, 1, ...indentedNewLines);
          }

          const updatedContent = lines.join("\n");
          logger.info(`Strategy 2 SUCCESS: Line-based replacement applied`, {
            originalLine: originalLine.trim(),
            newLines: suggestedFixLines.length,
            replacementPreview: suggestedFixLines[0].trim(),
          });
          return updatedContent;
        }
      }

      // Strategy 3: Function-level replacement (for cases like your SQL injection fix)
      if (fixSuggestion?.current_code && fixSuggestion?.suggested_fix) {
        logger.info(`Strategy 3: Trying function-level replacement`);

        // Look for function patterns and replace entire function bodies
        const currentCode = fixSuggestion.current_code.trim();
        const suggestedFix = fixSuggestion.suggested_fix.trim();

        // Extract just the problematic line(s) from current_code
        const currentCodeLines = currentCode.split("\n");
        const lines = currentContent.split("\n");

        // Find lines that contain key parts of the problematic code
        for (let i = 0; i < lines.length; i++) {
          const line = lines[i];

          // Look for the problematic pattern (e.g., SQL injection pattern)
          const problematicPatterns = [
            /\$\{.*\}/, // Template literal injection
            /'\s*\+\s*.*\+\s*'/, // String concatenation
            /SELECT.*FROM.*WHERE.*=.*'.*\$/, // SQL injection patterns
          ];

          const hasProblematicPattern = problematicPatterns.some((pattern) =>
            pattern.test(line)
          );

          if (hasProblematicPattern) {
            logger.info(
              `Strategy 3: Found problematic pattern at line ${
                i + 1
              }: ${line.trim()}`
            );

            // Replace this line with the suggested fix
            const indent = line.match(/^(\s*)/)[0];
            const suggestedFixLines = suggestedFix.split("\n");
            const indentedSuggestedLines = suggestedFixLines.map((line) =>
              line.trim() ? indent + line.trim() : line
            );

            // Replace the problematic line(s)
            lines.splice(i, 1, ...indentedSuggestedLines);

            const updatedContent = lines.join("\n");
            logger.info(
              `Strategy 3 SUCCESS: Function-level replacement applied`
            );
            return updatedContent;
          }
        }
      }

      // Strategy 4: Smart pattern matching for common code issues
      if (fix.line && fixSuggestion?.suggested_fix) {
        logger.info(
          `Strategy 4: Trying smart pattern matching around line ${fix.line}`
        );

        const lines = currentContent.split("\n");
        const targetLineIndex = fix.line - 1;
        const searchRange = 3; // Search 3 lines above and below

        const startSearch = Math.max(0, targetLineIndex - searchRange);
        const endSearch = Math.min(
          lines.length - 1,
          targetLineIndex + searchRange
        );

        // Look for lines that need fixing based on the issue description
        for (let i = startSearch; i <= endSearch; i++) {
          const line = lines[i];

          // Check if this line contains the problematic pattern mentioned in the issue
          let shouldReplace = false;

          // SQL Injection patterns
          if (fix.issue.toLowerCase().includes("sql injection")) {
            shouldReplace =
              /SELECT.*FROM.*WHERE.*=.*['"`].*\$/.test(line) ||
              /\$\{.*\}/.test(line) ||
              line.includes("${username}") ||
              line.includes("${password}");
          }

          // XSS patterns
          if (
            fix.issue.toLowerCase().includes("xss") ||
            fix.issue.toLowerCase().includes("cross-site scripting")
          ) {
            shouldReplace =
              /innerHTML.*=/.test(line) || /document\.write/.test(line);
          }

          // Add more patterns as needed

          if (shouldReplace) {
            logger.info(
              `Strategy 4: Found line to replace at ${i + 1}: ${line.trim()}`
            );

            const indent = line.match(/^(\s*)/)[0];
            const suggestedFixLines = fixSuggestion.suggested_fix.split("\n");
            const indentedSuggestedLines = suggestedFixLines.map((fixLine) =>
              fixLine.trim() ? indent + fixLine.trim() : fixLine
            );

            lines.splice(i, 1, ...indentedSuggestedLines);

            const updatedContent = lines.join("\n");
            logger.info(
              `Strategy 4 SUCCESS: Smart pattern replacement applied`
            );
            return updatedContent;
          }
        }
      }

      // Strategy 5: Last resort - insert suggested fix near the problematic line
      if (fix.line && fixSuggestion?.suggested_fix) {
        logger.info(
          `Strategy 5: Last resort - inserting fix near line ${fix.line}`
        );

        const lines = currentContent.split("\n");
        const insertIndex = fix.line; // Insert after the problematic line

        if (insertIndex >= 0 && insertIndex <= lines.length) {
          const referenceIndent =
            insertIndex > 0
              ? lines[insertIndex - 1].match(/^(\s*)/)?.[0] || ""
              : "";

          const suggestedFixLines = fixSuggestion.suggested_fix.split("\n");
          const indentedSuggestedLines = suggestedFixLines.map((line) =>
            line.trim() ? referenceIndent + line.trim() : line
          );

          // Add a comment explaining the fix
          const fixComment = referenceIndent + `// AI Fix: ${fix.issue}`;

          lines.splice(insertIndex, 0, fixComment, ...indentedSuggestedLines);

          const updatedContent = lines.join("\n");
          logger.info(`Strategy 5 SUCCESS: Fix inserted near problematic line`);
          return updatedContent;
        }
      }

      logger.warn(
        `All strategies failed: Could not apply fix for ${fix.file}:${fix.line}`
      );
      return null; // Return null instead of original content to indicate failure
    } catch (error) {
      logger.error(`Error applying fix to content for ${fix.file}:`, error);
      return null;
    }
  }

  // NEW: Apply a fix suggestion to file content
  applyFixToContent(currentContent, fix) {
    try {
      // If fix includes both current_code and suggested_fix, do a targeted replacement
      if (fix.current_code && fix.suggested_fix) {
        const updatedContent = currentContent.replace(
          fix.current_code.trim(),
          fix.suggested_fix.trim()
        );

        if (updatedContent !== currentContent) {
          logger.info(`Applied targeted fix replacement in file ${fix.file}`);
          return updatedContent;
        }
      }

      // If we have line information, try to replace specific lines
      if (fix.line && typeof fix.line === "number") {
        const lines = currentContent.split("\n");

        if (fix.line > 0 && fix.line <= lines.length) {
          // If we have suggested_fix, replace the line
          if (fix.suggested_fix) {
            lines[fix.line - 1] = fix.suggested_fix.trim();
            logger.info(
              `Applied line-specific fix at line ${fix.line} in file ${fix.file}`
            );
            return lines.join("\n");
          }
        }
      }

      // Fallback: Add fix as a comment if we can't apply it directly
      if (fix.suggested_fix) {
        const fixComment = `\n// AI Fix Suggestion: ${fix.issue}\n// Suggestion: ${fix.suggestion}\n// ${fix.suggested_fix}\n`;
        logger.warn(
          `Could not apply fix directly, adding as comment in ${fix.file}`
        );
        return currentContent + fixComment;
      }

      logger.warn(`Could not determine how to apply fix for ${fix.file}`);
      return currentContent;
    } catch (error) {
      logger.error(`Error applying fix to content for ${fix.file}:`, error);
      return currentContent; // Return original content if fix fails
    }
  }
}

module.exports = new GitHubService();
