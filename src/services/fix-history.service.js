// src/services/fix-history.service.js - Track previously suggested fixes to prevent duplicates

const fs = require('fs').promises;
const path = require('path');
const logger = require('../utils/logger');

class FixHistoryService {
  constructor() {
    this.historyFile = path.join(__dirname, '../../data/fix-history.json');
    this.fixHistory = new Map();
    this.loadHistory();
  }

  // Load fix history from file
  async loadHistory() {
    try {
      const data = await fs.readFile(this.historyFile, 'utf8');
      const history = JSON.parse(data);
      
      // Convert array back to Map
      this.fixHistory = new Map(history);
      logger.info(`Loaded fix history with ${this.fixHistory.size} entries`);
    } catch (error) {
      if (error.code !== 'ENOENT') {
        logger.error('Error loading fix history:', error);
      }
      // Initialize empty history if file doesn't exist
      this.fixHistory = new Map();
    }
  }

  // Save fix history to file
  async saveHistory() {
    try {
      // Ensure data directory exists
      const dataDir = path.dirname(this.historyFile);
      await fs.mkdir(dataDir, { recursive: true });
      
      // Convert Map to array for JSON serialization
      const historyArray = Array.from(this.fixHistory.entries());
      await fs.writeFile(this.historyFile, JSON.stringify(historyArray, null, 2));
      logger.info(`Saved fix history with ${this.fixHistory.size} entries`);
    } catch (error) {
      logger.error('Error saving fix history:', error);
    }
  }

  // Generate a unique key for a fix suggestion
  generateFixKey(owner, repo, file, line, issue) {
    const normalizedIssue = issue.toLowerCase().trim();
    return `${owner}/${repo}:${file}:${line}:${normalizedIssue}`;
  }

  // Check if a fix has been previously suggested
  hasBeenSuggested(owner, repo, file, line, issue) {
    const key = this.generateFixKey(owner, repo, file, line, issue);
    return this.fixHistory.has(key);
  }

  // Mark a fix as suggested
  async markAsSuggested(owner, repo, file, line, issue, suggestion, trackingId) {
    const key = this.generateFixKey(owner, repo, file, line, issue);
    const fixRecord = {
      owner,
      repo,
      file,
      line,
      issue,
      suggestion,
      trackingId,
      suggestedAt: Date.now(),
      status: 'suggested'
    };
    
    this.fixHistory.set(key, fixRecord);
    await this.saveHistory();
    
    logger.info(`Marked fix as suggested: ${key}`, { trackingId });
  }

  // Mark a fix as committed
  async markAsCommitted(owner, repo, file, line, issue, commitSha) {
    const key = this.generateFixKey(owner, repo, file, line, issue);
    const fixRecord = this.fixHistory.get(key);
    
    if (fixRecord) {
      fixRecord.status = 'committed';
      fixRecord.committedAt = Date.now();
      fixRecord.commitSha = commitSha;
      
      this.fixHistory.set(key, fixRecord);
      await this.saveHistory();
      
      logger.info(`Marked fix as committed: ${key}`, { commitSha });
    }
  }

  // Filter out previously suggested fixes
  filterNewFindings(owner, repo, findings) {
    const newFindings = [];
    const skippedCount = 0;

    for (const finding of findings) {
      if (!this.hasBeenSuggested(owner, repo, finding.file, finding.line, finding.issue)) {
        newFindings.push(finding);
      } else {
        logger.info(`Skipping previously suggested fix: ${finding.file}:${finding.line} - ${finding.issue}`);
      }
    }

    logger.info(`Filtered findings: ${newFindings.length} new, ${findings.length - newFindings.length} previously suggested`);
    return newFindings;
  }

  // Get fix history for a specific repository
  getRepositoryHistory(owner, repo) {
    const repoKey = `${owner}/${repo}`;
    const repoHistory = [];
    
    for (const [key, record] of this.fixHistory.entries()) {
      if (key.startsWith(repoKey)) {
        repoHistory.push(record);
      }
    }
    
    return repoHistory;
  }

  // Clean up old history entries (older than 30 days)
  async cleanupOldHistory() {
    const thirtyDaysAgo = Date.now() - (30 * 24 * 60 * 60 * 1000);
    let cleanedCount = 0;
    
    for (const [key, record] of this.fixHistory.entries()) {
      if (record.suggestedAt < thirtyDaysAgo) {
        this.fixHistory.delete(key);
        cleanedCount++;
      }
    }
    
    if (cleanedCount > 0) {
      await this.saveHistory();
      logger.info(`Cleaned up ${cleanedCount} old fix history entries`);
    }
  }

  // Get statistics
  getStats() {
    const stats = {
      totalEntries: this.fixHistory.size,
      suggested: 0,
      committed: 0
    };
    
    for (const record of this.fixHistory.values()) {
      if (record.status === 'suggested') {
        stats.suggested++;
      } else if (record.status === 'committed') {
        stats.committed++;
      }
    }
    
    return stats;
  }
}

module.exports = new FixHistoryService();
