// Test script to verify technical debt calculations
const aiService = require('./src/services/ai.service');

// Test data with individual technical debt values
const testAnalysis = {
  automatedAnalysis: {
    totalIssues: 3,
    technicalDebtMinutes: 0, // This should be adjusted to match individual findings
    severityBreakdown: {
      blocker: 0,
      critical: 1,
      major: 1,
      minor: 1,
      info: 0
    },
    categories: {
      bugs: 1,
      vulnerabilities: 1,
      securityHotspots: 0,
      codeSmells: 1
    }
  },
  detailedFindings: [
    {
      file: "src/auth.js",
      line: 15,
      issue: "Hardcoded password found",
      severity: "CRITICAL",
      category: "VULNERABILITY",
      suggestion: "Move password to environment variable",
      technicalDebtMinutes: 15
    },
    {
      file: "src/utils.js",
      line: 42,
      issue: "Complex function with high cyclomatic complexity",
      severity: "MAJOR",
      category: "CODE_SMELL",
      suggestion: "Refactor into smaller functions",
      technicalDebtMinutes: 10
    },
    {
      file: "src/validation.js",
      line: 8,
      issue: "Missing input validation",
      severity: "MINOR",
      category: "BUG",
      suggestion: "Add proper input validation",
      technicalDebtMinutes: 5
    }
  ],
  reviewAssessment: "REVIEW_REQUIRED"
};

console.log('Testing technical debt calculation...');
console.log('Individual technical debt values:', testAnalysis.detailedFindings.map(f => f.technicalDebtMinutes));
console.log('Total individual technical debt:', testAnalysis.detailedFindings.reduce((sum, f) => sum + f.technicalDebtMinutes, 0));
console.log('Original total technical debt:', testAnalysis.automatedAnalysis.technicalDebtMinutes);

// Process the analysis
aiService.normalizeAnalysis(testAnalysis);

console.log('\nAfter normalization:');
console.log('Total technical debt:', testAnalysis.automatedAnalysis.technicalDebtMinutes);
console.log('Individual technical debt sum:', testAnalysis.detailedFindings.reduce((sum, f) => sum + f.technicalDebtMinutes, 0));
console.log('Match:', testAnalysis.automatedAnalysis.technicalDebtMinutes === testAnalysis.detailedFindings.reduce((sum, f) => sum + f.technicalDebtMinutes, 0));

console.log('\nTest completed successfully!');
