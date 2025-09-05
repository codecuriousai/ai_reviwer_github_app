// src/services/check-run-button.service.js - Interactive Button Management for Check Runs

const githubService = require('./github.service');
const aiService = require('./ai.service');
const logger = require('../utils/logger');
const { generateTrackingId, truncateText } = require('../utils/helpers');

class CheckRunButtonService {
  constructor() {
    this.activeCheckRuns = new Map(); // Store active check runs with button data
  }

  // Create enhanced check run with interactive buttons for each finding
  async createInteractiveCheckRun(owner, repo, pullNumber, analysis, headSha) {
    try {
      const trackingId = analysis.trackingId || generateTrackingId();
      analysis.trackingId = trackingId;

      logger.info(`Creating interactive check run for PR #${pullNumber}`, { trackingId });

      // Filter postable findings (ones that can be posted as inline comments)
      const postableFindings = this.getPostableFindings(analysis.detailedFindings || []);

      // Create check run with completion status and interactive buttons
      const checkRunData = {
        name: 'AI Code Review',
        head_sha: headSha,
        status: 'completed',
        conclusion: this.determineConclusion(analysis),
        output: {
          title: 'AI Code Review Completed',
          summary: this.generateInteractiveSummary(analysis, postableFindings),
          text: this.generateDetailedOutput(analysis, postableFindings, trackingId)
        },
        actions: this.generateCheckRunActions(postableFindings)
      };

      const checkRun = await githubService.createCheckRun(owner, repo, checkRunData);

      // Store check run data for action handling
      this.activeCheckRuns.set(checkRun.id, {
        owner,
        repo,
        pullNumber,
        headSha,
        trackingId,
        analysis,
        postableFindings,
        createdAt: Date.now(),
        buttonStates: postableFindings.reduce((acc, finding, index) => {
          acc[`comment-finding-${index}`] = 'ready';
          acc[`fix-suggestion-${index}`] = 'ready'; // NEW: Fix suggestion button
          return acc;
        }, { 
          'post-all': 'ready',
          'generate-fixes': 'ready',      // NEW: Generate all fix suggestions
          'check-merge': 'ready' // NEW: Check merge readiness (shortened)
        })
      });

      logger.info(`Interactive check run created: ${checkRun.id}`, {
        trackingId,
        postableCount: postableFindings.length
      });

      return checkRun;

    } catch (error) {
      logger.error('Error creating interactive check run:', error);
      throw new Error(`Failed to create interactive check run: ${error.message}`);
    }
  }

  // Generate actions (buttons) for the check run - ENHANCED with new buttons
  generateCheckRunActions(postableFindings) {
    const actions = [];
    // GitHub API only allows a max of 3 buttons in a check run
    const maxButtons = 3;

    // Always include these core buttons if there are findings
    if (postableFindings.length > 0) {
      actions.push({
        label: `Post All Comments`,
        description: `Post all ${postableFindings.length} findings`,
        identifier: 'post-all'
      });

      // NEW: Add fix suggestions button
      actions.push({
        label: `Generate Code Fixes`,
        description: `Get AI fix suggestions`,
        identifier: 'generate-fixes'
      });
    }

    // NEW: Always add merge readiness check button
    actions.push({
      label: `Check Merge Readiness`,
      description: `Assess if PR is ready to merge`,
      identifier: 'check-merge'
    });

    return actions.slice(0, maxButtons); // Ensure we don't exceed GitHub's limit
  }

  // Generate interactive summary for check run
  generateInteractiveSummary(analysis, postableFindings) {
    const { automatedAnalysis, reviewAssessment } = analysis;

    let summary = `Analysis completed successfully!\n\n`;
    summary += `**Issues Found:** ${automatedAnalysis.totalIssues}\n`;
    summary += `**Critical:** ${automatedAnalysis.severityBreakdown.critical}\n`;
    summary += `**Assessment:** ${reviewAssessment}\n\n`;

    if (postableFindings.length > 0) {
      summary += `**Interactive Comments Available:** ${postableFindings.length} findings can be posted as inline comments\n`;
      summary += `Click the buttons below to post individual or all findings directly to the code.\n\n`;
    } else {
      summary += `No new issues found that can be posted as inline comments.\n`;
    }

    summary += `See detailed analysis in PR comments.`;

    return summary;
  }

  // Generate detailed output showing each finding with clear formatting
  generateDetailedOutput(analysis, postableFindings, trackingId) {
    let output = `## AI Code Review Results\n\n`;

    const { automatedAnalysis, reviewAssessment, recommendation } = analysis;

    // Summary section
    output += `### Summary\n`;
    output += `- **Total Issues:** ${automatedAnalysis.totalIssues}\n`;
    output += `- **Review Assessment:** ${reviewAssessment}\n`;
    output += `- **Technical Debt:** ${automatedAnalysis.technicalDebtMinutes} minutes\n\n`;

    // Severity breakdown
    const severity = automatedAnalysis.severityBreakdown || {};
    output += `### Severity Breakdown\n`;
    output += `- Blocker: ${severity.blocker || 0}\n`;
    output += `- Critical: ${severity.critical || 0}\n`;
    output += `- Major: ${severity.major || 0}\n`;
    output += `- Minor: ${severity.minor || 0}\n`;
    output += `- Info: ${severity.info || 0}\n\n`;

    // Interactive findings section
    if (postableFindings.length > 0) {
      output += `### Interactive Comment Options\n`;
      output += `Click the buttons above to post these findings as inline code comments:\n\n`;

      postableFindings.forEach((finding, index) => {
        output += `**#${index + 1} - ${finding.severity} ${finding.category}**\n`;
        output += `- File: \`${finding.file}:${finding.line}\`\n`;
        output += `- Issue: ${finding.issue}\n`;
        output += `- Suggestion: ${finding.suggestion}\n\n`;
      });

      if (postableFindings.length > 1) {
        output += `Use "Post All Comments" to post all ${postableFindings.length} findings at once.\n\n`;
      }
    } else {
      output += `### No New Interactive Comments\n`;
      output += `All findings are either general issues or have already been addressed by reviewers.\n\n`;
    }

    // Recommendation
    output += `### Recommendation\n`;
    output += `${recommendation}\n\n`;

    output += `---\n`;
    output += `Analysis ID: ${trackingId}\n`;
    output += `Generated: ${new Date().toISOString()}`;

    return output;
  }

