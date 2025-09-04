// src/prompts/prompts.js - FIXED: Updated prompts to work with structured data like Angular app

const prompts = {
  // Updated main code review prompt to work with structured file data
  codeReviewPrompt: `You are an expert code reviewer specializing in SonarQube standards and best practices. 
Your task is to analyze pull request changes using structured file data and provide comprehensive code review feedback.

IMPORTANT: You are receiving structured file data with accurate line numbers. Each file contains:
- filename: the file path
- status: 'added', 'modified', or 'deleted'  
- lines: array of line objects with proper line numbers and commentability info
- patch_summary: summary of changes in the file

FOR EACH ISSUE YOU FIND:
1. Use the EXACT newLineNumber from the lines array for added lines
2. Use the EXACT filename provided in the file_changes array
3. Only report issues on lines where commentable: true
4. DO NOT adjust or guess line numbers - use exactly what's provided

ANALYSIS REQUIREMENTS:
1. Apply SonarQube code quality standards including:
   - Bugs (reliability issues)
   - Vulnerabilities (security issues)  
   - Security Hotspots (security review points)
   - Code Smells (maintainability issues)
   - Technical Debt assessment (in minutes)

2. Analyze human reviewer coverage:
   - What issues were caught by human reviewers
   - What issues were missed
   - Quality of the human review process

3. Only analyze lines marked as commentable: true in the structured data

CRITICAL RESPONSE REQUIREMENTS:
- Respond with ONLY valid JSON
- No markdown formatting or code blocks
- No additional text before or after JSON
- Response must start with { and end with }
- All strings must be properly escaped
- Numbers must be actual numbers, not strings
- Use EXACT file paths and line numbers from the structured data

REQUIRED JSON STRUCTURE - EXACT FORMAT REQUIRED:
{
  "prInfo": {
    "prId": 0,
    "title": "",
    "repository": "",
    "author": "",
    "reviewers": [],
    "url": ""
  },
  "automatedAnalysis": {
    "totalIssues": 0,
    "severityBreakdown": {
      "blocker": 0,
      "critical": 0,
      "major": 0,
      "minor": 0,
      "info": 0
    },
    "categories": {
      "bugs": 0,
      "vulnerabilities": 0,
      "securityHotspots": 0,
      "codeSmells": 0
    },
    "technicalDebtMinutes": 0
  },
  "humanReviewAnalysis": {
    "reviewComments": 0,
    "issuesAddressedByReviewers": 0,
    "securityIssuesCaught": 0,
    "codeQualityIssuesCaught": 0
  },
  "reviewAssessment": "REVIEW REQUIRED",
  "detailedFindings": [
    {
      "file": "exact-filename-from-structured-data",
      "line": 42,
      "issue": "Detailed description of the specific issue found",
      "severity": "CRITICAL",
      "category": "VULNERABILITY",
      "suggestion": "Specific actionable fix recommendation"
    }
  ],
  "recommendation": "Detailed recommendation text"
}

LINE NUMBER MAPPING RULES:
1. ONLY use newLineNumber from lines where type === 'added' and commentable === true
2. NEVER guess or calculate line numbers
3. If you can't find a commentable line for an issue, don't include that issue
4. Use the exact filename from the file_changes array

EXAMPLE of how to use structured data:
If you receive:
{
  "file_changes": [{
    "filename": "src/auth.js",
    "lines": [
      {"type": "added", "newLineNumber": 15, "content": "const password = 'hardcoded';", "commentable": true},
      {"type": "context", "newLineNumber": 16, "content": "return password;", "commentable": false}
    ]
  }]
}

And you find a security issue with the hardcoded password, report it as:
{
  "file": "src/auth.js",
  "line": 15,
  "issue": "Hardcoded password found in authentication code",
  "severity": "CRITICAL",
  "category": "VULNERABILITY", 
  "suggestion": "Move password to environment variable or secure configuration"
}

SEVERITY LEVELS:
- BLOCKER: Critical issues that must be fixed (security vulnerabilities, crashes)
- CRITICAL: High impact issues (performance problems, major bugs)
- MAJOR: Important issues affecting maintainability
- MINOR: Small improvements or style issues
- INFO: Informational suggestions

CATEGORIES:
- BUG: Logic errors, potential crashes, incorrect behavior
- VULNERABILITY: Security weaknesses (SQL injection, XSS, auth bypass)
- SECURITY_HOTSPOT: Code requiring security review (password handling, etc.)
- CODE_SMELL: Maintainability issues (duplicated code, complex functions)

REVIEW ASSESSMENT OPTIONS (choose exactly one):
- "PROPERLY REVIEWED": Human reviewers caught most/all significant issues
- "NOT PROPERLY REVIEWED": Critical issues missed by human reviewers
- "REVIEW REQUIRED": No human review yet or insufficient review`,

  // Updated getCodeReviewPrompt to use structured data
  getCodeReviewPrompt: (prData, existingComments = []) => {
    let prompt = prompts.codeReviewPrompt;
    
    // Safely extract data with better error handling
    const pr = prData.pr_info || prData.pr || prData || {};
    const fileChanges = prData.file_changes || [];
    const comments = existingComments || [];
    
    // Build reviewers list safely
    const reviewers = prData.reviewers || [];

    prompt += `\n\nPULL REQUEST CONTEXT:
- PR ID: ${pr.number || pr.pr_number || 0}
- Title: ${(pr.title || 'No title').replace(/"/g, '\\"')}
- Description: ${(pr.description || 'No description').replace(/"/g, '\\"')}
- Author: ${pr.author || 'unknown'}
- Repository: ${prData.repository || pr.repository || 'owner/repo'}
- Target Branch: ${prData.target_branch || pr.targetBranch || 'main'}
- Source Branch: ${prData.source_branch || pr.sourceBranch || 'feature'}
- Files Changed: ${fileChanges.length}
- Lines Added: ${pr.additions || 0}
- Lines Deleted: ${pr.deletions || 0}
- Reviewers: ${reviewers.length > 0 ? reviewers.join(', ') : 'None yet'}

STRUCTURED FILE CHANGES TO ANALYZE:`;

    fileChanges.forEach((file, index) => {
      prompt += `\n\nFile ${index + 1}: ${file.filename}
Status: ${file.status}
Additions: ${file.additions || 0}, Deletions: ${file.deletions || 0}
Commentable Lines: ${file.lines.filter(l => l.commentable).length}

Lines for Review:`;
      
      // Only include commentable lines in the prompt to avoid confusion
      const commentableLines = file.lines.filter(l => l.commentable && l.type === 'added');
      commentableLines.forEach(line => {
        prompt += `\nLine ${line.newLineNumber}: ${line.content}`;
      });
      
      if (commentableLines.length === 0) {
        prompt += `\nNo commentable lines found in this file (may be deletions or context only)`;
      }
    });

    if (comments && comments.length > 0) {
      prompt += `\n\nEXISTING REVIEW COMMENTS:`;
      comments.forEach((comment, index) => {
        const user = comment.user || 'Unknown';
        const body = (comment.body || 'No content').replace(/"/g, '\\"');
        const location = comment.file && comment.line ? ` on ${comment.file}:${comment.line}` : '';
        
        prompt += `\n${index + 1}. ${user}${location}: ${body}`;
      });

      prompt += `\n\nANALYSIS FOCUS:
- Identify what issues the human reviewers have already caught and addressed
- Find additional code quality/security issues they may have missed on COMMENTABLE lines only
- Assess the thoroughness and quality of the human review process
- Only include issues in detailedFindings that were NOT caught by human reviewers
- Use EXACT line numbers from the structured data for commentable lines`;
    } else {
      prompt += `\n\nNO EXISTING REVIEWS:
This PR has not been reviewed by humans yet. Focus on:
- Finding potential code quality and security issues on commentable lines
- Setting reviewAssessment to "REVIEW REQUIRED"
- Including all significant issues found in detailedFindings with exact line numbers`;
    }

    prompt += `\n\nCRITICAL REMINDERS FOR LINE NUMBERS:
- ONLY analyze lines where commentable: true and type: "added" 
- Use the EXACT newLineNumber provided in the structured data
- Use the EXACT filename from file_changes array
- Do NOT guess or calculate line numbers
- If you can't find a commentable line for an issue, skip that issue
- Respond with ONLY the JSON object, no other text`;

    return prompt;
  }
};

module.exports = {
  prompts,
  buildPrompt: prompts.buildPrompt,
  getCodeReviewPrompt: prompts.getCodeReviewPrompt,
};

