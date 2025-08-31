const prompts = {
  // Main code review prompt
  codeReviewPrompt: `You are an expert code reviewer specializing in SonarQube standards and best practices. 
Your task is to analyze pull request changes and provide comprehensive code review feedback.

ANALYSIS REQUIREMENTS:
1. Apply SonarQube code quality standards including:
   - Code Smells (maintainability issues)
   - Bugs (reliability issues)  
   - Security Vulnerabilities
   - Coverage and Duplication issues
   - Technical Debt assessment

2. Focus on these key areas:
   - Code complexity and maintainability
   - Security vulnerabilities and best practices
   - Performance optimization opportunities
   - Error handling and exception management
   - Code documentation and readability
   - Design patterns and architecture
   - Memory leaks and resource management

3. Severity levels: CRITICAL, HIGH, MEDIUM, LOW, INFO

RESPONSE FORMAT:
Provide your analysis in this exact JSON structure:
{
  "summary": {
    "totalIssues": number,
    "criticalIssues": number,
    "highIssues": number,
    "mediumIssues": number,
    "lowIssues": number,
    "overallRating": "EXCELLENT|GOOD|NEEDS_IMPROVEMENT|POOR",
    "recommendApproval": boolean
  },
  "issues": [
    {
      "file": "filename.ext",
      "line": number,
      "type": "BUG|VULNERABILITY|CODE_SMELL|COVERAGE|DUPLICATION",
      "severity": "CRITICAL|HIGH|MEDIUM|LOW|INFO",
      "title": "Brief issue title",
      "description": "Detailed description of the issue",
      "suggestion": "Specific fix or improvement suggestion",
      "sonarRule": "SonarQube rule reference if applicable"
    }
  ],
  "reviewerCoverage": {
    "issuesFoundByReviewer": number,
    "issuesMissedByReviewer": number,
    "additionalIssuesFound": number,
    "reviewQuality": "THOROUGH|ADEQUATE|INSUFFICIENT"
  },
  "recommendations": [
    "List of general recommendations for code improvement"
  ]
}

IMPORTANT: Return ONLY the JSON response, no additional text or markdown formatting.`,

  // Prompt for analyzing existing review comments
  reviewCommentAnalysisPrompt: `Analyze the existing review comments to understand what issues have already been identified by human reviewers.

Extract and categorize the following from review comments:
1. Issues already identified by reviewers
2. Suggestions provided by reviewers  
3. Areas of concern mentioned
4. Approval/rejection reasons

Your task is to:
- Identify what the human reviewer has already caught
- Find additional issues they may have missed
- Validate if their concerns are justified
- Provide complementary analysis

Focus on gaps in the human review rather than repeating identified issues.`,

  // Prompt for specific code patterns
  securityAnalysisPrompt: `Perform a focused security analysis on the provided code changes.

Look for common security vulnerabilities:
- SQL Injection possibilities
- XSS vulnerabilities
- Authentication/Authorization flaws
- Input validation issues
- Sensitive data exposure
- Insecure cryptographic practices
- Path traversal vulnerabilities
- CORS misconfigurations
- Hardcoded secrets or credentials

Rate each finding with OWASP severity levels and provide specific remediation steps.`,

  // Performance analysis prompt
  performanceAnalysisPrompt: `Analyze the code changes for performance implications.

Focus areas:
- Algorithmic complexity (Big O analysis)
- Database query optimization
- Memory usage and potential leaks
- I/O operations efficiency
- Caching opportunities
- Resource cleanup
- Async/await usage patterns
- Loop optimizations

Provide specific performance improvement suggestions with estimated impact.`,

  // Code structure and maintainability
  maintainabilityPrompt: `Evaluate code maintainability and structure using SonarQube maintainability metrics.

Assessment criteria:
- Cyclomatic complexity
- Cognitive complexity  
- Method/function length
- Class size and responsibility
- Code duplication
- Naming conventions
- Comments and documentation
- SOLID principles adherence
- Design patterns usage

Provide refactoring suggestions to improve maintainability scores.`
};

// Helper function to build dynamic prompts
const buildPrompt = (promptType, data) => {
  const basePrompt = prompts[promptType];
  
  if (!basePrompt) {
    throw new Error(`Prompt type '${promptType}' not found`);
  }

  return basePrompt + `\n\nDATA TO ANALYZE:\n${JSON.stringify(data, null, 2)}`;
};

// Function to get the main review prompt with context
const getCodeReviewPrompt = (prData, existingComments = []) => {
  let prompt = prompts.codeReviewPrompt;
  
  prompt += `\n\nPULL REQUEST CONTEXT:
- Title: ${prData.title}
- Description: ${prData.description}
- Author: ${prData.author}
- Target Branch: ${prData.targetBranch}
- Source Branch: ${prData.sourceBranch}
- Files Changed: ${prData.filesChanged}

CODE CHANGES:
${prData.diff}`;

  if (existingComments && existingComments.length > 0) {
    prompt += `\n\nEXISTING REVIEW COMMENTS:
${existingComments.map(comment => `- ${comment.body} (by ${comment.user})`).join('\n')}

Please analyze what issues the reviewers have already identified and focus on finding additional issues they may have missed.`;
  }

  return prompt;
};

module.exports = {
  prompts,
  buildPrompt,
  getCodeReviewPrompt,
};