  // Handle check run button actions - ENHANCED with new actions
  async handleButtonAction(payload) {
    const { action, check_run, requested_action, repository } = payload;

    if (action !== 'requested_action' || check_run.name !== 'AI Code Review') {
      return false;
    }

    const checkRunId = check_run.id;
    const actionId = requested_action.identifier;

    logger.info(`Button action requested: ${actionId} for check run ${checkRunId}`);

    // Get stored check run data
    const checkRunData = this.activeCheckRuns.get(checkRunId);
    if (!checkRunData) {
      logger.error(`No data found for check run ${checkRunId}`);
      await this.updateCheckRunError(repository, checkRunId, 'Check run data not found. Please re-run AI review.');
      return true;
    }

    const { owner, repo, pullNumber, headSha, postableFindings, buttonStates, analysis } = checkRunData;

    try {
      // Update button state to processing
      buttonStates[actionId] = 'in_progress';
      await this.updateCheckRunProgress(repository, checkRunId, checkRunData, actionId);

      // Handle different button actions
      if (actionId === 'post-all') {
        await this.postAllFindings(owner, repo, pullNumber, headSha, postableFindings, checkRunData);
        Object.keys(buttonStates).forEach(key => {
          if (key.startsWith('comment-finding-') && buttonStates[key] !== 'error') {
            buttonStates[key] = 'completed';
          }
        });
        buttonStates['post-all'] = 'completed';

      } else if (actionId === 'generate-fixes') {
        // NEW: Generate fix suggestions for all findings
        await this.generateAllFixSuggestions(owner, repo, pullNumber, postableFindings, checkRunData);
        buttonStates['generate-fixes'] = 'completed';

      } else if (actionId === 'check-merge') {
        // NEW: Check merge readiness
        await this.checkMergeReadiness(owner, repo, pullNumber, analysis, checkRunData);
        buttonStates['check-merge'] = 'completed';

      } else if (actionId.startsWith('comment-finding-')) {
        // Post individual comment
        const findingIndex = parseInt(actionId.replace('comment-finding-', ''));
        const finding = postableFindings[findingIndex];

        if (!finding) {
          throw new Error(`Finding ${findingIndex} not found`);
        }

        await this.postIndividualFinding(owner, repo, pullNumber, headSha, finding, checkRunData);
        buttonStates[actionId] = 'completed';

      } else if (actionId.startsWith('fix-suggestion-')) {
        // NEW: Generate fix suggestion for individual finding
        const findingIndex = parseInt(actionId.replace('fix-suggestion-', ''));
        const finding = postableFindings[findingIndex];

        if (!finding) {
          throw new Error(`Finding ${findingIndex} not found`);
        }

        await this.generateIndividualFixSuggestion(owner, repo, pullNumber, finding, checkRunData);
        buttonStates[actionId] = 'completed';
      }

      // Update check run with completion status
      await this.updateCheckRunCompleted(repository, checkRunId, checkRunData, actionId);

      logger.info(`Button action completed: ${actionId} for PR #${pullNumber}`);
      return true;

    } catch (error) {
      logger.error(`Error handling button action ${actionId}:`, error);

      // Update button state to error
      buttonStates[actionId] = 'error';
      await this.updateCheckRunError(repository, checkRunId, `Failed to ${actionId}: ${error.message}`);

      return true;
    }
  }

  async postIndividualFinding(owner, repo, pullNumber, headSha, finding, checkRunData) {
    logger.info(`Posting individual finding for ${finding.file}:${finding.line}`, {
      pullNumber,
      trackingId: checkRunData.trackingId
    });

    try {
      // CRITICAL: Validate the finding against the original structured data
      const validationResult = await this.validateFindingAgainstStructuredData(
        owner, repo, pullNumber, finding
      );

      if (!validationResult.isValid) {
        logger.error(`Invalid finding detected: ${validationResult.error}`);
        throw new Error(validationResult.error);
      }

      // Use validated line number (might be adjusted)
      const finalLineNumber = validationResult.validatedLine || finding.line;
      const finalFileName = validationResult.validatedFile || finding.file;

      if (finalLineNumber !== finding.line || finalFileName !== finding.file) {
        logger.info(`Finding adjusted: ${finding.file}:${finding.line} -> ${finalFileName}:${finalLineNumber}`);
        finding.originalLine = finding.line;
        finding.originalFile = finding.file;
        finding.line = finalLineNumber;
        finding.file = finalFileName;
        finding.wasAdjusted = true;
      }

      const commentBody = this.formatInlineComment(finding, checkRunData.trackingId);

      // Post as a review with a single comment
      const commentsToPost = [{
        path: finding.file,
        line: finding.line,
        body: commentBody,
      }];

      await githubService.postReviewComments(owner, repo, pullNumber, headSha, commentsToPost);

      // Mark finding as posted
      finding.posted = true;

      logger.info(`Individual finding posted successfully`, {
        file: finding.file,
        line: finding.line,
        originalLine: finding.originalLine,
        wasAdjusted: finding.wasAdjusted || false,
        pullNumber
      });

    } catch (error) {
      logger.error(`Error posting individual finding for ${finding.file}:${finding.line}:`, error);
      throw new Error(`Failed to post comment for ${finding.file}:${finding.line} - ${error.message}`);
    }
  }

