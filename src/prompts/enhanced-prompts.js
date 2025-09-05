// src/prompts/enhanced-prompts.js - Enhanced prompts for code fix suggestions and merge readiness

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

  // Build merge readiness prompt with all context
  buildMergeReadinessPrompt: (prData, aiFindings, reviewComments, currentStatus) => {
    let prompt = enhancedPrompts.mergeReadinessPrompt;
    
    const pr = prData.pr || prData || {};
    
    prompt += `\n\nPULL REQUEST INFORMATION:
- PR #${pr.number}: ${pr.title}
- Repository: ${pr.repository}
- Author: ${pr.author}
- Files Changed: ${prData.files ? prData.files.length : 0}
- Lines Added: ${pr.additions || 0}
- Lines Deleted: ${pr.deletions || 0}

AI ANALYSIS FINDINGS:`;

    if (aiFindings && aiFindings.length > 0) {
      prompt += `\nTotal Issues Found by AI: ${aiFindings.length}`;
      aiFindings.forEach((finding, index) => {
        const posted = finding.posted ? 'POSTED' : 'NOT POSTED';
        prompt += `\n${index + 1}. [${finding.severity}] ${finding.file}:${finding.line} - ${finding.issue} (${posted})`;
      });
    } else {
      prompt += `\nNo AI findings available`;
    }

    prompt += `\n\nHUMAN REVIEW COMMENTS:`;
    if (reviewComments && reviewComments.length > 0) {
      prompt += `\nTotal Review Comments: ${reviewComments.length}`;
      reviewComments.forEach((comment, index) => {
        const location = comment.path && comment.line ? ` on ${comment.path}:${comment.line}` : '';
        prompt += `\n${index + 1}. ${comment.user}${location}: ${comment.body}`;
      });
    } else {
      prompt += `\nNo human review comments available`;
    }

    if (currentStatus) {
      prompt += `\n\nCURRENT PR STATUS:
- Mergeable: ${currentStatus.mergeable || 'unknown'}
- Merge State: ${currentStatus.merge_state || 'unknown'}  
- Review Decision: ${currentStatus.review_decision || 'unknown'}`;
    }

    prompt += `\n\nBased on this information, determine if this PR is ready for merge. Consider:
1. Are all critical security issues resolved?
2. Are all blocker/critical issues addressed?
3. Has there been adequate human review?
4. Are there any unaddressed concerns in comments?
5. Overall code quality and risk assessment`;

    return prompt;
  }
};

module.exports = {
  enhancedPrompts,
  buildFixSuggestionPrompt: enhancedPrompts.buildFixSuggestionPrompt,
  buildMergeReadinessPrompt: enhancedPrompts.buildMergeReadinessPrompt
};