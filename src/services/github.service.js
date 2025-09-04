// src/services/github.service.js - Enhanced with Interactive Comment Support and Correct Line Finding

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
        } catch (error) {
          logger.error('Base64 key decode failed, falling back:', error);
          privateKeyContent = null;
        }
      }

      // Method 2: Direct private key content
      if (!privateKeyContent && process.env.GITHUB_PRIVATE_KEY) {
        logger.info('Attempting to use direct private key from environment');
        privateKeyContent = process.env.GITHUB_PRIVATE_KEY.replace(/\\n/g, '\n');
      }

      // Method 3: Private key from file path (local development)
      if (!privateKeyContent && process.env.GITHUB_PRIVATE_KEY_PATH) {
        const keyPath = process.env.GITHUB_PRIVATE_KEY_PATH;
        logger.info(`Attempting to read private key from file: ${keyPath}`);
        if (fs.existsSync(keyPath)) {
          privateKeyContent = fs.readFileSync(keyPath, 'utf8');
        }
      }

      // Method 4: Fallback to default location
      if (!privateKeyContent) {
        const defaultKeyPath = path.join(__dirname, '../../private-key.pem');
        logger.info(`Attempting to read private key from default location: ${defaultKeyPath}`);
        if (fs.existsSync(defaultKeyPath)) {
          privateKeyContent = fs.readFileSync(defaultKeyPath, 'utf8');
        }
      }

      if (!privateKeyContent) {
        throw new Error('No private key found. Please set GITHUB_PRIVATE_KEY_BASE64, GITHUB_PRIVATE_KEY, or GITHUB_PRIVATE_KEY_PATH.');
      }
      return privateKeyContent;
    } catch (error) {
      logger.error('Error retrieving private key:', error);
      throw new Error(`Failed to retrieve private key: ${error.message}`);
    }
  }

  // Helper to validate base64 format
  isValidBase64(str) {
    try {
      return Buffer.from(str, 'base64').toString('base64') === str;
    } catch (e) {
      return false;
    }
  }

  // Fetch repository content
  async getRepositoryContent(owner, repo, path, ref) {
    try {
      const { data } = await this.octokit.rest.repos.getContent({
        owner,
        repo,
        path,
        ref,
      });
      return data;
    } catch (error) {
      logger.error(`Error fetching repository content at ${path}:`, error);
      throw new Error(`Failed to fetch repository content: ${error.message}`);
    }
  }

  // Fetch pull request files
  async getPullRequestFiles(owner, repo, pullNumber) {
    try {
      const { data: files } = await this.octokit.rest.pulls.listFiles({
        owner,
        repo,
        pull_number: pullNumber,
      });
      return files;
    } catch (error) {
      logger.error(`Error fetching PR files for #${pullNumber}:`, error);
      throw new Error(`Failed to fetch pull request files: ${error.message}`);
    }
  }

  // Get a specific pull request
  async getPullRequest(owner, repo, pullNumber) {
    try {
      const { data: pullRequest } = await this.octokit.rest.pulls.get({
        owner,
        repo,
        pull_number: pullNumber,
      });
      return pullRequest;
    } catch (error) {
      logger.error(`Error fetching PR #${pullNumber}:`, error);
      throw new Error(`Failed to get pull request: ${error.message}`);
    }
  }

  // Find the diff hunk for a given file and line number
  async getDiffHunk(owner, repo, pullNumber, filePath, lineNumber) {
    try {
      const { data: files } = await this.octokit.rest.pulls.listFiles({
        owner,
        repo,
        pull_number: pullNumber,
      });

      const file = files.find(f => f.filename === filePath);
      if (!file) {
        logger.warn(`File ${filePath} not found in PR files.`);
        return null;
      }

      // Find the correct diff hunk
      const diff = file.patch;
      if (!diff) {
        logger.warn(`No diff patch found for file: ${filePath}`);
        return null;
      }

      const lines = diff.split('\n');
      let hunkHeader = null;
      let lineCounter = 0;
      let hunkStartLine = 0;

      for (const line of lines) {
        if (line.startsWith('@@')) {
          hunkHeader = line;
          const match = hunkHeader.match(/\+([0-9]+),?/);
          if (match) {
            hunkStartLine = parseInt(match[1], 10);
            lineCounter = hunkStartLine - 1;
          }
        } else if (line.startsWith('+')) {
          lineCounter++;
          if (lineCounter === lineNumber) {
            // Return the full diff hunk body
            const hunkLines = [hunkHeader];
            let startIndex = lines.indexOf(line);
            while (startIndex >= 0 && !lines[startIndex].startsWith('@@')) {
              startIndex--;
            }
            if (startIndex < 0) startIndex = 0;

            let endIndex = lines.indexOf(line);
            while (endIndex < lines.length && !lines[endIndex].startsWith('@@', endIndex === lines.indexOf(line) ? lines[endIndex].length : 0)) {
              endIndex++;
            }
            if (endIndex > lines.length) endIndex = lines.length;
            
            return lines.slice(startIndex, endIndex).join('\n');
          }
        } else if (line.startsWith('-') || line.startsWith(' ')) {
          lineCounter++;
        }
      }

      logger.warn(`Line ${lineNumber} not found in diff for file: ${filePath}`);
      return null;
    } catch (error) {
      logger.error(`Error finding diff hunk for ${filePath}:${lineNumber}:`, error);
      throw new Error(`Failed to find diff hunk: ${error.message}`);
    }
  }

  // Post a new comment on a pull request
  async createComment(owner, repo, pullNumber, body) {
    try {
      const { data: comment } = await this.octokit.rest.issues.createComment({
        owner,
        repo,
        issue_number: pullNumber,
        body,
      });

      logger.info(`Comment created on PR #${pullNumber}: ${comment.id}`);
      return comment;
    } catch (error) {
      logger.error(`Error creating comment on PR #${pullNumber}:`, error);
      throw new Error(`Failed to create comment: ${error.message}`);
    }
  }

  // NEW: Post a pull request review comment
  // This is used for creating threaded comments or suggestions
  async postPullRequestReviewComment(owner, repo, pullNumber, commitId, filePath, line, body) {
    try {
      const { data: comment } = await this.octokit.rest.pulls.createReviewComment({
        owner,
        repo,
        pull_number: pullNumber,
        commit_id: commitId,
        path: filePath,
        line: line,
        body: body
      });
      logger.info(`Review comment posted on file: ${filePath}, line: ${line}, comment ID: ${comment.id}`);
      return comment;
    } catch (error) {
      logger.error(`Error posting review comment on file: ${filePath}, line: ${line}:`, error);
      throw new Error(`Failed to post review comment: ${error.message}`);
    }
  }

  // Update a check run
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
      logger.error('Error deleting comment:', error);
      throw new Error(`Failed to delete comment: ${error.message}`);
    }
  }

  // List comments on a pull request
  async listComments(owner, repo, pullNumber) {
    try {
      const { data: comments } = await this.octokit.rest.issues.listComments({
        owner,
        repo,
        issue_number: pullNumber,
      });
      return comments;
    } catch (error) {
      logger.error('Error listing comments:', error);
      throw new Error(`Failed to list comments: ${error.message}`);
    }
  }

  // List all check runs for a specific commit SHA
  async listCheckRuns(owner, repo, headSha) {
    try {
      const { data: checkRuns } = await this.octokit.rest.checks.listForRef({
        owner,
        repo,
        ref: headSha,
      });
      return checkRuns.check_runs;
    } catch (error) {
      logger.error(`Error listing check runs for SHA: ${headSha}`, error);
      throw new Error(`Failed to list check runs: ${error.message}`);
    }
  }

  // Get the most recent commit for a pull request
  async getMostRecentCommit(owner, repo, pullNumber) {
    try {
      const { data: commits } = await this.octokit.rest.pulls.listCommits({
        owner,
        repo,
        pull_number: pullNumber,
        per_page: 1
      });

      if (commits && commits.length > 0) {
        return commits[0].sha;
      }
      return null;
    } catch (error) {
      logger.error(`Error getting most recent commit for PR #${pullNumber}`, error);
      throw new Error(`Failed to get most recent commit: ${error.message}`);
    }
  }

  // Get repository information
  async getRepoInfo(owner, repo) {
    try {
      const { data: repoInfo } = await this.octokit.rest.repos.get({
        owner,
        repo
      });
      return repoInfo;
    } catch (error) {
      logger.error(`Error getting repo info for ${owner}/${repo}:`, error);
      throw new Error(`Failed to get repo info: ${error.message}`);
    }
  }
}

module.exports = new GitHubService();