  // NEW: Validate finding against the original structured data that was sent to AI
  async validateFindingAgainstStructuredData(owner, repo, pullNumber, finding) {
    try {
      // Get the original PR data with structured file information
      const prData = await githubService.getPullRequestData(owner, repo, pullNumber);
      const structuredFiles = this.createStructuredFileDataForValidation(prData.files, prData.diff);

      // Find the target file in structured data
      const targetFile = structuredFiles.find(f => f.filename === finding.file);
      if (!targetFile) {
        return {
          isValid: false,
          error: `File ${finding.file} not found in PR changes`
        };
      }

      // Find the exact line in structured data
      const targetLine = targetFile.lines.find(l =>
        l.newLineNumber === finding.line &&
        l.commentable === true &&
        l.type === 'added'
      );

      if (targetLine) {
        // Perfect match - the AI got it right
        return {
          isValid: true,
          validatedLine: finding.line,
          validatedFile: finding.file,
          lineType: targetLine.type,
          lineContent: targetLine.content
        };
      }

      // Line not found - try to find nearest commentable line
      const commentableLines = targetFile.lines.filter(l => l.commentable && l.type === 'added');

      if (commentableLines.length === 0) {
        return {
          isValid: false,
          error: `No commentable lines found in file ${finding.file}`
        };
      }

      // Find closest commentable line within reasonable distance
      const maxDistance = 5;
      let closestLine = null;
      let minDistance = Infinity;

      commentableLines.forEach(line => {
        const distance = Math.abs(line.newLineNumber - finding.line);
        if (distance <= maxDistance && distance < minDistance) {
          minDistance = distance;
          closestLine = line;
        }
      });

      if (closestLine) {
        logger.warn(`Adjusting line number for ${finding.file}: ${finding.line} -> ${closestLine.newLineNumber}`);
        return {
          isValid: true,
          validatedLine: closestLine.newLineNumber,
          validatedFile: finding.file,
          wasAdjusted: true,
          adjustment: {
            originalLine: finding.line,
            adjustedLine: closestLine.newLineNumber,
            distance: minDistance
          },
          lineContent: closestLine.content
        };
      }

      return {
        isValid: false,
        error: `No commentable line found near line ${finding.line} in file ${finding.file} (checked within ${maxDistance} lines)`
      };

    } catch (error) {
      logger.error('Error validating finding against structured data:', error);
      return {
        isValid: false,
        error: `Validation failed: ${error.message}`
      };
    }
  }

  // NEW: Create structured file data for validation (reuse logic from ai.service.js)
  createStructuredFileDataForValidation(files, rawDiff) {
    const structuredFiles = [];

    files.forEach(file => {
      if (!file.patch) return;

      const lines = this.parseFileLinesForValidation(file.patch);

      structuredFiles.push({
        filename: file.filename,
        status: file.status,
        additions: file.additions,
        deletions: file.deletions,
        lines: lines
      });
    });

    return structuredFiles;
  }

  // NEW: Parse file lines for validation (matching the AI service logic)
  parseFileLinesForValidation(patch) {
    const lines = patch.split('\n');
    const structuredLines = [];
    let oldLineNum = 0;
    let newLineNum = 0;

    for (const line of lines) {
      if (line.startsWith('@@')) {
        const hunkMatch = line.match(/@@\s*-(\d+),?\d*\s*\+(\d+),?\d*\s*@@/);
        if (hunkMatch) {
          oldLineNum = parseInt(hunkMatch[1]) - 1;
          newLineNum = parseInt(hunkMatch[2]) - 1;
        }
        continue;
      }

      const lineType = line.charAt(0);
      const content = line.slice(1);

      if (lineType === '-') {
        oldLineNum++;
        // Deleted lines are not commentable
      }
      else if (lineType === '+') {
        newLineNum++;
        structuredLines.push({
          type: 'added',
          oldLineNumber: null,
          newLineNumber: newLineNum,
          content: content,
          commentable: true
        });
      }
      else if (lineType === ' ') {
        oldLineNum++;
        newLineNum++;
        structuredLines.push({
          type: 'context',
          oldLineNumber: oldLineNum,
          newLineNumber: newLineNum,
          content: content,
          commentable: false
        });
      }
    }

    return structuredLines;
  }

