// src/services/interactive-comment.service.js - Handle Interactive AI Comment Posting

const githubService = require('./github.service');
const logger = require('../utils/logger');
const { generateTrackingId } = require('../utils/helpers');

class InteractiveCommentService {
  constructor() {
    this.pendingComments = new Map(); // Store comments for each PR
    this.commentActions = new Map(); // Track comment action states
  }

  // Store AI findings for interactive commenting
  storePendingComments(owner, repo, pullNumber, detailedFindings, trackingId) {
    const prKey = `${owner}/${repo}#${pullNumber}`;
    
    // Filter only issues that can be posted as inline comments (have file/line info)
    const postableFindings = detailedFindings.filter(finding => 
      finding.file && 
      finding.file !== 'unknown-file' && 
      finding.line && 
      finding.line > 0 &&
      finding.file !== 'AI_ANALYSIS_ERROR'
    );

    const commentData = {
      owner,
      repo,
      pullNumber,
      trackingId,
      findings: postableFindings.map((finding, index) => ({
        id: `${trackingId}-finding-${index}`,
        file: finding.file,
        line: finding.line,
        issue: finding.issue,
        severity: finding.severity,
        category: finding.category,
        suggestion: finding.suggestion,
        posted: false,
      })),
    };
    
    this.pendingComments.set(prKey, commentData);
    logger.info(`Stored ${postableFindings.length} postable findings for PR #${pullNumber}`);
  }

  // Handle a new command from an issue comment
  async handleCommand(owner, repo, pullNumber, commentBody) {
    const prKey = `${owner}/${repo}#${pullNumber}`;
    const commentData = this.pendingComments.get(prKey);
    
    if (!commentData) {
      logger.warn(`No pending findings found for PR #${pullNumber}`);
      return;
    }

    const command = commentBody.trim().split(/\s+/);
    const cmd = command[0];
    const findingId = command[1];

    if (cmd === '/ai-comment' && findingId) {
      await this.postFindingAsComment(commentData, findingId);
    } else if (cmd === '/ai-suggest' && findingId) {
      await this.postFindingAsSuggestion(commentData, findingId);
    } else if (cmd === '/ai-comment-all') {
      await this.postAllFindingsAsComments(commentData);
    }
  }

  // Post a single finding as a simple inline comment
  async postFindingAsComment(commentData, findingId) {
    const finding = commentData.findings.find(f => f.id === findingId && !f.posted);

    if (finding) {
      try {
        logger.info(`Posting comment for finding ${findingId} on file: ${finding.file}, line: ${finding.line}`);
        const pr = await githubService.getPullRequest(commentData.owner, commentData.repo, commentData.pullNumber);
        
        await githubService.postPullRequestReviewComment(
          commentData.owner,
          commentData.repo,
          commentData.pullNumber,
          pr.head.sha,
          finding.file,
          finding.line,
          this.generateCommentBody(finding)
        );

        finding.posted = true;
        this.pendingComments.set(commentData.prKey, commentData);
        logger.info(`Successfully posted comment for finding ${findingId}`);
      } catch (error) {
        logger.error(`Failed to post comment for finding ${findingId}:`, error);
      }
    } else {
      logger.warn(`Finding ${findingId} not found or already posted.`);
    }
  }

  // NEW: Post a single finding as a threaded suggestion
  async postFindingAsSuggestion(commentData, findingId) {
    const finding = commentData.findings.find(f => f.id === findingId && !f.posted);
    
    if (finding && finding.suggestion) {
      try {
        logger.info(`Posting suggestion for finding ${findingId} on file: ${finding.file}, line: ${finding.line}`);
        const pr = await githubService.getPullRequest(commentData.owner, commentData.repo, commentData.pullNumber);
        
        const body = this.generateSuggestionBody(finding);

        await githubService.postPullRequestReviewComment(
          commentData.owner,
          commentData.repo,
          commentData.pullNumber,
          pr.head.sha,
          finding.file,
          finding.line,
          body
        );

        finding.posted = true;
        this.pendingComments.set(commentData.prKey, commentData);
        logger.info(`Successfully posted suggestion for finding ${findingId}`);
      } catch (error) {
        logger.error(`Failed to post suggestion for finding ${findingId}:`, error);
      }
    } else {
      logger.warn(`Finding ${findingId} not found, already posted, or no suggestion available.`);
    }
  }

  // Post all pending findings as comments
  async postAllFindingsAsComments(commentData) {
    const unpostedFindings = commentData.findings.filter(f => !f.posted);
    
    if (unpostedFindings.length > 0) {
      logger.info(`Posting all ${unpostedFindings.length} unposted findings for PR #${commentData.pullNumber}`);
      for (const finding of unpostedFindings) {
        // Decide whether to post as a suggestion or a regular comment
        if (finding.suggestion) {
          await this.postFindingAsSuggestion(commentData, finding.id);
        } else {
          await this.postFindingAsComment(commentData, finding.id);
        }
      }
      logger.info('Finished posting all comments.');
    } else {
      logger.info('No new findings to post.');
    }
  }

  // Generate comment body
  generateCommentBody(finding) {
    const severityEmoji = this.getSeverityEmoji(finding.severity);
    const categoryEmoji = this.getCategoryEmoji(finding.category);
    return `### ${severityEmoji} ${categoryEmoji} AI Finding: ${finding.issue}`;
  }
  
  // NEW: Generate comment body with a code suggestion block
  generateSuggestionBody(finding) {
    const severityEmoji = this.getSeverityEmoji(finding.severity);
    const categoryEmoji = this.getCategoryEmoji(finding.category);
    
    let body = `### ${severityEmoji} ${categoryEmoji} AI Suggestion\n\n`;
    body += `**Issue:** ${finding.issue}\n\n`;
    body += `**Suggested Change:**\n`;
    body += '```suggestion\n';
    body += finding.suggestion;
    body += '\n```';
    return body;
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

  // Generate comment action instructions
  generateCommentInstructions(trackingId, findingsCount) {
    if (findingsCount === 0) {
      return '';
    }

    let instructions = '\n\n📋 **COMMENT POSTING INSTRUCTIONS:**\n';
    instructions += `To post AI findings as inline comments, use these commands:\n\n`;
    
    instructions += `**Individual Comments:**\n`;
    instructions += `• \`/ai-comment ${trackingId}-finding-0\` (for finding #1)\n`;
    instructions += `• \`/ai-suggest ${trackingId}-finding-0\` (for suggestion #1)\n`;
    instructions += `...\n\n`;
    instructions += `**All Comments:**\n`;
    instructions += `• \`/ai-comment-all\` (posts all unposted findings)\n`;
    
    return instructions;
  }
}

module.exports = new InteractiveCommentService();
