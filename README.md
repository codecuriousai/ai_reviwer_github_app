# GitHub AI Code Reviewer

An intelligent GitHub App that automatically reviews pull requests using AI models (OpenAI GPT-4 or Google Gemini) and applies SonarQube standards for code quality assessment.

## Features

🤖 **AI-Powered Reviews**: Automated code analysis using GPT-4 or Gemini
📊 **SonarQube Standards**: Applies industry-standard code quality rules
🔍 **Comprehensive Analysis**: Detects bugs, vulnerabilities, code smells, and more
💬 **Smart Comments**: Posts detailed review comments with suggestions
🚨 **Severity Levels**: Categorizes issues by CRITICAL, HIGH, MEDIUM, LOW, INFO
👥 **Reviewer Coverage**: Analyzes what human reviewers missed
⚡ **Real-time Processing**: Triggers on PR events automatically

## Quick Start

### 1. Prerequisites
- Node.js 16+
- GitHub account with admin access to repositories
- OpenAI API key or Google Gemini API key

### 2. Installation
```bash
git clone https://github.com/your-username/github-ai-reviewer.git
cd github-ai-reviewer
npm install
```

### 3. Configuration
```bash
cp .env.example .env
# Edit .env with your configuration
```

### 4. GitHub App Setup
1. Create a new GitHub App at [GitHub Developer Settings](https://github.com/settings/apps)
2. Set webhook URL to `https://your-domain.com/webhook`
3. Configure permissions: Contents (Read), Issues (Write), Pull requests (Write)
4. Subscribe to events: Pull request, Pull request review, Pull request review comment
5. Generate and download private key
6. Install the app on your repositories

### 5. Run the Application
```bash
# Development
npm run dev

# Production
npm start
```

## Configuration

### Environment Variables

```bash
# GitHub App Configuration
GITHUB_APP_ID=123456                    # Your GitHub App ID
GITHUB_PRIVATE_KEY_PATH=./private-key.pem # Path to private key file
GITHUB_WEBHOOK_SECRET=your_secret        # Webhook secret from GitHub App
GITHUB_INSTALLATION_ID=12345678          # Installation ID

# AI Configuration
AI_PROVIDER=openai                       # 'openai' or 'gemini'
OPENAI_API_KEY=sk-your-key              # OpenAI API key
GEMINI_API_KEY=your-key                 # Google Gemini API key

# Server Configuration
PORT=3000                               # Server port
NODE_ENV=development                    # Environment
```

### Customizing Review Rules

Edit `src/config/config.js` to customize:

```javascript
review: {
  targetBranches: ['main', 'master', 'develop'], // Branches to monitor
  excludeFiles: ['*.md', '*.txt', '*.json'],     // Files to ignore
  maxFilesToAnalyze: 20,                         // Max files per PR
  maxFileSizeBytes: 100000,                      # Max file size (100KB)
}
```

## API Documentation

### Webhook Events

The app responds to these GitHub webhook events:

#### Pull Request Events
- `opened`: New PR created
- `reopened`: PR reopened 
- `synchronize`: New commits pushed

#### Review Events  
- `pull_request_review.submitted`: Review submitted
- `pull_request_review_comment.created`: Review comment added

### Endpoints

- `GET /health` - Health check
- `POST /webhook` - GitHub webhook receiver

## AI Analysis Output

The AI provides structured analysis in this format:

```json
{
  "summary": {
    "totalIssues": 5,
    "criticalIssues": 1,
    "highIssues": 2,
    "mediumIssues": 2,
    "lowIssues": 0,
    "overallRating": "NEEDS_IMPROVEMENT",
    "recommendApproval": false
  },
  "issues": [
    {
      "file": "src/example.js",
      "line": 42,
      "type": "VULNERABILITY",
      "severity": "CRITICAL", 
      "title": "SQL Injection Risk",
      "description": "Direct string concatenation in SQL query",
      "suggestion": "Use parameterized queries or ORM",
      "sonarRule": "javascript:S2077"
    }
  ],
  "reviewerCoverage": {
    "issuesFoundByReviewer": 2,
    "issuesMissedByReviewer": 3,
    "additionalIssuesFound": 3,
    "reviewQuality": "ADEQUATE"
  },
  "recommendations": [
    "Add input validation for user data",
    "Implement proper error handling"
  ]
}
```

## Code Quality Standards

The AI applies SonarQube standards including:

### Bug Detection
- Null pointer exceptions
- Resource leaks
- Logic errors
- Exception handling issues

### Security Vulnerabilities
- SQL injection risks
- XSS vulnerabilities  
- Authentication flaws
- Input validation issues
- Hardcoded credentials

### Code Smells
- Duplicated code
- Long methods/classes
- Complex conditional logic
- Poor naming conventions
- Unused code

### Coverage & Performance
- Missing test coverage areas
- Performance bottlenecks
- Memory leak risks
- Inefficient algorithms

## Deployment

### Local Development with ngrok

```bash
# Start the app
npm run dev

# In another terminal, expose with ngrok
ngrok http 3000

# Update GitHub App webhook URL with ngrok URL
```

### Production Deployment

#### Docker
```bash
docker build -t github-ai-reviewer .
docker run -p 3000:3000 --env-file .env github-ai-reviewer
```

#### PM2 (Linux/VPS)
```bash
npm install -g pm2
pm2 start src/index.js --name "ai-reviewer"
pm2 startup
pm2 save
```

#### Cloud Platforms
- **Heroku**: Deploy using Git push
- **AWS**: Use Elastic Beanstalk or ECS
- **GCP**: Use Cloud Run or App Engine
- **DigitalOcean**: Use App Platform

## Usage Examples

### Example PR Review Comment

```markdown
## 🤖 AI Code Review Summary

**Overall Rating:** NEEDS_IMPROVEMENT
**Recommendation:** ❌ Request Changes

### 📊 Issues Found
- **Total Issues:** 8
- **Critical:** 2
- **High:** 3
- **Medium:** 2
- **Low:** 1

### 👥 Review Coverage Analysis
- **Issues found by reviewer:** 3
- **Issues missed by reviewer:** 5
- **Additional issues found:** 5
- **Review quality:** ADEQUATE

### 🚨 Critical Issues
- **src/auth.js:23** - SQL Injection Vulnerability
- **src/api.js:45** - Hardcoded API Secret

### 💡 Recommendations
- Implement input validation for all user inputs
- Use environment variables for sensitive configuration
- Add comprehensive error handling
- Increase test coverage for edge cases

---
*Powered by AI Code Reviewer with SonarQube Standards*
```

### Example Inline Comment

```markdown
🚨 🔒 **SQL Injection Vulnerability**

Direct string concatenation in SQL query creates injection risk.

**Suggestion:** Use parameterized queries or prepared statements to prevent SQL injection attacks.

**SonarQube Rule:** javascript:S2077
```

## Troubleshooting

### Common Issues

1. **Webhook not receiving events**
   - Check webhook URL is publicly accessible
   - Verify webhook secret matches
   - Ensure GitHub App has correct permissions

2. **AI API errors**
   - Verify API keys are valid and have quota
   - Check network connectivity  
   - Monitor rate limits

3. **Large PR timeouts**
   - Adjust `maxFilesToAnalyze` in config
   - Increase `maxFileSizeBytes` limit
   - Implement chunked processing

### Debug Mode

Set `NODE_ENV=development` for detailed logging:

```bash
# View all logs
tail -f logs/combined.log

# View only errors
tail -f logs/error.log
```

## Contributing

1. Fork the repository
2. Create a feature branch
3. Make your changes
4. Add tests if applicable
5. Submit a pull request

## License

MIT License - see [LICENSE](LICENSE) file for details.

## Support

- 📧 Email: support@your-domain.com  
- 🐛 Issues: [GitHub Issues](https://github.com/your-username/github-ai-reviewer/issues)
- 📖 Docs: [Wiki](https://github.com/your-username/github-ai-reviewer/wiki)

## Roadmap

- [ ] Integration with additional code quality tools
- [ ] Support for more programming languages
- [ ] Custom rule configuration UI
- [ ] Performance metrics dashboard
- [ ] Integration with CI/CD pipelines
- [ ] Multi-repository batch analysis