  // Enhanced comment formatting with adjustment info
  formatInlineComment(finding, trackingId) {
    const severityEmoji = this.getSeverityEmoji(finding.severity);
    const categoryEmoji = this.getCategoryEmoji(finding.category);

    let comment = `${severityEmoji} ${categoryEmoji} **AI Code Review Finding**\n\n`;
    comment += `**Issue:** ${finding.issue}\n\n`;
    comment += `**Severity:** ${finding.severity}\n`;
    comment += `**Category:** ${finding.category}\n\n`;

    // Add adjustment notice if line was changed
    if (finding.wasAdjusted && finding.originalLine) {
      comment += `**Note:** This issue was detected near line ${finding.originalLine} but commented on line ${finding.line} (closest commentable line in this PR).\n\n`;
    }

    comment += `**Suggestion:**\n${finding.suggestion}\n\n`;
    comment += `---\n`;
    comment += `*Posted via AI Code Reviewer | Analysis ID: \`${trackingId}\`*`;

    return comment;
  }

  // Post all findings as inline comments with proper line validation and error handling
  async postAllFindings(owner, repo, pullNumber, headSha, postableFindings, checkRunData) {
    logger.info(`Posting all findings for PR #${pullNumber}`, {
      count: postableFindings.length,
      trackingId: checkRunData.trackingId
    });

    const commentsToPost = [];
    let successCount = 0;
    const errors = [];
    const adjustedLines = [];

    // Process each finding and validate/adjust line numbers
    for (let i = 0; i < postableFindings.length; i++) {
      const finding = postableFindings[i];

      if (finding.posted) {
        successCount++;
        continue;
      }

      try {
        // Validate the line number
        const isValidLine = await githubService.validateCommentableLine(owner, repo, pullNumber, finding.file, finding.line);

        if (!isValidLine) {
          // Try to find a commentable line near the target
          const commentableLine = await githubService.findCommentableLine(owner, repo, pullNumber, finding.file, finding.line);

          if (!commentableLine) {
            throw new Error(`Line ${finding.line} in ${finding.file} is not part of the PR changes or cannot receive comments`);
          }

          // Track line adjustments for reporting
          adjustedLines.push({
            file: finding.file,
            originalLine: finding.line,
            adjustedLine: commentableLine
          });

          // Update the finding
          finding.originalLine = finding.line;
          finding.line = commentableLine;
          finding.lineAdjusted = true;

          logger.info(`Adjusted line number for ${finding.file} from ${finding.originalLine} to ${commentableLine}`);
        }

        const commentBody = this.formatInlineComment(finding, checkRunData.trackingId);

        commentsToPost.push({
          path: finding.file,
          line: finding.line,
          body: commentBody,
        });

        finding.posted = true;
        successCount++;

      } catch (error) {
        const errorMsg = `${finding.file}:${finding.line} - ${error.message}`;
        logger.error(`Error processing finding ${i + 1}:`, error);
        errors.push(errorMsg);
      }
    }

    // Post all valid comments in a single review
    if (commentsToPost.length > 0) {
      try {
        await githubService.postReviewComments(owner, repo, pullNumber, headSha, commentsToPost);
        logger.info(`Successfully posted ${commentsToPost.length} comments in bulk review`);
      } catch (bulkPostError) {
        logger.error('Error in bulk posting to GitHub:', bulkPostError);
        errors.push(`Bulk posting failed: ${bulkPostError.message}`);

        // Attempt individual posting as fallback
        logger.info('Attempting individual comment posting as fallback...');
        await this.fallbackIndividualPosting(owner, repo, pullNumber, headSha, commentsToPost, postableFindings, errors);
      }
    }

    // Post comprehensive summary comment
    const summaryMessage = this.formatBulkPostSummaryWithAdjustments(
      successCount,
      errors.length,
      errors,
      adjustedLines,
      checkRunData.trackingId
    );

    await githubService.postGeneralComment(owner, repo, pullNumber, summaryMessage);

    logger.info(`Bulk posting completed`, {
      pullNumber,
      successCount,
      errorCount: errors.length,
      adjustedLines: adjustedLines.length,
      trackingId: checkRunData.trackingId
    });

    return {
      successCount,
      errorCount: errors.length,
      errors,
      adjustedLines: adjustedLines.length
    };
  }

  // NEW: Fallback individual posting when bulk posting fails
  async fallbackIndividualPosting(owner, repo, pullNumber, headSha, commentsToPost, postableFindings, errors) {
    let fallbackSuccess = 0;

    for (let i = 0; i < commentsToPost.length; i++) {
      const comment = commentsToPost[i];
      const finding = postableFindings.find(f => f.file === comment.path && f.line === comment.line);

      try {
        // Small delay between individual posts
        if (i > 0) {
          await new Promise(resolve => setTimeout(resolve, 500));
        }

        await githubService.postReviewComments(owner, repo, pullNumber, headSha, [comment]);
        fallbackSuccess++;

        logger.info(`Fallback: Individual comment posted for ${comment.path}:${comment.line}`);

      } catch (individualError) {
        logger.error(`Fallback failed for ${comment.path}:${comment.line}:`, individualError);
        errors.push(`${comment.path}:${comment.line} - Fallback failed: ${individualError.message}`);

        if (finding) {
          finding.posted = false; // Mark as failed
        }
      }
    }

    logger.info(`Fallback individual posting completed: ${fallbackSuccess}/${commentsToPost.length} successful`);
  }

