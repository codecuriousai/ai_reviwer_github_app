// src/prompts/enhanced-prompts.js - Enhanced prompts with comprehensive comment resolution logic

const enhancedPrompts = {
  // Prompt for generating specific code fix suggestions with snippets
  codeFixSuggestionPrompt: `You are an expert code reviewer and developer. Your task is to provide specific, actionable code fix suggestions with actual code snippets for identified issues.

IMPORTANT: You will receive:
1. A specific issue/finding from a previous code review
2. The exact file content and line context where the issue exists
3. The current code around that line

Your job is to:
1. Analyze the specific issue in context
2. Provide the EXACT current problematic code
3. Provide a COMPLETE, working fix with proper code snippet
4. Explain the fix and any additional considerations

CRITICAL RESPONSE REQUIREMENTS:
- Respond with ONLY valid JSON
- No markdown formatting or code blocks  
- No additional text before or after JSON
- Response must start with { and end with }
- All strings must be properly escaped
- Include actual working code in the suggestions

REQUIRED JSON STRUCTURE:
{
  "file": "exact-file-path",
  "line": 42,
  "issue": "Original issue description",
  "severity": "CRITICAL",
  "category": "VULNERABILITY",
  "current_code": "// The actual problematic code snippet",
  "suggested_fix": "// The complete working fix code",
  "explanation": "Detailed explanation of why this fix works",
  "additional_considerations": "Any important notes about implementation, testing, or side effects",
  "estimated_effort": "5 minutes", 
  "confidence": "high"
}

EXAMPLE:
If you receive an issue about hardcoded passwords:
{
  "file": "src/auth.js",
  "line": 15,
  "issue": "Hardcoded password found in authentication code",
  "severity": "CRITICAL", 
  "category": "VULNERABILITY",
  "current_code": "const password = 'hardcoded123';\\nconst user = authenticate(username, password);",
  "suggested_fix": "const password = process.env.AUTH_PASSWORD || '';\\nif (!password) {\\n  throw new Error('AUTH_PASSWORD environment variable is required');\\n}\\nconst user = authenticate(username, password);",
  "explanation": "Replace hardcoded password with environment variable. Added validation to ensure the environment variable is set to prevent runtime errors.",
  "additional_considerations": "Make sure to add AUTH_PASSWORD to your .env file and deployment configuration. Consider using a more secure secret management system for production.",
  "estimated_effort": "10 minutes",
  "confidence": "high"
}

CODE QUALITY STANDARDS:
- Provide complete, working code that can be directly used
- Include proper error handling where appropriate
- Follow language-specific best practices
- Consider performance implications
- Include necessary imports or dependencies if needed
- Ensure the fix doesn't break existing functionality

EFFORT ESTIMATION:
- "5 minutes": Simple fixes (variable renames, small syntax changes)
- "15 minutes": Medium fixes (refactoring small functions, adding error handling)
- "30 minutes": Complex fixes (significant refactoring, architectural changes)
- "1 hour+": Major fixes (large refactoring, security overhauls)

CONFIDENCE LEVELS:
- "high": Very confident this fix will work without issues
- "medium": Fix should work but may need minor adjustments
- "low": Fix needs careful testing and may require additional changes`,

  // Prompt for merge readiness assessment
  mergeReadinessPrompt: `You are an expert code reviewer responsible for determining if a Pull Request is ready for merge.

Your task is to analyze:
1. All AI-identified issues and their current status
2. All human review comments and whether they've been addressed  
3. The overall quality and completeness of the review process
4. Any outstanding security, performance, or critical issues

CRITICAL RESPONSE REQUIREMENTS:
- Respond with ONLY valid JSON
- No markdown formatting or code blocks
- Response must start with { and end with }
- All strings must be properly escaped

REQUIRED JSON STRUCTURE:
{
  "status": "READY_FOR_MERGE",
  "reason": "Detailed explanation of the decision",
  "recommendation": "Specific next steps or actions needed",
  "outstanding_issues": [
    {
      "type": "SECURITY",
      "severity": "CRITICAL", 
      "description": "Specific issue description",
      "file": "path/to/file.js",
      "line": 42,
      "addressed": false
    }
  ],
  "review_quality_assessment": {
    "human_review_coverage": "GOOD",
    "ai_analysis_coverage": "COMPREHENSIVE", 
    "critical_issues_addressed": true,
    "security_issues_addressed": false,
    "total_unresolved_issues": 3
  },
  "merge_readiness_score": 75,
  "confidence": "high"
}

STATUS OPTIONS:
- "READY_FOR_MERGE": All critical issues resolved, PR is safe to merge
- "NOT_READY_FOR_MERGE": Critical issues remain unresolved
- "REVIEW_REQUIRED": Needs additional human review before determination

ISSUE TYPES:
- "SECURITY": Security vulnerabilities, authentication issues
- "PERFORMANCE": Performance bottlenecks, memory leaks
- "BUG": Logic errors, potential crashes
- "CODE_QUALITY": Maintainability, readability issues
- "DOCUMENTATION": Missing or incorrect documentation

COVERAGE ASSESSMENT:
- "COMPREHENSIVE": Thorough analysis covering all aspects
- "GOOD": Solid coverage with minor gaps
- "PARTIAL": Some areas covered but significant gaps
- "MINIMAL": Very limited coverage

MERGE READINESS SCORING:
- 90-100: Excellent, ready to merge immediately
- 75-89: Good, minor issues but safe to merge
- 50-74: Needs work, should not merge yet
- 0-49: Poor quality, requires significant fixes`,

  // Build fix suggestion prompt with context
  buildFixSuggestionPrompt: (finding, fileContent, contextLines = 5) => {
    let prompt = enhancedPrompts.codeFixSuggestionPrompt;
    
    prompt += `\n\nISSUE TO FIX:
File: ${finding.file}
Line: ${finding.line}
Issue: ${finding.issue}
Severity: ${finding.severity}
Category: ${finding.category}
Original Suggestion: ${finding.suggestion}

CURRENT FILE CONTENT CONTEXT:`;

    // Add file content with line numbers for context
    if (fileContent) {
      const lines = fileContent.split('\n');
      const startLine = Math.max(0, finding.line - contextLines - 1);
      const endLine = Math.min(lines.length, finding.line + contextLines);
      
      prompt += `\n\nLines ${startLine + 1} to ${endLine}:`;
      for (let i = startLine; i < endLine; i++) {
        const lineNum = i + 1;
        const marker = lineNum === finding.line ? ' --> ' : '     ';
        prompt += `\n${marker}${lineNum}: ${lines[i]}`;
      }
    }

    prompt += `\n\nProvide a specific, working code fix for this issue. Include the exact current problematic code and the complete replacement code that resolves the issue.`;

    return prompt;
  },

  // ENHANCED: buildMergeReadinessPrompt with comprehensive comment resolution logic
  buildMergeReadinessPrompt: (prData, aiFindings, reviewComments, currentStatus) => {
    let prompt = enhancedPrompts.mergeReadinessPrompt;
    
    const pr = prData.pr || prData || {};
    const totalIssues = aiFindings ? aiFindings.length : 0;
    const criticalIssues = aiFindings ? aiFindings.filter(f => f.severity === 'CRITICAL' || f.severity === 'BLOCKER').length : 0;
    const securityIssues = aiFindings ? aiFindings.filter(f => f.category === 'VULNERABILITY' || f.category === 'SECURITY_HOTSPOT').length : 0;
    
    prompt += `\n\nPULL REQUEST INFORMATION:
- PR #${pr.number}: ${pr.title}
- Repository: ${pr.repository}
- Author: ${pr.author}
- Files Changed: ${prData.files ? prData.files.length : 0}
- Lines Added: ${pr.additions || 0}
- Lines Deleted: ${pr.deletions || 0}

AI ANALYSIS FINDINGS:`;

    // Enhanced handling for zero findings scenario
    if (totalIssues === 0) {
      prompt += `\nTotal Issues Found by AI: 0
- NO SECURITY VULNERABILITIES DETECTED
- NO CRITICAL OR BLOCKING ISSUES FOUND
- NO CODE QUALITY ISSUES IDENTIFIED
- All automated checks passed successfully

ANALYSIS RESULT: Clean code with no issues detected by automated review.`;
    } else {
      prompt += `\nTotal Issues Found by AI: ${totalIssues}
- Critical/Blocker Issues: ${criticalIssues}
- Security Issues: ${securityIssues}
- Other Issues: ${totalIssues - criticalIssues - securityIssues}

DETAILED FINDINGS:`;
      aiFindings.forEach((finding, index) => {
        const posted = finding.posted ? 'POSTED' : 'NOT POSTED';
        prompt += `\n${index + 1}. [${finding.severity}] ${finding.file}:${finding.line} - ${finding.issue} (${posted})`;
      });
    }

    // ENHANCED: Comment resolution analysis
    prompt += `\n\nHUMAN REVIEW COMMENTS ANALYSIS:`;
    
    if (reviewComments && reviewComments.length > 0) {
      prompt += `\nTotal Review Comments: ${reviewComments.length}`;
      
      // Analyze comment types and resolution status
      const requestingChanges = reviewComments.filter(comment => {
        const body = comment.body.toLowerCase();
        return body.includes('request changes') ||
               body.includes('needs fix') ||
               body.includes('must fix') ||
               body.includes('blocking') ||
               body.includes('please change') ||
               body.includes('should fix') ||
               body.includes('required:') ||
               (body.includes('not') && (body.includes('approve') || body.includes('ready')));
      });
      
      const approvals = reviewComments.filter(comment => {
        const body = comment.body.toLowerCase();
        return body.includes('approve') ||
               body.includes('lgtm') ||
               body.includes('looks good') ||
               body.includes('ship it') ||
               body.includes('ready to merge') ||
               body.includes('👍') ||
               body.includes(':+1:');
      });
      
      const questionsOrSuggestions = reviewComments.filter(comment => {
        const body = comment.body.toLowerCase();
        return body.includes('?') ||
               body.includes('consider') ||
               body.includes('suggest') ||
               body.includes('might want to') ||
               body.includes('could') ||
               body.includes('optional:');
      });
      
      // Check for resolution indicators
      const resolutionIndicators = reviewComments.filter(comment => {
        const body = comment.body.toLowerCase();
        return body.includes('resolved') ||
               body.includes('fixed') ||
               body.includes('addressed') ||
               body.includes('done') ||
               body.includes('completed') ||
               body.includes('thank you') ||
               body.includes('thanks for fixing') ||
               body.includes('updated');
      });
      
      prompt += `\n\nCOMMENT ANALYSIS:
- Change Requests: ${requestingChanges.length}
- Approvals: ${approvals.length}
- Questions/Suggestions: ${questionsOrSuggestions.length}
- Resolution Indicators: ${resolutionIndicators.length}`;

      // Determine comment resolution status
      let commentStatus;
      if (requestingChanges.length > 0 && resolutionIndicators.length === 0) {
        commentStatus = "UNRESOLVED_BLOCKING_COMMENTS";
        prompt += `\n\nCOMMENT STATUS: UNRESOLVED - There are ${requestingChanges.length} change requests with no resolution indicators.`;
      } else if (requestingChanges.length > 0 && resolutionIndicators.length > 0) {
        commentStatus = "PARTIALLY_RESOLVED_COMMENTS";
        prompt += `\n\nCOMMENT STATUS: PARTIALLY RESOLVED - ${requestingChanges.length} change requests, ${resolutionIndicators.length} resolution indicators.`;
      } else if (approvals.length > 0 || (questionsOrSuggestions.length > 0 && resolutionIndicators.length > 0)) {
        commentStatus = "RESOLVED_COMMENTS";
        prompt += `\n\nCOMMENT STATUS: RESOLVED - Comments appear to be addressed or approved.`;
      } else {
        commentStatus = "NEUTRAL_COMMENTS";
        prompt += `\n\nCOMMENT STATUS: NEUTRAL - General discussion without blocking concerns.`;
      }

      // List specific comments for context
      prompt += `\n\nCOMMENT DETAILS:`;
      reviewComments.forEach((comment, index) => {
        const location = comment.path && comment.line ? ` on ${comment.path}:${comment.line}` : '';
        const timestamp = comment.createdAt ? ` (${new Date(comment.createdAt).toLocaleDateString()})` : '';
        prompt += `\n${index + 1}. ${comment.user}${location}${timestamp}: ${comment.body.substring(0, 150)}${comment.body.length > 150 ? '...' : ''}`;
      });

    } else {
      prompt += `\nTotal Review Comments: 0
    
COMMENT STATUS: NO_COMMENTS - This may indicate:
- Simple/straightforward changes that don't require extensive review
- Empty file changes or minor modifications  
- Documentation updates or configuration changes
- Automated changes (e.g., dependency updates)
- Author is trusted contributor with clean track record`;
    }

    if (currentStatus) {
      prompt += `\n\nCURRENT PR STATUS:
- Mergeable: ${currentStatus.mergeable || 'unknown'}
- Merge State: ${currentStatus.merge_state || 'unknown'}  
- Review Decision: ${currentStatus.review_decision || 'unknown'}`;
    }

    // Enhanced decision criteria with comment resolution logic
    prompt += `\n\nMERGE READINESS DECISION CRITERIA:

**READY_FOR_MERGE** when:
- Zero AI findings AND (no comments OR comments resolved/approved)
- Only minor/info issues (≤3) with no security vulnerabilities AND no unresolved blocking comments
- All critical/blocker issues resolved AND all change requests addressed
- No unaddressed security concerns

**NOT_READY_FOR_MERGE** when:
- Critical or blocker issues remain unaddressed
- Security vulnerabilities are present  
- Unresolved blocking change requests from reviewers
- Major bugs that could impact functionality

**REVIEW_REQUIRED** when:
- Mixed signals: some issues resolved, others unclear
- Complex changes with insufficient human review
- Conflicting reviewer feedback that needs resolution

CURRENT SCENARIO ASSESSMENT:`;

    // Scenario-specific guidance based on AI findings and comment status
    if (totalIssues === 0) {
      if (!reviewComments || reviewComments.length === 0) {
        prompt += `
SCENARIO: CLEAN PR WITH NO COMMENTS
- No AI issues detected
- No reviewer concerns raised
- Typical for: empty files, documentation, simple config changes
- RECOMMENDATION: READY_FOR_MERGE (high confidence)`;
      } else {
        // Has comments but no AI issues
        const hasUnresolvedBlockingComments = reviewComments.some(comment => {
          const body = comment.body.toLowerCase();
          return (body.includes('request changes') ||
                  body.includes('must fix') ||
                  body.includes('blocking')) &&
                 !reviewComments.some(laterComment => {
                   const laterBody = laterComment.body.toLowerCase();
                   return (laterBody.includes('resolved') ||
                           laterBody.includes('fixed') ||
                           laterBody.includes('addressed')) &&
                          new Date(laterComment.createdAt) > new Date(comment.createdAt);
                 });
        });
        
        if (hasUnresolvedBlockingComments) {
          prompt += `
SCENARIO: CLEAN CODE BUT UNRESOLVED REVIEWER CONCERNS  
- No AI issues but reviewers have unaddressed change requests
- RECOMMENDATION: NOT_READY_FOR_MERGE (respect reviewer feedback)`;
        } else {
          prompt += `
SCENARIO: CLEAN CODE WITH RESOLVED/NEUTRAL COMMENTS
- No AI issues and reviewer comments appear resolved or non-blocking
- RECOMMENDATION: READY_FOR_MERGE (moderate to high confidence)`;
        }
      }
    } else if (criticalIssues === 0 && securityIssues === 0) {
      prompt += `
SCENARIO: MINOR ISSUES ONLY
- ${totalIssues} minor/info issues, no critical/security concerns
- Comment resolution status affects final decision
- RECOMMENDATION: Consider READY_FOR_MERGE if comments resolved`;
    } else {
      prompt += `
SCENARIO: SIGNIFICANT ISSUES PRESENT  
- ${criticalIssues} critical/blocker issues, ${securityIssues} security issues
- Requires careful assessment regardless of comment status
- RECOMMENDATION: Likely NOT_READY_FOR_MERGE`;
    }

    prompt += `\n\nFINAL DECISION GUIDANCE:
1. Empty files or documentation with no issues → READY_FOR_MERGE
2. Clean code (zero findings) with no blocking comments → READY_FOR_MERGE  
3. Clean code with unresolved change requests → NOT_READY_FOR_MERGE
4. Minor issues only with resolved comments → READY_FOR_MERGE
5. Critical/security issues present → NOT_READY_FOR_MERGE
6. When in doubt about comment resolution → REVIEW_REQUIRED

Make your decision based on the complete picture of code quality AND review feedback.`;

    return prompt;
  }
};

module.exports = {
  enhancedPrompts,
  buildFixSuggestionPrompt: enhancedPrompts.buildFixSuggestionPrompt,
  buildMergeReadinessPrompt: enhancedPrompts.buildMergeReadinessPrompt
};