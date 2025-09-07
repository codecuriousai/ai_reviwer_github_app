// src/prompts/prompts.js - FIXED: Proper handling of structured data to prevent unknown-file errors

const prompts = {
  // Updated main code review prompt with strict data validation
  codeReviewPrompt: `You are an expert code reviewer specializing in SonarQube standards and best practices. 
Your task is to analyze pull request changes using structured file data and provide comprehensive code review feedback.

CRITICAL: You will receive structured file data. You MUST use this data exactly as provided.

IMPORTANT DATA STRUCTURE:
The data you receive contains:
- file_changes: array of file objects
- Each file object has:
  - filename: exact file path (USE THIS EXACTLY)
  - status: 'added', 'modified', or 'deleted'  
  - lines: array of line objects
  - Each line object has: newLineNumber, oldLineNumber, content, type, commentable

MANDATORY RULES FOR FINDINGS:
1. ONLY report findings on lines where: commentable === true
2. Use the EXACT filename from the file_changes array
3. Use the EXACT newLineNumber from the lines array
4. NEVER use placeholder names like "unknown-file-0", "file1", etc.
5. NEVER make up line numbers
6. If no commentable lines exist, report 0 findings

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

RESPONSE REQUIREMENTS:
- Respond with ONLY valid JSON
- No markdown formatting or code blocks
- No additional text before or after JSON
- Response must start with { and end with }
- All strings must be properly escaped
- Numbers must be actual numbers, not strings

REQUIRED JSON STRUCTURE:
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
      "file": "EXACT_FILENAME_FROM_STRUCTURED_DATA",
      "line": EXACT_LINE_NUMBER_FROM_STRUCTURED_DATA,
      "issue": "Detailed description of the specific issue found",
      "severity": "CRITICAL",
      "category": "VULNERABILITY",
      "suggestion": "Specific actionable fix recommendation"
    }
  ],
  "recommendation": "Detailed recommendation text"
}

VALIDATION CHECKLIST BEFORE RESPONDING:
For each finding in detailedFindings, verify:
1. The "file" value exactly matches a filename from the provided file_changes array
2. The "line" value exactly matches a newLineNumber from a line where commentable: true
3. The line type is "added" (you can only comment on added lines)

If any finding fails these checks, REMOVE it from detailedFindings.

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

REVIEW ASSESSMENT OPTIONS:
- "PROPERLY REVIEWED": Human reviewers caught most/all significant issues
- "NOT PROPERLY REVIEWED": Critical issues missed by human reviewers
- "REVIEW REQUIRED": No human review yet or insufficient review`,

  // Updated getCodeReviewPrompt with explicit data mapping
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

STRUCTURED FILE CHANGES DATA FOR ANALYSIS:`;

    // Provide explicit mapping of valid files and line numbers
    if (fileChanges.length === 0) {
      prompt += `\n\nNO FILE CHANGES PROVIDED - Report 0 findings.`;
    } else {
      fileChanges.forEach((file, index) => {
        prompt += `\n\nFile ${index + 1} Data:
- Filename: "${file.filename}" (USE EXACTLY THIS)
- Status: ${file.status}
- Total Lines: ${file.lines ? file.lines.length : 0}`;

        if (file.lines && file.lines.length > 0) {
          const commentableLines = file.lines.filter(l => l.commentable && l.type === 'added');
          
          if (commentableLines.length > 0) {
            prompt += `\n- Commentable Line Numbers: [${commentableLines.map(l => l.newLineNumber).join(', ')}]`;
            prompt += `\n- Commentable Lines Content:`;
            
            commentableLines.forEach(line => {
              prompt += `\n  Line ${line.newLineNumber}: ${line.content}`;
            });
            
            prompt += `\n\nFOR THIS FILE, ONLY USE:`;
            prompt += `\n- File: "${file.filename}"`;
            prompt += `\n- Line numbers: ${commentableLines.map(l => l.newLineNumber).join(', ')}`;
          } else {
            prompt += `\n- No commentable lines (cannot report findings for this file)`;
          }
        } else {
          prompt += `\n- No lines data (cannot report findings for this file)`;
        }
      });
    }

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

    prompt += `\n\nFINAL VALIDATION INSTRUCTIONS:
1. Before adding any finding to detailedFindings, verify:
   - The filename exists in the file data above
   - The line number is listed as commentable above
   - You have the exact strings and numbers from the data
2. If you cannot find valid file/line combinations, report 0 findings
3. NEVER use "unknown-file-0" or any placeholder names
4. NEVER guess or calculate line numbers
5. Use only the exact data provided above
6. Respond with ONLY valid JSON, no other text

REMEMBER: It's better to report 0 findings than to use invalid file/line references.`;

    return prompt;
  }
};

module.exports = {
  prompts,
  buildPrompt: prompts.buildPrompt,
  getCodeReviewPrompt: prompts.getCodeReviewPrompt,
};