  // NEW: Generate fix suggestions for all findings
  async generateAllFixSuggestions(owner, repo, pullNumber, postableFindings, checkRunData) {
    logger.info(`Generating fix suggestions for all findings in PR #${pullNumber}`, {
      findingsCount: postableFindings.length,
      trackingId: checkRunData.trackingId
    });

    const fixSuggestions = [];
    const errors = [];
    let successCount = 0;

    // Get PR data to access file contents
    const prData = await githubService.getPullRequestData(owner, repo, pullNumber);

    for (let i = 0; i < postableFindings.length; i++) {
      const finding = postableFindings[i];
      
      try {
        // Get file content for context
        const fileContent = await this.getFileContent(owner, repo, finding.file, prData);
        
        // Generate fix suggestion using AI
        const fixSuggestion = await aiService.generateCodeFixSuggestion(finding, fileContent, prData);
        
        if (!fixSuggestion.error) {
          fixSuggestions.push(fixSuggestion);
          successCount++;
          logger.info(`Fix suggestion generated for ${finding.file}:${finding.line}`);
        } else {
          errors.push(`${finding.file}:${finding.line} - ${fixSuggestion.error_message}`);
        }

      } catch (error) {
        const errorMsg = `${finding.file}:${finding.line} - ${error.message}`;
        logger.error(`Error generating fix suggestion for finding ${i + 1}:`, error);
        errors.push(errorMsg);
      }
    }

    // Post comprehensive fix suggestions comment
    const fixSuggestionsComment = this.formatFixSuggestionsComment(
      fixSuggestions,
      errors,
      successCount,
      checkRunData.trackingId
    );

    await githubService.postGeneralComment(owner, repo, pullNumber, fixSuggestionsComment);

    logger.info(`Fix suggestions generation completed`, {
      pullNumber,
      successCount,
      errorCount: errors.length,
      trackingId: checkRunData.trackingId
    });

    return {
      successCount,
      errorCount: errors.length,
      errors,
      fixSuggestions
    };
  }

  // NEW: Generate fix suggestion for individual finding
  async generateIndividualFixSuggestion(owner, repo, pullNumber, finding, checkRunData) {
    logger.info(`Generating fix suggestion for ${finding.file}:${finding.line}`, {
      pullNumber,
      trackingId: checkRunData.trackingId
    });

    try {
      // Get PR data to access file contents
      const prData = await githubService.getPullRequestData(owner, repo, pullNumber);
      
      // Get file content for context
      const fileContent = await this.getFileContent(owner, repo, finding.file, prData);
      
      // Generate fix suggestion using AI
      const fixSuggestion = await aiService.generateCodeFixSuggestion(finding, fileContent, prData);
      
      if (fixSuggestion.error) {
        throw new Error(fixSuggestion.error_message);
      }

      // Post individual fix suggestion comment
      const commentBody = this.formatIndividualFixSuggestionComment(fixSuggestion, checkRunData.trackingId);
      
      await githubService.postGeneralComment(owner, repo, pullNumber, commentBody);

      logger.info(`Individual fix suggestion posted successfully for ${finding.file}:${finding.line}`);

    } catch (error) {
      logger.error(`Error generating individual fix suggestion for ${finding.file}:${finding.line}:`, error);
      throw error;
    }
  }

  // NEW: Check merge readiness
  async checkMergeReadiness(owner, repo, pullNumber, analysis, checkRunData) {
    logger.info(`Checking merge readiness for PR #${pullNumber}`, {
      trackingId: checkRunData.trackingId
    });

    try {
      // Get current PR status and review comments
      const prData = await githubService.getPullRequestData(owner, repo, pullNumber);
      const reviewComments = prData.comments || [];
      
      // Get current PR status from GitHub
      const currentStatus = {
        mergeable: prData.pr.mergeable,
        merge_state: prData.pr.mergeable_state,
        review_decision: prData.pr.review_decision
      };

      // Use AI to assess merge readiness
      const mergeAssessment = await aiService.assessMergeReadiness(
        prData, 
        analysis.detailedFindings || [], 
        reviewComments, 
        currentStatus
      );

      if (mergeAssessment.error) {
        throw new Error(mergeAssessment.error_message);
      }

      // Post merge readiness assessment comment
      const mergeReadinessComment = this.formatMergeReadinessComment(mergeAssessment, checkRunData.trackingId);
      
      await githubService.postGeneralComment(owner, repo, pullNumber, mergeReadinessComment);

      // Update check run data with merge assessment
      checkRunData.mergeAssessment = mergeAssessment;

      logger.info(`Merge readiness assessment completed: ${mergeAssessment.status}`, {
        pullNumber,
        score: mergeAssessment.merge_readiness_score,
        trackingId: checkRunData.trackingId
      });

    } catch (error) {
      logger.error(`Error checking merge readiness for PR #${pullNumber}:`, error);
      throw error;
    }
  }

  // NEW: Get file content for fix suggestion context
  async getFileContent(owner, repo, filename, prData) {
    try {
      // First try to get from PR files data if available
      const prFile = prData.files?.find(f => f.filename === filename);
      if (prFile && prFile.patch) {
        // Reconstruct file content from patch (simplified approach)
        // In a production system, you'd want to fetch the actual file content
        return this.reconstructFileFromPatch(prFile.patch);
      }

      // Fallback: get file content from GitHub API
      const { data: fileData } = await githubService.octokit.rest.repos.getContent({
        owner,
        repo,
        path: filename,
        ref: prData.pr.head.sha
      });

      if (fileData.type === 'file' && fileData.content) {
        return Buffer.from(fileData.content, 'base64').toString('utf8');
      }

      return '';
    } catch (error) {
      logger.warn(`Could not get file content for ${filename}:`, error.message);
      return '';
    }
  }

