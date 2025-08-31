const prompts = {
  // Main code review prompt for single structured comment
  codeReviewPrompt: `You are an expert code reviewer specializing in SonarQube standards and best practices. 
Your task is to analyze pull request changes and provide comprehensive code review feedback in a specific format.

ANALYSIS REQUIREMENTS:
1. Apply SonarQube code quality standards including:
   - Bugs (reliability issues)
   - Vulnerabilities (security issues)  
   - Security Hotspots (security review points)
   - Code Smells (maintainability issues)
   - Coverage and Duplication issues
   - Technical Debt assessment (in minutes)

2. Analyze human reviewer coverage:
   - What issues were caught by human reviewers
   - What issues were missed
   - Quality of the human review process

3. Provide assessment and recommendations

RESPONSE FORMAT:
Provide your analysis in this exact JSON structure:
{
  "prInfo": {
    "prId": "number",
    "title": "string",
    "repository": "owner/repo", 
    "author": "string",
    "reviewers": ["list of reviewer names"],
    "url": "string"
  },
  "automatedAnalysis": {
    "totalIssues": number,
    "severityBreakdown": {
      "blocker": number,
      "critical": number, 
      "major": number,
      "minor": number,
      "info": number
    },
    "categories": {
      "bugs": number,
      "vulnerabilities": number,
      "securityHotspots": number,
      "codeSmells": number
    },
    "technicalDebtMinutes": number
  },
  "humanReviewAnalysis": {
    "reviewComments": number,
    "issuesAddressedByReviewers": number,
    "securityIssuesCaught": number,
    "codeQualityIssuesCaught": number
  },
  "reviewAssessment": "PROPERLY REVIEWED | NOT PROPERLY REVIEWED | REVIEW REQUIRED",
  "detailedFindings": [
    {
      "file": "filename",
      "line": number,
      "issue": "description of issue missed by reviewers",
      "severity": "BLOCKER|CRITICAL|MAJOR|MINOR|INFO",
      "category": "BUG|VULNERABILITY|SECURITY_HOTSPOT|CODE_SMELL",
      "suggestion": "specific fix recommendation"
    }
  ],
  "recommendation": "Specific recommendation for improving review process"
}

IMPORTANT: 
- Focus on issues that human reviewers MISSED, not issues they already caught
- Assess the quality and thoroughness of the human review
- Provide specific recommendations for review process improvement
- Return ONLY the JSON response, no additional text or markdown formatting.`,

  // Helper function to build dynamic prompts
  buildPrompt: (promptType, data) => {
    const basePrompt = prompts[promptType];
    
    if (!basePrompt) {
      throw new Error(`Prompt type '${promptType}' not found`);
    }

    return basePrompt + `\n\nDATA TO ANALYZE:\n${JSON.stringify(data, null, 2)}`;
  },

  // Function to get the main review prompt with context
  getCodeReviewPrompt: (prData, existingComments = []) => {
    let prompt = prompts.codeReviewPrompt;
    
    // Safely access prData properties with fallbacks
    const pr = prData.pr || prData || {};
    const files = prData.files || [];
    const diff = prData.diff || '';
    const comments = existingComments || [];
    
    prompt += `\n\nPULL REQUEST CONTEXT:
- PR ID: ${pr.number || 'unknown'}
- Title: ${pr.title || 'No title'}
- Description: ${pr.description || 'No description'}
- Author: ${pr.author || 'unknown'}
- Repository: ${pr.repository || 'owner/repo'}
- Target Branch: ${pr.targetBranch || 'unknown'}
- Source Branch: ${pr.sourceBranch || 'unknown'}
- Files Changed: ${files.length || 0}
- Lines Added: ${pr.additions || 0}
- Lines Deleted: ${pr.deletions || 0}

REVIEWERS:
${comments.length > 0 ? 
  Array.from(new Set(comments.map(c => c.user).filter(u => u))).join(', ') : 
  'No reviewers yet'}

CODE CHANGES:
${diff || 'No diff available'}`;

    if (comments && comments.length > 0) {
      prompt += `\n\nEXISTING REVIEW COMMENTS:
${comments.map((comment, index) => 
  `${index + 1}. **${comment.user || 'Unknown'}** (${comment.type || 'comment'}${comment.path ? ` - ${comment.path}:${comment.line}` : ''}): ${comment.body || 'No content'}`
).join('\n\n')}

ANALYSIS FOCUS:
- Identify what issues the human reviewers have already caught
- Find additional issues they may have missed
- Assess the thoroughness and quality of the human review
- Provide specific recommendations for improving the review process`;
    } else {
      prompt += `\n\nNO EXISTING REVIEWS:
This PR has not been reviewed by humans yet. Focus on:
- Finding all potential issues in the code
- Assessing whether this PR requires human review
- Providing guidance on what reviewers should focus on`;
    }

    return prompt;
  }
};

module.exports = {
  prompts,
  buildPrompt: prompts.buildPrompt,
  getCodeReviewPrompt: prompts.getCodeReviewPrompt,
};