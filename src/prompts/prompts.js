// src/prompts/prompts.js - Fixed for Better JSON Responses

const prompts = {
  // Main code review prompt for single structured comment - FIXED for better JSON
  codeReviewPrompt: `You are an expert code reviewer specializing in SonarQube standards and best practices. 
Your task is to analyze pull request changes and provide comprehensive code review feedback.

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

3. Provide assessment and recommendations

CRITICAL RESPONSE REQUIREMENTS:
- Respond with ONLY valid JSON
- No markdown formatting or code blocks
- No additional text before or after JSON
- Response must start with { and end with }
- All strings must be properly escaped
- Numbers must be actual numbers, not strings

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
      "file": "exact-filename.js",
      "line": 42,
      "issue": "Detailed description of the specific issue found",
      "severity": "CRITICAL",
      "category": "VULNERABILITY",
      "suggestion": "Specific actionable fix recommendation"
    }
  ],
  "recommendation": "Detailed recommendation text"
}

CRITICAL: Use EXACTLY these property names in detailedFindings:
- "file" (not filename, fileName, or path)
- "line" (not lineNumber, lineNum, or row)  
- "issue" (not description, message, or title)
- "severity" (not level or priority)
- "category" (not type or kind)
- "suggestion" (not fix, recommendation, or solution)

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
- "REVIEW REQUIRED": No human review yet or insufficient review

IMPORTANT ANALYSIS RULES:
- Focus ONLY on issues that human reviewers MISSED, not issues they already caught
- Only include issues in detailedFindings that were NOT addressed by human reviewers  
- Assess the quality and thoroughness of the human review
- Use exact property names as specified above
- Provide specific line numbers and file paths
- Make suggestions actionable and specific
- Return ONLY the JSON response, no additional text

EXAMPLE detailedFindings entry:
{
  "file": "src/auth/login.js",
  "line": 23,
  "issue": "Hard-coded password found in authentication logic",
  "severity": "CRITICAL", 
  "category": "VULNERABILITY",
  "suggestion": "Move password to environment variable and use secure storage"
}`,

  // Helper function to build dynamic prompts
  buildPrompt: (promptType, data) => {
    const basePrompt = prompts[promptType];
    
    if (!basePrompt) {
      throw new Error(`Prompt type '${promptType}' not found`);
    }

    return basePrompt + `\n\nDATA TO ANALYZE:\n${JSON.stringify(data, null, 2)}`;
  },

  // Function to get the main review prompt with context - FIXED
  getCodeReviewPrompt: (prData, existingComments = []) => {
    let prompt = prompts.codeReviewPrompt;
    
    // Safely extract data with better error handling
    const pr = prData.pr || prData || {};
    const files = prData.files || [];
    const diff = prData.diff || '';
    const comments = existingComments || [];
    
    // Build reviewers list safely
    const reviewers = comments.length > 0 ? 
      Array.from(new Set(comments.map(c => c.user).filter(u => u && u !== 'unknown'))) : 
      [];

    prompt += `\n\nPULL REQUEST CONTEXT:
- PR ID: ${pr.number || 0}
- Title: ${(pr.title || 'No title').replace(/"/g, '\\"')}
- Description: ${(pr.description || 'No description').replace(/"/g, '\\"')}
- Author: ${pr.author || 'unknown'}
- Repository: ${pr.repository || 'owner/repo'}
- Target Branch: ${pr.targetBranch || 'main'}
- Source Branch: ${pr.sourceBranch || 'feature'}
- Files Changed: ${files.length}
- Lines Added: ${pr.additions || 0}
- Lines Deleted: ${pr.deletions || 0}
- Reviewers: ${reviewers.length > 0 ? reviewers.join(', ') : 'None yet'}

CODE CHANGES TO ANALYZE:
${diff || 'No diff available'}`;

    if (comments && comments.length > 0) {
      prompt += `\n\nEXISTING REVIEW COMMENTS:`;
      comments.forEach((comment, index) => {
        const user = comment.user || 'Unknown';
        const body = (comment.body || 'No content').replace(/"/g, '\\"');
        const location = comment.path ? ` on ${comment.path}:${comment.line}` : '';
        
        prompt += `\n${index + 1}. ${user}${location}: ${body}`;
      });

      prompt += `\n\nANALYSIS FOCUS:
- Identify what issues the human reviewers have already caught and addressed
- Find additional code quality/security issues they may have missed
- Assess the thoroughness and quality of the human review process
- Only include issues in detailedFindings that were NOT caught by human reviewers`;
    } else {
      prompt += `\n\nNO EXISTING REVIEWS:
This PR has not been reviewed by humans yet. Focus on:
- Finding potential code quality and security issues
- Setting reviewAssessment to "REVIEW REQUIRED"
- Including all significant issues found in detailedFindings`;
    }

    prompt += `\n\nIMPORTANT REMINDERS:
- Respond with ONLY the JSON object, no other text
- Use exact field names as specified in the structure
- Ensure all numbers are numeric values, not strings
- Use only the specified reviewAssessment values
- Include specific file paths and line numbers in detailedFindings`;

    return prompt;
  }
};

module.exports = {
  prompts,
  buildPrompt: prompts.buildPrompt,
  getCodeReviewPrompt: prompts.getCodeReviewPrompt,
};