  // NEW: Reconstruct file content from patch (simplified)
  reconstructFileFromPatch(patch) {
    const lines = patch.split('\n');
    const fileLines = [];
    
    for (const line of lines) {
      if (line.startsWith('@@')) continue;
      if (line.startsWith('-')) continue; // Skip deleted lines
      
      if (line.startsWith('+')) {
        fileLines.push(line.substring(1)); // Add new lines
      } else if (line.startsWith(' ')) {
        fileLines.push(line.substring(1)); // Add context lines
      }
    }
    
    return fileLines.join('\n');
  }

  // NEW: Format fix suggestions comment
  formatFixSuggestionsComment(fixSuggestions, errors, successCount, trackingId) {
    let comment = `🔧 **AI Code Fix Suggestions Generated**\n\n`;
    comment += `**Summary:**\n`;
    comment += `- Successfully generated: ${successCount} fix suggestions\n`;
    
    if (errors.length > 0) {
      comment += `- Failed to generate: ${errors.length} fix suggestions\n`;
    }
    
    comment += `\n---\n\n`;

    if (fixSuggestions.length > 0) {
      comment += `## 💡 Fix Suggestions\n\n`;
      
      fixSuggestions.forEach((fix, index) => {
        comment += `### ${index + 1}. ${fix.severity} Issue in \`${fix.file}:${fix.line}\`\n\n`;
        comment += `**Issue:** ${fix.issue}\n\n`;
        
        if (fix.current_code) {
          comment += `**Current Code:**\n\`\`\`javascript\n${fix.current_code}\n\`\`\`\n\n`;
        }
        
        comment += `**Suggested Fix:**\n\`\`\`javascript\n${fix.suggested_fix}\n\`\`\`\n\n`;
        comment += `**Explanation:** ${fix.explanation}\n\n`;
        
        if (fix.additional_considerations) {
          comment += `**Additional Considerations:** ${fix.additional_considerations}\n\n`;
        }
        
        comment += `**Estimated Effort:** ${fix.estimated_effort} | **Confidence:** ${fix.confidence}\n\n`;
        comment += `---\n\n`;
      });
    }

    if (errors.length > 0) {
      comment += `## ❌ Fix Generation Errors\n\n`;
      errors.forEach(error => {
        comment += `• ${error}\n`;
      });
      comment += `\n`;
    }

    comment += `*Generated by AI Code Reviewer | Analysis ID: \`${trackingId}\`*`;
    return comment;
  }

  // NEW: Format individual fix suggestion comment
  formatIndividualFixSuggestionComment(fixSuggestion, trackingId) {
    const severityEmoji = this.getSeverityEmoji(fixSuggestion.severity);
    
    let comment = `${severityEmoji} **AI Fix Suggestion for \`${fixSuggestion.file}:${fixSuggestion.line}\`**\n\n`;
    comment += `**Issue:** ${fixSuggestion.issue}\n\n`;
    
    if (fixSuggestion.current_code) {
      comment += `**Current Code:**\n\`\`\`javascript\n${fixSuggestion.current_code}\n\`\`\`\n\n`;
    }
    
    comment += `**Suggested Fix:**\n\`\`\`javascript\n${fixSuggestion.suggested_fix}\n\`\`\`\n\n`;
    comment += `**Explanation:** ${fixSuggestion.explanation}\n\n`;
    
    if (fixSuggestion.additional_considerations) {
      comment += `**Additional Considerations:** ${fixSuggestion.additional_considerations}\n\n`;
    }
    
    comment += `**Estimated Effort:** ${fixSuggestion.estimated_effort} | **Confidence:** ${fixSuggestion.confidence}\n\n`;
    comment += `---\n`;
    comment += `*Generated by AI Code Reviewer | Analysis ID: \`${trackingId}\`*`;
    
    return comment;
  }

  // NEW: Format merge readiness comment
  formatMergeReadinessComment(mergeAssessment, trackingId) {
    const statusEmoji = this.getMergeStatusEmoji(mergeAssessment.status);
    
    let comment = `${statusEmoji} **PR Merge Readiness Assessment**\n\n`;
    comment += `**Status:** ${mergeAssessment.status}\n`;
    comment += `**Readiness Score:** ${mergeAssessment.merge_readiness_score}/100\n\n`;
    comment += `**Reason:** ${mergeAssessment.reason}\n\n`;
    comment += `**Recommendation:** ${mergeAssessment.recommendation}\n\n`;

    if (mergeAssessment.outstanding_issues && mergeAssessment.outstanding_issues.length > 0) {
      comment += `## 🚨 Outstanding Issues\n\n`;
      mergeAssessment.outstanding_issues.forEach((issue, index) => {
        const issueEmoji = this.getSeverityEmoji(issue.severity);
        comment += `${index + 1}. ${issueEmoji} **${issue.type}** (${issue.severity})\n`;
        comment += `   - ${issue.description}\n`;
        if (issue.file && issue.file !== 'system') {
          comment += `   - Location: \`${issue.file}:${issue.line}\`\n`;
        }
        comment += `   - Addressed: ${issue.addressed ? '✅ Yes' : '❌ No'}\n\n`;
      });
    }

    if (mergeAssessment.review_quality_assessment) {
      const qa = mergeAssessment.review_quality_assessment;
      comment += `## 📊 Review Quality Assessment\n\n`;
      comment += `- **Human Review Coverage:** ${qa.human_review_coverage}\n`;
      comment += `- **AI Analysis Coverage:** ${qa.ai_analysis_coverage}\n`;
      comment += `- **Critical Issues Addressed:** ${qa.critical_issues_addressed ? '✅ Yes' : '❌ No'}\n`;
      comment += `- **Security Issues Addressed:** ${qa.security_issues_addressed ? '✅ Yes' : '❌ No'}\n`;
      comment += `- **Total Unresolved Issues:** ${qa.total_unresolved_issues}\n\n`;
    }

    comment += `---\n`;
    comment += `*Assessment by AI Code Reviewer | Analysis ID: \`${trackingId}\` | Confidence: ${mergeAssessment.confidence}*`;
    
    return comment;
  }

