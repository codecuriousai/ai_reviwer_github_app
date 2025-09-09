const fs = require('fs');
const path = require('path');
const logger = require('../utils/logger');

class PRReviewStatusService {
  constructor() {
    this.dataDir = path.join(__dirname, '../../data');
    this.statusFile = path.join(this.dataDir, 'pr-review-status.json');
    this.ensureDataDirectory();
  }

  ensureDataDirectory() {
    if (!fs.existsSync(this.dataDir)) {
      fs.mkdirSync(this.dataDir, { recursive: true });
    }
  }

  loadStatus() {
    try {
      if (fs.existsSync(this.statusFile)) {
        const data = fs.readFileSync(this.statusFile, 'utf8');
        return JSON.parse(data);
      }
      return {};
    } catch (error) {
      logger.error('Error loading PR review status:', error);
      return {};
    }
  }

  saveStatus(status) {
    try {
      fs.writeFileSync(this.statusFile, JSON.stringify(status, null, 2));
    } catch (error) {
      logger.error('Error saving PR review status:', error);
    }
  }

  getPRKey(owner, repo, pullNumber) {
    return `${owner}/${repo}#${pullNumber}`;
  }

  hasReviewBeenCompleted(owner, repo, pullNumber) {
    const status = this.loadStatus();
    const prKey = this.getPRKey(owner, repo, pullNumber);
    return status[prKey]?.reviewCompleted === true;
  }

  hasFixesBeenCommitted(owner, repo, pullNumber) {
    const status = this.loadStatus();
    const prKey = this.getPRKey(owner, repo, pullNumber);
    return status[prKey]?.fixesCommitted === true;
  }

  markReviewCompleted(owner, repo, pullNumber) {
    const status = this.loadStatus();
    const prKey = this.getPRKey(owner, repo, pullNumber);
    
    if (!status[prKey]) {
      status[prKey] = {};
    }
    
    status[prKey].reviewCompleted = true;
    status[prKey].reviewCompletedAt = new Date().toISOString();
    
    this.saveStatus(status);
    logger.info(`Marked review as completed for ${prKey}`);
  }

  markFixesCommitted(owner, repo, pullNumber) {
    const status = this.loadStatus();
    const prKey = this.getPRKey(owner, repo, pullNumber);
    
    if (!status[prKey]) {
      status[prKey] = {};
    }
    
    status[prKey].fixesCommitted = true;
    status[prKey].fixesCommittedAt = new Date().toISOString();
    
    this.saveStatus(status);
    logger.info(`Marked fixes as committed for ${prKey}`);
  }

  getPRStatus(owner, repo, pullNumber) {
    const status = this.loadStatus();
    const prKey = this.getPRKey(owner, repo, pullNumber);
    return status[prKey] || {};
  }

  resetPRStatus(owner, repo, pullNumber) {
    const status = this.loadStatus();
    const prKey = this.getPRKey(owner, repo, pullNumber);
    delete status[prKey];
    this.saveStatus(status);
    logger.info(`Reset status for ${prKey}`);
  }
}

module.exports = new PRReviewStatusService();
