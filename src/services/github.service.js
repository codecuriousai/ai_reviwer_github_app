const { Octokit } = require('@octokit/rest');
const fs = require('fs');
const config = require('../config/config');
const logger = require('../utils/logger');

class GitHubService {
  constructor() {
    this.octokit = new Octokit({
      auth: this.getInstallationToken(),
    });
  }

  // Get installation token for GitHub App authentication
  getInstallationToken() {
    try {
      const privateKey = fs.readFileSync(config.github.privateKeyPath, 'utf8');
      return privateKey;
    } catch (error) {
      logger.error('Error reading GitHub private key:', error);
      throw new Error('Failed to read GitHub private key');
    }
  }

  // Fetch pull request data
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
        },
        files: filteredFiles,
        diff,
        comments,
      };
    } catch (error) {
      logger.error('Error fetching PR data:', error);
      throw new Error(`Failed to fetch PR data: ${error.message}`);
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

  // Post review comment on PR
  async postReviewComment(owner, repo, pullNumber, comments) {
    try {
      logger.info(`Posting review comments for ${owner}/${repo}#${pullNumber}`);

      // Create a review with multiple comments
      const reviewBody = this.formatReviewBody(comments);
      
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

  // Post a general comment on the PR
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

  // Format review body with summary
  formatReviewBody(analysis) {
    const { summary, issues, reviewerCoverage, recommendations } = analysis;
    
    let body = `## 🤖 AI Code Review Summary\n\n`;
    
    // Overall summary
    body += `**Overall Rating:** ${summary.overallRating}\n`;
    body += `**Recommendation:** ${summary.recommendApproval ? '✅ Approve' : '❌ Request Changes'}\n\n`;
    
    // Issues breakdown
    body += `### 📊 Issues Found\n`;
    body += `- **Total Issues:** ${summary.totalIssues}\n`;
    body += `- **Critical:** ${summary.criticalIssues}\n`;
    body += `- **High:** ${summary.highIssues}\n`;
    body += `- **Medium:** ${summary.mediumIssues}\n`;
    body += `- **Low:** ${summary.lowIssues}\n\n`;

    // Reviewer coverage analysis
    if (reviewerCoverage) {
      body += `### 👥 Review Coverage Analysis\n`;
      body += `- **Issues found by reviewer:** ${reviewerCoverage.issuesFoundByReviewer}\n`;
      body += `- **Issues missed by reviewer:** ${reviewerCoverage.issuesMissedByReviewer}\n`;
      body += `- **Additional issues found:** ${reviewerCoverage.additionalIssuesFound}\n`;
      body += `- **Review quality:** ${reviewerCoverage.reviewQuality}\n\n`;
    }

    // Critical issues summary
    const criticalIssues = issues.filter(issue => issue.severity === 'CRITICAL');
    if (criticalIssues.length > 0) {
      body += `### 🚨 Critical Issues\n`;
      criticalIssues.forEach(issue => {
        body += `- **${issue.file}:${issue.line}** - ${issue.title}\n`;
      });
      body += `\n`;
    }

    // Recommendations
    if (recommendations && recommendations.length > 0) {
      body += `### 💡 Recommendations\n`;
      recommendations.forEach(rec => {
        body += `- ${rec}\n`;
      });
      body += `\n`;
    }

    body += `---\n*Powered by AI Code Reviewer with SonarQube Standards*`;
    
    return body;
  }

  // Format inline comments for specific lines
  formatInlineComments(issues) {
    return issues
      .filter(issue => issue.file && issue.line)
      .map(issue => ({
        path: issue.file,
        line: issue.line,
        body: this.formatIssueComment(issue),
      }));
  }

  // Format individual issue comment
  formatIssueComment(issue) {
    const severityEmoji = {
      CRITICAL: '🚨',
      HIGH: '🔴',
      MEDIUM: '🟡',
      LOW: '🔵',
      INFO: 'ℹ️',
    };

    const typeEmoji = {
      BUG: '🐛',
      VULNERABILITY: '🔒',
      CODE_SMELL: '👃',
      COVERAGE: '📊',
      DUPLICATION: '📋',
    };

    let comment = `${severityEmoji[issue.severity]} ${typeEmoji[issue.type]} **${issue.title}**\n\n`;
    comment += `${issue.description}\n\n`;
    comment += `**Suggestion:** ${issue.suggestion}\n`;
    
    if (issue.sonarRule) {
      comment += `**SonarQube Rule:** ${issue.sonarRule}\n`;
    }
    
    return comment;
  }

  // Get file content for a specific commit
  async getFileContent(owner, repo, path, ref) {
    try {
      const { data } = await this.octokit.rest.repos.getContent({
        owner,
        repo,
        path,
        ref,
      });

      // Decode base64 content
      const content = Buffer.from(data.content, 'base64').toString('utf8');
      return content;
    } catch (error) {
      logger.error(`Error fetching file content for ${path}:`, error);
      return null;
    }
  }

  // Get commits in the PR
  async getPullRequestCommits(owner, repo, pullNumber) {
    try {
      const { data: commits } = await this.octokit.rest.pulls.listCommits({
        owner,
        repo,
        pull_number: pullNumber,
      });

      return commits.map(commit => ({
        sha: commit.sha,
        message: commit.commit.message,
        author: commit.commit.author.name,
        date: commit.commit.author.date,
      }));
    } catch (error) {
      logger.error('Error fetching PR commits:', error);
      throw new Error(`Failed to fetch PR commits: ${error.message}`);
    }
  }

  // Check if branch is in target branches list
  isTargetBranch(branch) {
    return config.review.targetBranches.includes(branch);
  }
}

module.exports = new GitHubService();