  // NEW: Get merge status emoji
  getMergeStatusEmoji(status) {
    const emojiMap = {
      'READY_FOR_MERGE': '✅',
      'NOT_READY_FOR_MERGE': '❌',
      'REVIEW_REQUIRED': '⏳'
    };
    return emojiMap[status] || '❓';
  }

  // Enhanced inline comment formatting with line adjustment info
  formatInlineComment(finding, trackingId) {
    const severityEmoji = this.getSeverityEmoji(finding.severity);
    const categoryEmoji = this.getCategoryEmoji(finding.category);

    let comment = `${severityEmoji} ${categoryEmoji} **AI Code Review Finding**\n\n`;
    comment += `**Issue:** ${finding.issue}\n\n`;
    comment += `**Severity:** ${finding.severity}\n`;
    comment += `**Category:** ${finding.category}\n\n`;

    // Add line adjustment note if applicable
    if (finding.lineAdjusted && finding.originalLine) {
      comment += `**Note:** This issue was detected near line ${finding.originalLine} but commented on line ${finding.line} (closest commentable line in the PR changes).\n\n`;
    }

    comment += `**Suggestion:**\n${finding.suggestion}\n\n`;
    comment += `---\n`;
    comment += `*Posted via AI Code Reviewer | Analysis ID: \`${trackingId}\`*`;

    return comment;
  }

  // Enhanced summary formatting with line adjustment reporting
  formatBulkPostSummaryWithAdjustments(successCount, errorCount, errors, adjustedLines, trackingId) {
    let summary = `**All AI Comments Posted**\n\n`;
    summary += `Successfully posted: ${successCount} comments\n`;

    if (adjustedLines.length > 0) {
      summary += `Line adjustments made: ${adjustedLines.length} comments\n`;
    }

    if (errorCount > 0) {
      summary += `Failed to post: ${errorCount} comments\n\n`;
      summary += `**Errors:**\n`;
      errors.forEach(error => {
        summary += `• ${error}\n`;
      });
      summary += `\n`;
    }

    if (adjustedLines.length > 0) {
      summary += `**Line Adjustments Made:**\n`;
      summary += `Some comments were posted on nearby lines because the detected lines were not part of the PR changes:\n\n`;
      adjustedLines.forEach(adj => {
        summary += `• \`${adj.file}\`: Line ${adj.originalLine} → Line ${adj.adjustedLine}\n`;
      });
      summary += `\n*This is normal when issues are detected in unchanged code near PR modifications.*\n\n`;
    }

    summary += `All comments have been posted as inline review comments on the respective code lines.\n`;
    summary += `Analysis ID: \`${trackingId}\`\n`;
    summary += `Posted at: ${new Date().toISOString()}`;

    return summary;
  }

  // Format inline comment for a finding
  formatInlineComment(finding, trackingId) {
    const severityEmoji = this.getSeverityEmoji(finding.severity);
    const categoryEmoji = this.getCategoryEmoji(finding.category);

    let comment = `${severityEmoji} ${categoryEmoji} **AI Code Review Finding**\n\n`;
    comment += `**Issue:** ${finding.issue}\n\n`;
    comment += `**Severity:** ${finding.severity}\n`;
    comment += `**Category:** ${finding.category}\n\n`;
    comment += `**Suggestion:**\n${finding.suggestion}\n\n`;
    comment += `---\n`;
    comment += `*Posted via AI Code Reviewer | Analysis ID: \`${trackingId}\`*`;

    return comment;
  }

  // Format bulk posting summary
  formatBulkPostSummary(successCount, errorCount, errors, trackingId) {
    let summary = `**All AI Comments Posted**\n\n`;
    summary += `Successfully posted: ${successCount} comments\n`;

    if (errorCount > 0) {
      summary += `Failed to post: ${errorCount} comments\n\n`;
      errors.forEach(error => {
        summary += `• ${error}\n`;
      });
    }

    summary += `\nAll comments have been posted as inline review comments on the respective code lines.\n`;
    summary += `Analysis ID: \`${trackingId}\`\n`;
    summary += `Posted at: ${new Date().toISOString()}`;

    return summary;
  }

  // Update check run to show progress WITHOUT changing status
  async updateCheckRunProgress(repository, checkRunId, checkRunData, actionId) {
    const { analysis, postableFindings, trackingId } = checkRunData;

    let progressMessage;
    if (actionId === 'post-all') {
      progressMessage = `Posting all ${postableFindings.length} findings as inline comments...`;
    } else if (actionId === 'generate-fixes') {
      progressMessage = `Generating fix suggestions for all findings...`;
    } else if (actionId === 'check-merge') {
      progressMessage = `Checking merge readiness for PR #${checkRunData.pullNumber}...`;
    } else {
      const findingIndex = parseInt(actionId.replace('comment-finding-', ''));
      const finding = postableFindings[findingIndex];
      progressMessage = `Posting comment for ${finding.file}:${finding.line}...`;
    }

    await githubService.updateCheckRun(repository.owner.login, repository.name, checkRunId, {
      output: {
        title: 'AI Code Review - Posting Comments',
        summary: progressMessage,
        text: this.generateDetailedOutput(analysis, postableFindings, trackingId)
      }
    });
  }

  // Update check run when action completed
  async updateCheckRunCompleted(repository, checkRunId, checkRunData, actionId) {
    const { analysis, postableFindings, trackingId } = checkRunData;

    let completionMessage;
    if (actionId === 'post-all') {
      completionMessage = `All ${postableFindings.length} findings have been posted as inline comments.`;
    } else if (actionId === 'generate-fixes') {
      completionMessage = `All fix suggestions have been generated.`;
    } else if (actionId === 'check-merge') {
      completionMessage = `Merge readiness assessment completed.`;
    } else {
      const findingIndex = parseInt(actionId.replace('comment-finding-', ''));
      const finding = postableFindings[findingIndex];
      completionMessage = `Comment posted for ${finding.file}:${finding.line}.`;
    }

    await githubService.updateCheckRun(repository.owner.login, repository.name, checkRunId, {
      conclusion: 'success', // Conclusion can be updated on a completed run
      output: {
        title: 'AI Code Review - Comments Posted',
        summary: completionMessage,
        text: this.generateDetailedOutput(analysis, postableFindings, trackingId)
      },
      // Note: `actions` and `status` properties are intentionally omitted to avoid validation errors.
    });
  }

  // Update check run on error
  async updateCheckRunError(repository, checkRunId, errorMessage) {
    await githubService.updateCheckRun(repository.owner.login, repository.name, checkRunId, {
      conclusion: 'failure',
      output: {
        title: 'AI Code Review - Action Failed',
        summary: errorMessage,
      },
    });
  }

  // Filter findings that can be posted as inline comments
  getPostableFindings(detailedFindings) {
    if (!detailedFindings || !Array.isArray(detailedFindings)) {
      return [];
    }

    return detailedFindings.filter(finding =>
      finding.file &&
      finding.file !== 'unknown-file' &&
      finding.file !== 'AI_ANALYSIS_ERROR' &&
      finding.line &&
      finding.line > 0 &&
      !finding.posted
    );
  }

  // Determine check run conclusion based on analysis
  determineConclusion(analysis) {
    const { automatedAnalysis, reviewAssessment } = analysis;

    const hasBlockerIssues = automatedAnalysis.severityBreakdown.blocker > 0;
    const hasCriticalIssues = automatedAnalysis.severityBreakdown.critical > 0;

    if (hasBlockerIssues) return 'failure';
    if (hasCriticalIssues) return 'neutral';
    if (reviewAssessment === 'PROPERLY REVIEWED') return 'success';
    return 'neutral';
  }

  // Helper methods for emojis and colors
  getSeverityEmoji(severity) {
    const emojiMap = {
      'BLOCKER': '🚫',
      'CRITICAL': '🔴',
      'MAJOR': '🟡',
      'MINOR': '🔵',
      'INFO': 'ℹ️'
    };
    return emojiMap[severity.toUpperCase()] || 'ℹ️';
  }

  getCategoryEmoji(category) {
    const emojiMap = {
      'BUG': '🐛',
      'VULNERABILITY': '🔒',
      'SECURITY_HOTSPOT': '⚠️',
      'CODE_SMELL': '💨'
    };
    return emojiMap[category.toUpperCase()] || '💨';
  }

  getSeverityColor(severity) {
    const colorMap = {
      'BLOCKER': 'red',
      'CRITICAL': 'red',
      'MAJOR': 'orange',
      'MINOR': 'blue',
      'INFO': 'gray'
    };
    return colorMap[severity.toUpperCase()] || 'gray';
  }

  // Get statistics about active check runs
  getStats() {
    const stats = {
      activeCheckRuns: this.activeCheckRuns.size,
      totalFindings: 0,
      postedFindings: 0,
      pendingFindings: 0
    };

    for (const [checkRunId, data] of this.activeCheckRuns.entries()) {
      stats.totalFindings += data.postableFindings.length;
      stats.postedFindings += data.postableFindings.filter(f => f.posted).length;
      stats.pendingFindings += data.postableFindings.filter(f => !f.posted).length;
    }

    return stats;
  }

  // Clean old check run data
  cleanOldCheckRuns() {
    const maxAge = 24 * 60 * 60 * 1000; // 24 hours
    const now = Date.now();
    let cleaned = 0;

    for (const [checkRunId, data] of this.activeCheckRuns.entries()) {
      if (now - data.createdAt > maxAge) {
        this.activeCheckRuns.delete(checkRunId);
        cleaned++;
      }
    }

    if (cleaned > 0) {
      logger.info(`Cleaned ${cleaned} old check run entries`);
    }
  }
}

module.exports = new CheckRunButtonService();
