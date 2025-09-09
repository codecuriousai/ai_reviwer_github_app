# GitHub AI Code Reviewer - Frequently Asked Questions (FAQ)

## 📋 Table of Contents
- [General Questions](#general-questions) (Q1-Q3)
- [Functionality & Flow Questions](#functionality--flow-questions) (Q4-Q8)
- [Technical Implementation Questions](#technical-implementation-questions) (Q9-Q12)
- [Configuration & Setup Questions](#configuration--setup-questions) (Q13-Q15)
- [Troubleshooting Questions](#troubleshooting-questions) (Q16-Q18)
- [Development & Customization Questions](#development--customization-questions) (Q19-Q24)
- [Performance & Monitoring Questions](#performance--monitoring-questions) (Q25-Q26)
- [Security Questions](#security-questions) (Q27-Q28)
- [Future Development Questions](#future-development-questions) (Q29-Q30)
- [Support & Resources](#support--resources) (Q31-Q32)
- [General Flow & Architecture](#general-flow--architecture) (Q33-Q35)
- [AI Review Process](#ai-review-process) (Q36-Q39)
- [User Interface & Buttons](#user-interface--buttons) (Q40-Q42)
- [Data Processing & Formatting](#data-processing--formatting) (Q43-Q45)
- [GitHub Integration](#github-integration) (Q46-Q48)
- [Interactive Features](#interactive-features) (Q49-Q51)
- [Configuration & Setup](#configuration--setup) (Q52-Q54)
- [Error Handling & Debugging](#error-handling--debugging) (Q55-Q57)
- [Performance & Optimization](#performance--optimization) (Q58-Q60)
- [Security & Authentication](#security--authentication) (Q61-Q63)
- [Deployment & Maintenance](#deployment--maintenance) (Q64-Q67)
- [Common Workflows](#common-workflows) (Q68-Q69)

---

## 🤔 General Questions

### Q1: What is the GitHub AI Code Reviewer?
**A:** The GitHub AI Code Reviewer is an intelligent GitHub App that automatically reviews pull requests using AI models (OpenAI GPT-4 or Google Gemini) and applies SonarQube standards for comprehensive code quality assessment. It provides interactive buttons for posting AI findings directly to code and can automatically commit fixes.

### Q2: What are the main features of this application?
**A:** The key features include:
- 🤖 **AI-Powered Reviews**: Automated code analysis using GPT-4 or Gemini
- 📊 **SonarQube Standards**: Applies industry-standard code quality rules
- 🔍 **Comprehensive Analysis**: Detects bugs, vulnerabilities, code smells, and more
- 💬 **Smart Comments**: Posts detailed review comments with suggestions
- 🚨 **Severity Levels**: Categorizes issues by CRITICAL, HIGH, MEDIUM, LOW, INFO
- 👥 **Reviewer Coverage**: Analyzes what human reviewers missed
- ⚡ **Real-time Processing**: Triggers on PR events automatically
- 🔧 **Automatic Fix Suggestions**: Generates and can commit code fixes
- 📈 **Merge Readiness Assessment**: Determines if PRs are ready to merge

### Q3: Which AI providers are supported?
**A:** The application supports two AI providers:
- **OpenAI GPT-4**: Primary AI model for code analysis
- **Google Gemini**: Alternative AI model for code analysis

You can configure which provider to use via the `AI_PROVIDER` environment variable.

---

## 🔄 Functionality & Flow Questions

### Q4: How does the AI review button UI get generated and displayed?
**A:** The AI review button UI is generated through a multi-step process:

1. **Initial Button Creation**: 
   - **Function**: `createInitialAIReviewButton()` in `src/services/webhook.service.js`
   - **Trigger**: When a pull request is opened, reopened, or synchronized
   - **Process**: Creates a GitHub check run with "Start AI Review" button

2. **Interactive Button Generation**:
   - **Function**: `createInteractiveCheckRun()` in `src/services/check-run-button.service.js`
   - **Trigger**: After AI analysis is completed
   - **Process**: Creates buttons for "Post All Comments", "Commit Fixes", and "Check Merge Ready"

3. **Button Action Handling**:
   - **Function**: `handleButtonAction()` in `src/services/check-run-button.service.js`
   - **Process**: Handles user clicks and triggers appropriate actions

4. **UI Components**:
   - **Dashboard**: `public/check-run-button-dashboard.html` provides a web interface for testing
   - **Check Run Actions**: Generated dynamically based on analysis results
   - **Button States**: Managed through `buttonStates` object in check run data

### Q5: In which function is PR data analyzed?
**A:** PR data analysis happens in multiple functions working together:

1. **Main Analysis Function**:
   - **Function**: `analyzePullRequest()` in `src/services/ai.service.js`
   - **Purpose**: Main entry point for AI analysis
   - **Input**: PR data and existing comments
   - **Output**: Complete analysis with issues and recommendations

2. **Data Preparation**:
   - **Function**: `prepareAnalysisData()` in `src/services/ai.service.js`
   - **Purpose**: Organizes and formats PR data for AI processing
   - **Process**: Structures file changes, line numbers, and context

3. **AI Processing**:
   - **Functions**: `analyzeWithOpenAI()` or `analyzeWithGemini()` in `src/services/ai.service.js`
   - **Purpose**: Sends formatted data to AI models
   - **Process**: Uses prompts from `src/prompts/prompts.js`

4. **Response Parsing**:
   - **Function**: `parseAnalysisResponse()` in `src/services/ai.service.js`
   - **Purpose**: Converts AI response to structured format
   - **Process**: Validates and normalizes JSON response

### Q6: In which function is data formatted to proper JSON format?
**A:** Data formatting to JSON happens in several key functions:

1. **AI Response Parsing**:
   - **Function**: `parseAnalysisResponse()` in `src/services/ai.service.js`
   - **Purpose**: Converts AI's raw response to structured JSON
   - **Process**: 
     - Removes markdown formatting
     - Finds JSON boundaries
     - Validates structure
     - Normalizes data

2. **JSON Cleaning**:
   - **Function**: `cleanJSONResponse()` in `src/utils/helpers.js`
   - **Purpose**: Cleans and fixes common JSON issues
   - **Process**:
     - Removes code blocks
     - Fixes trailing commas
     - Handles string concatenation

3. **Data Validation**:
   - **Function**: `validateAndNormalizeAnalysis()` in `src/services/ai.service.js`
   - **Purpose**: Ensures JSON structure meets requirements
   - **Process**: Validates required fields and data types

4. **Prompt Generation**:
   - **Function**: `getCodeReviewPrompt()` in `src/prompts/prompts.js`
   - **Purpose**: Creates structured prompts for AI
   - **Process**: Formats PR data into AI-readable JSON structure

### Q7: What is the complete flow from PR creation to AI review completion?
**A:** The complete flow is:

1. **PR Event Trigger**:
   - GitHub sends webhook to `/webhook` endpoint
   - `handleWebhook()` in `src/services/webhook.service.js` processes event

2. **Initial Button Creation**:
   - `createInitialAIReviewButton()` creates "Start AI Review" button
   - User clicks button to trigger analysis

3. **AI Analysis Process**:
   - `triggerAIReviewWithButtons()` starts analysis
   - `processAIReviewWithButtons()` fetches PR data
   - `analyzePullRequest()` performs AI analysis
   - `parseAnalysisResponse()` formats results

4. **Interactive Button Creation**:
   - `createInteractiveCheckRun()` creates action buttons
   - Buttons for posting comments, committing fixes, checking merge readiness

5. **User Interaction**:
   - `handleButtonAction()` processes user clicks
   - Actions: post comments, commit fixes, check merge readiness

### Q8: How does the application handle different types of code issues?
**A:** The application categorizes issues using SonarQube standards:

1. **Issue Categories**:
   - **BUGS**: Logic errors, potential crashes, null pointer exceptions
   - **VULNERABILITIES**: SQL injection, XSS, CSRF, authentication bypass
   - **SECURITY_HOTSPOTS**: Hardcoded secrets, unsafe deserialization
   - **CODE_SMELLS**: Duplicated code, long methods, complex conditionals

2. **Severity Levels**:
   - **BLOCKER**: Critical issues that must be fixed (15-30 min technical debt)
   - **CRITICAL**: High impact issues (10-20 min technical debt)
   - **MAJOR**: Important issues (5-15 min technical debt)
   - **MINOR**: Small improvements (2-8 min technical debt)
   - **INFO**: Informational suggestions (1-5 min technical debt)

3. **Analysis Framework**:
   - SonarQube code quality standards
   - OWASP security guidelines
   - Industry best practices
   - Language-specific patterns
   - Performance considerations

---

## 🔧 Technical Implementation Questions

### Q9: How does the webhook system work?
**A:** The webhook system processes GitHub events:

1. **Webhook Endpoint**: `POST /webhook` in `src/index.js`
2. **Event Handler**: `handleWebhook()` in `src/services/webhook.service.js`
3. **Event Types**:
   - `pull_request`: PR creation, updates, synchronization
   - `check_run`: Button clicks and status updates
   - `issue_comment`: Manual AI review triggers
   - `ping`: GitHub App connectivity verification

4. **Security**: Webhook signature verification using HMAC-SHA256

### Q10: How does the GitHub API integration work?
**A:** GitHub API integration is handled by `src/services/github.service.js`:

1. **Authentication**: Uses GitHub App private key for JWT tokens
2. **Key Functions**:
   - `getPullRequestData()`: Fetches PR information
   - `createCheckRun()`: Creates interactive buttons
   - `postReviewComments()`: Posts inline comments
   - `commitFixesToPRBranch()`: Applies AI fixes

3. **API Endpoints Used**:
   - `/repos/{owner}/{repo}/pulls` - Pull request data
   - `/repos/{owner}/{repo}/check-runs` - Check run management
   - `/repos/{owner}/{repo}/pulls/{pull_number}/comments` - Review comments

### Q11: How does the AI service process code analysis?
**A:** The AI service (`src/services/ai.service.js`) processes analysis:

1. **Data Preparation**: `prepareAnalysisData()` structures PR data
2. **Prompt Generation**: Uses templates from `src/prompts/prompts.js`
3. **AI Processing**: Calls OpenAI or Gemini APIs
4. **Response Parsing**: `parseAnalysisResponse()` converts to JSON
5. **Context Enhancement**: Adds additional analysis context

### Q12: How are interactive buttons managed?
**A:** Interactive buttons are managed by `src/services/check-run-button.service.js`:

1. **Button Creation**: `createInteractiveCheckRun()` generates buttons
2. **Action Handling**: `handleButtonAction()` processes clicks
3. **State Management**: Tracks button states and user interactions
4. **Button Types**:
   - "Post All Comments" - Posts AI findings as inline comments
   - "Commit Fixes" - Applies AI-suggested fixes
   - "Check Merge Ready" - Assesses merge readiness

---

## ⚙️ Configuration & Setup Questions

### Q13: What environment variables are required?
**A:** Required environment variables:

```bash
# GitHub App Configuration
GITHUB_APP_ID=123456
GITHUB_PRIVATE_KEY_BASE64=your_base64_encoded_private_key
GITHUB_WEBHOOK_SECRET=your_webhook_secret
GITHUB_INSTALLATION_ID=12345678

# AI Configuration
AI_PROVIDER=openai  # or 'gemini'
OPENAI_API_KEY=sk-your-openai-key
# OR
GEMINI_API_KEY=your-gemini-key

# Server Configuration
PORT=3000
NODE_ENV=production
LOG_LEVEL=info
ENABLE_FILE_LOGGING=true
```

### Q14: How do I set up the GitHub App?
**A:** GitHub App setup process:

1. **Create GitHub App**:
   - Go to [GitHub Developer Settings](https://github.com/settings/apps)
   - Set webhook URL: `https://your-domain.com/webhook`
   - Configure permissions: Contents (Read), Issues (Write), Pull requests (Write)
   - Subscribe to events: `pull_request`, `check_run`, `issue_comment`

2. **Install App**: Install on your repositories and note Installation ID

3. **Generate Private Key**: Download and encode as base64

### Q15: How can I customize the review rules?
**A:** Review rules can be customized in `src/config/config.js`:

```javascript
review: {
  targetBranches: ['main', 'master', 'develop'], // Branches to monitor
  excludeFiles: ['*.md', '*.txt', '*.json'],     // Files to ignore
  maxFilesToAnalyze: 20,                         // Max files per PR
  maxFileSizeBytes: 100000,                      // Max file size (100KB)
  maxConcurrentReviews: 3                        // Concurrent review limit
}
```

---

## 🐛 Troubleshooting Questions

### Q16: Why is the webhook not receiving events?
**A:** Common causes and solutions:

1. **Webhook URL Issues**:
   - Ensure URL is publicly accessible
   - Check HTTPS is enabled
   - Verify webhook secret matches

2. **GitHub App Permissions**:
   - Verify correct permissions are set
   - Check event subscriptions
   - Ensure app is installed on repository

3. **Network Issues**:
   - Check firewall settings
   - Verify DNS resolution
   - Test webhook endpoint manually

### Q17: Why is AI analysis failing?
**A:** Common AI analysis issues:

1. **API Key Issues**:
   - Verify API keys are valid
   - Check API quota and limits
   - Ensure correct provider is configured

2. **Network Connectivity**:
   - Test connection to AI services
   - Check rate limiting
   - Verify timeout settings

3. **Response Parsing**:
   - Check AI response format
   - Verify JSON structure
   - Review error logs

### Q18: Why are interactive buttons not working?
**A:** Button issues troubleshooting:

1. **Permissions**:
   - Verify GitHub App has check run permissions
   - Check repository access
   - Ensure proper installation

2. **Button State**:
   - Check button state management
   - Verify action handling
   - Review error logs

3. **Webhook Events**:
   - Ensure check_run events are subscribed
   - Verify webhook processing
   - Check event payload structure

---

## 🛠️ Development & Customization Questions

### Q19: How can I add new AI providers?
**A:** To add new AI providers:

1. **Add Provider Logic**: Extend `src/services/ai.service.js`
2. **Update Configuration**: Add provider options in `src/config/config.js`
3. **Add Provider Method**: Implement `analyzeWithNewProvider()` method
4. **Update Initialization**: Add provider to `initializeProviders()`

### Q20: How can I customize the AI prompts?
**A:** Prompts can be customized in `src/prompts/`:

1. **Basic Prompts**: `src/prompts/prompts.js`
2. **Enhanced Prompts**: `src/prompts/enhanced-prompts.js`
3. **Single Comment Prompts**: `src/prompts/prompts-one.js`

### Q21: How can I add new button actions?
**A:** To add new button actions:

1. **Update Button Generation**: Modify `generateCheckRunActions()` in `src/services/check-run-button.service.js`
2. **Add Action Handler**: Implement new action in `handleButtonAction()`
3. **Update Button States**: Add new state to `buttonStates` object

### Q22: How can I extend the analysis categories?
**A:** To extend analysis categories:

1. **Update Prompts**: Modify prompt templates in `src/prompts/`
2. **Add Category Logic**: Update analysis processing in `src/services/ai.service.js`
3. **Update Validation**: Add new categories to `validateAndNormalizeAnalysis()`

### Q23: How can I add custom file type support?
**A:** To add custom file types:

1. **Update File Filtering**: Modify file filtering logic in `src/services/ai.service.js`
2. **Add Language Support**: Update prompts for new language patterns
3. **Configure Exclusions**: Add file patterns to `excludeFiles` in config

### Q24: How can I implement custom deployment strategies?
**A:** Deployment options:

1. **Docker**: Use provided Dockerfile
2. **PM2**: Use ecosystem.config.js for process management
3. **Cloud Platforms**: Deploy to Heroku, AWS, GCP, DigitalOcean
4. **Custom Server**: Deploy to any Node.js hosting environment

---

## 📊 Performance & Monitoring Questions

### Q25: How can I monitor application performance?
**A:** Monitoring options:

1. **Health Endpoints**:
   - `GET /health` - System health check
   - `GET /status` - Application status

2. **Logging**:
   - Console logging for development
   - File logging for production
   - Structured JSON logs

3. **Metrics**:
   - Response times
   - Memory usage
   - AI analysis duration
   - Error rates

### Q26: How can I optimize performance?
**A:** Performance optimization strategies:

1. **Concurrent Reviews**: Limit with `maxConcurrentReviews`
2. **File Limits**: Set `maxFilesToAnalyze` and `maxFileSizeBytes`
3. **Caching**: Implement response caching
4. **Scaling**: Use PM2 cluster mode or horizontal scaling

---

## 🔒 Security Questions

### Q27: How is the application secured?
**A:** Security measures:

1. **Webhook Security**: HMAC-SHA256 signature verification
2. **Rate Limiting**: Prevents abuse with configurable limits
3. **Security Headers**: XSS protection, content type sniffing prevention
4. **Private Key Security**: Encrypted storage and secure transmission
5. **Input Validation**: All inputs sanitized before processing

### Q28: How are API keys protected?
**A:** API key protection:

1. **Environment Variables**: Keys stored in environment variables
2. **No Hardcoding**: Keys never committed to code
3. **Secure Transmission**: HTTPS for all communications
4. **Access Control**: Limited access to production environment

---

## 📈 Future Development Questions

### Q29: What features are planned for future releases?
**A:** Planned features (from roadmap):

1. **Additional Code Quality Tools**: Integration with more analysis tools
2. **More Languages**: Support for additional programming languages
3. **Custom Rule Configuration UI**: Web interface for rule management
4. **Performance Metrics Dashboard**: Real-time performance monitoring
5. **CI/CD Integration**: Integration with continuous integration pipelines
6. **Multi-repository Batch Analysis**: Analyze multiple repositories at once

### Q30: How can I contribute to the project?
**A:** Contribution guidelines:

1. **Fork Repository**: Create your own fork
2. **Create Feature Branch**: Work on new features
3. **Add Tests**: Include tests for new functionality
4. **Submit Pull Request**: Follow contribution guidelines
5. **Code Review**: Participate in code review process

---

## 📞 Support & Resources

### Q31: Where can I get help?
**A:** Support resources:

1. **Documentation**: This FAQ and other documentation files
2. **GitHub Issues**: Report bugs and request features
3. **Code Comments**: Inline code documentation
4. **Logs**: Comprehensive logging for debugging

### Q32: How can I report bugs?
**A:** Bug reporting process:

1. **Check Logs**: Review application logs first
2. **Reproduce Issue**: Create minimal reproduction case
3. **GitHub Issues**: Submit detailed bug report
4. **Include Information**: Logs, configuration, steps to reproduce

---

# GitHub AI Code Reviewer - Comprehensive FAQ

## 📋 Table of Contents
- [General Flow & Architecture](#general-flow--architecture)
- [AI Review Process](#ai-review-process)
- [User Interface & Buttons](#user-interface--buttons)
- [Data Processing & Formatting](#data-processing--formatting)
- [GitHub Integration](#github-integration)
- [Interactive Features](#interactive-features)
- [Configuration & Setup](#configuration--setup)
- [Error Handling & Debugging](#error-handling--debugging)
- [Performance & Optimization](#performance--optimization)
- [Security & Authentication](#security--authentication)
- [Deployment & Maintenance](#deployment--maintenance)

---

## 🏗️ General Flow & Architecture

### Q33: What happens when a pull request is created?
**A:** When a PR is created, the following flow occurs:

1. **GitHub sends webhook** → `index.js` POST `/webhook` endpoint
2. **Event routing** → `webhookService.handleWebhook(event, payload)`
3. **PR event processing** → `webhookService.handlePullRequestEvent(payload)`
4. **Button creation** → `webhookService.createInitialAIReviewButton(repository, pullRequest)`
5. **Check run creation** → `githubService.createCheckRun(owner, repo, checkRunData)`

**Function Reference**: Start with `handlePullRequestEvent()` in `webhook.service.js`

### Q34: How does the overall system architecture work?
**A:** The system follows a service-oriented architecture:

```
GitHub Webhooks → Webhook Service → GitHub Service ↔ AI Service
                      ↓                    ↓
                Button Service ← Check Run Management
```

**Key Services**:
- **WebhookService**: Routes GitHub events
- **AIService**: Handles AI analysis 
- **GitHubService**: Manages GitHub API interactions
- **CheckRunButtonService**: Manages interactive buttons

### Q35: What triggers an AI review?
**A:** AI reviews can be triggered by:

1. **User clicks "Start AI Review" button** → `webhookService.handleCheckRunEvent()` → `handleInitialReviewRequest()`
2. **Manual comment trigger** → `webhookService.handleIssueCommentEvent()`
3. **PR synchronization** (if configured) → `handlePullRequestEvent()`

**Main Function**: `triggerAIReviewWithButtons()` in `webhook.service.js`

---

## 🤖 AI Review Process

### Q36: In which function is PR data analyzed by AI?
**A:** PR analysis happens in the **AI Service**:

**Main Function**: `aiService.analyzePullRequest(prData, existingComments)`

**Complete Flow**:
1. `prepareAnalysisData(prData, existingComments)` - Formats data for AI
2. `analyzeWithOpenAI(prompt)` OR `analyzeWithGemini(prompt)` - Sends to AI
3. `parseAnalysisResponse(rawResponse)` - Converts AI response to structured data
4. `enhanceAnalysisWithContext(parsedAnalysis, prData, existingComments)` - Adds context

### Q37: How does the AI analysis work internally?
**A:** The AI analysis process:

1. **Data Preparation** (`prepareAnalysisData()`):
   - Extracts file contents and changes
   - Formats existing comments
   - Creates analysis context

2. **AI Processing** (`analyzeWithOpenAI()` or `analyzeWithGemini()`):
   - Uses prompts from `enhanced-prompts.js`
   - Applies SonarQube standards
   - Generates structured analysis

3. **Response Processing** (`parseAnalysisResponse()`):
   - Parses JSON response
   - Validates data structure
   - Handles malformed responses

**Function File**: `src/services/ai.service.js`

### Q38: What AI models are supported and how to switch between them?
**A:** Supported models:
- **OpenAI GPT-4** (default)
- **Google Gemini**

**Configuration**: Set `AI_PROVIDER=openai` or `AI_PROVIDER=gemini` in environment variables

**Initialization Function**: `initializeProviders()` in `ai.service.js`

### Q39: How are code fixes generated?
**A:** Fix generation process:

**Function**: `aiService.generateCodeFixSuggestion(finding, fileContent, prData)`

**Process**:
1. Builds fix-specific prompt with context
2. Sends to AI with current code and issue details
3. Generates specific code replacement suggestions
4. Formats as structured fix data

**Called By**: `checkRunButtonService.formatInlineCommentWithFix()`

---

## 🖥️ User Interface & Buttons

### Q40: In which function is the AI review button UI generated?
**A:** The AI review buttons are generated in multiple functions:

**Initial Button Creation**:
- `webhookService.createInitialAIReviewButton()` - Creates "Start AI Review" button
- `webhookService.createCheckMergeReadyButton()` - Creates "Check Merge Ready" button

**Interactive Buttons with Actions**:
- `checkRunButtonService.createInteractiveCheckRun()` - Creates buttons with actions
- `checkRunButtonService.generateCheckRunActions()` - Generates button configurations

**Button Types Created**:
- "Post All Comments" - Posts AI findings as inline comments
- "Commit Fixes" - Applies AI-suggested fixes
- "Check Merge Ready" - Assesses merge readiness

### Q41: How do interactive buttons work?
**A:** Interactive button flow:

1. **User clicks button** → GitHub sends check_run event
2. **Event handling** → `webhookService.handleCheckRunEvent(payload)`
3. **Action routing** → `checkRunButtonService.handleButtonAction(payload)`
4. **Specific action execution**:
   - `postAllFindings()` - For comment posting
   - `commitFixesToPRBranch()` - For fix commits
   - `checkMergeReadiness()` - For merge assessment

**Button State Management**: Buttons track their state (ready/processing/completed) in the check run data

### Q42: How are button states managed?
**A:** Button states are managed through:

**Storage**: `checkRunButtonService` maintains active check runs in memory
**States**: 'ready', 'processing', 'completed', 'error'
**Updates**: `updateCheckRunCompleted()` and `updateCheckRunInProgress()` functions

**State Flow**:
```
ready → processing → completed
  ↓         ↓           ↓
error ← error ←  completed
```

---

## 📊 Data Processing & Formatting

### Q43: In which function is data formatted to proper JSON format?
**A:** Data formatting happens in several key functions:

**AI Response Formatting**:
- `aiService.parseAnalysisResponse(rawResponse)` - Converts AI text to JSON
- `aiService.enhanceAnalysisWithContext()` - Adds structured context

**PR Data Formatting**:
- `aiService.prepareAnalysisData(prData, existingComments)` - Formats for AI analysis
- `githubService.getPullRequestData()` - Structures GitHub API data

**Comment Formatting**:
- `checkRunButtonService.formatInlineCommentWithFix()` - Formats comments with fixes
- `githubService.postStructuredReviewComment()` - Formats review comments

### Q44: How is GitHub API data processed?
**A:** GitHub data processing flow:

**Main Function**: `githubService.getPullRequestData(owner, repo, pullNumber)`

**Process**:
1. Fetches PR metadata, files, and existing comments
2. Processes file diffs and changes
3. Structures data for internal use
4. Validates line numbers for commenting

**Data Structure Created**:
```javascript
{
  pr: { number, title, author, url },
  files: [{ filename, status, additions, deletions }],
  comments: [],
  reviewers: []
}
```

### Q45: How are AI findings structured?
**A:** AI findings are structured by `parseAnalysisResponse()`:

**Structure**:
```javascript
{
  trackingId: "unique-id",
  automatedAnalysis: {
    totalIssues: number,
    severityBreakdown: { critical, major, minor },
    categories: { bugs, vulnerabilities, codeSmells }
  },
  detailedFindings: [{
    file: "path/to/file",
    line: lineNumber,
    issue: "description",
    severity: "CRITICAL|MAJOR|MINOR",
    suggestion: "fix suggestion"
  }]
}
```

---

## 🔗 GitHub Integration

### Q46: How does the app authenticate with GitHub?
**A:** Authentication process:

**Setup Function**: `githubService.constructor()` - Initializes GitHub App client
**Key Loading**: `getPrivateKey()` - Loads and validates private key
**Authentication Test**: `testAuthentication()` - Verifies connection

**Components**:
- GitHub App ID
- Private Key (Base64 encoded)
- Installation ID
- Webhook Secret

### Q47: How are inline comments posted to GitHub?
**A:** Comment posting flow:

**Main Function**: `githubService.postReviewComments(owner, repo, pullNumber, headSha, comments)`

**Process**:
1. **Line Validation** → `validateCommentableLine()` - Checks if line can be commented
2. **Line Finding** → `findCommentableLine()` - Finds nearest commentable line
3. **Comment Formatting** → `formatInlineCommentWithFix()` - Formats with fixes
4. **Batch Posting** → Posts all comments in single API call

**Called By**: `checkRunButtonService.postAllFindings()`

### Q48: How does automatic fix committing work?
**A:** Automatic fix process:

**Main Function**: `githubService.commitFixesToPRBranch(owner, repo, pullNumber, fixes, commitMessage)`

**Process**:
1. Gets current branch reference
2. Fetches file contents to modify
3. Applies fixes to file contents
4. Creates new commit with changes
5. Updates branch reference

**Safety Measures**:
- Validates fixes before applying
- Creates descriptive commit messages
- Handles merge conflicts

---

## 🎯 Interactive Features

### Q49: How does "Post All Comments" work?
**A:** Comment posting process:

**Function**: `checkRunButtonService.postAllFindings()`

**Detailed Flow**:
1. **Filter postable findings** - Only findings with valid file/line references
2. **Validate each line** - `githubService.validateCommentableLine()`
3. **Find alternate lines** - `githubService.findCommentableLine()` if needed
4. **Format comments** - `formatInlineCommentWithFix()` with fix suggestions
5. **Post in batches** - `githubService.postReviewComments()`
6. **Update button state** - Mark as completed

### Q50: How does merge readiness assessment work?
**A:** Merge assessment process:

**Function**: `aiService.assessMergeReadiness(prData, aiFindings, reviewComments, currentStatus)`

**Assessment Criteria**:
1. **Critical Issues** - No critical severity issues
2. **Review Status** - All review threads resolved
3. **Test Status** - All checks passing
4. **AI Confidence** - AI assessment of code quality

**Data Sources**:
- AI findings from analysis
- GitHub review threads via GraphQL
- PR status checks
- Comment resolution status

### Q51: How are review threads analyzed?
**A:** Review thread analysis:

**Functions**:
- `getReviewThreadsViaGraphQL()` - Fetches detailed thread data
- `analyzeGraphQLReviewThreads()` - Analyzes resolution status

**Process**:
1. Uses GitHub GraphQL API for detailed thread data
2. Checks conversation resolution status
3. Identifies unresolved discussions
4. Considers reviewer approvals/rejections

---

## ⚙️ Configuration & Setup

### Q52: What environment variables are required?
**A:** Required environment variables:

**GitHub Configuration**:
```bash
GITHUB_APP_ID=123456
GITHUB_PRIVATE_KEY_BASE64=base64_encoded_key
GITHUB_WEBHOOK_SECRET=webhook_secret
GITHUB_INSTALLATION_ID=installation_id
```

**AI Configuration**:
```bash
AI_PROVIDER=openai  # or 'gemini'
OPENAI_API_KEY=sk-key  # if using OpenAI
GEMINI_API_KEY=key     # if using Gemini
```

**Configuration Loading**: `config.js` handles all environment setup

### Q53: How are file exclusions handled?
**A:** File exclusions are configured in `config.js`:

**Default Exclusions**:
- `*.md`, `*.txt`, `*.json` - Documentation files
- `*.lock`, `package-lock.json` - Lock files
- `.gitignore`, `.env*` - Configuration files
- `node_modules/`, `dist/`, `build/` - Generated directories

**Function**: File filtering happens in `prepareAnalysisData()`

### Q54: How to customize AI prompts?
**A:** AI prompts are managed in `src/prompts/`:

**Files**:
- `enhanced-prompts.js` - Main analysis prompts
- `prompts-one.js` - Single finding prompts
- `prompts.js` - Basic prompts

**Customization**: Modify prompt templates to adjust AI behavior and analysis focus

---

## 🐛 Error Handling & Debugging

### Q55: How are errors handled during AI analysis?
**A:** Error handling strategy:

**Retry Logic**: `retryWithBackoff()` in `helpers.js` - Implements exponential backoff
**Error Catching**: Each service function has try-catch blocks
**Fallback Responses**: AI service provides fallback analysis on failures
**Logging**: Comprehensive error logging with tracking IDs

**Function**: `processAIReviewWithButtons()` has main error handling

### Q56: How to debug webhook issues?
**A:** Debugging tools and functions:

**Logging**: `requestLogger()` in `auth.middleware.js` logs all requests
**Validation**: `validateWebhookPayload()` checks incoming data
**Health Checks**: `/health` endpoint tests all service connections
**Debug Endpoints**: `/debug/test-check-run-buttons` for testing

**Debug Functions**:
```javascript
// Test endpoints
POST /debug/test-check-run-buttons
POST /debug/ai-test
GET /health
GET /status
```

### Q57: What happens when AI services are down?
**A:** Fallback mechanisms:

**Health Monitoring**: `aiService.checkHealth()` monitors AI service status
**Graceful Degradation**: Returns basic analysis when AI unavailable
**User Notification**: Updates check run status with error information
**Retry Strategy**: Automatic retries with backoff for transient failures

---

## ⚡ Performance & Optimization

### Q58: How are large pull requests handled?
**A:** Large PR optimization:

**Limits in `config.js`**:
- `maxFilesToAnalyze: 25` - Maximum files per analysis
- `maxFileSizeBytes: 120000` - Maximum file size
- `maxConcurrentReviews: 3` - Concurrent analysis limit

**Optimization Functions**:
- File filtering in `prepareAnalysisData()`
- Chunk processing for large files
- Streaming for file content reading

### Q59: How is rate limiting handled?
**A:** Rate limiting strategy:

**GitHub API**: Built-in rate limiting with retry logic
**AI Services**: `delay()` function implements request spacing
**Webhook Processing**: Queue management prevents overload
**User Requests**: `rateLimitMiddleware()` limits user actions

**Function**: `delay()` and `retryWithBackoff()` in `helpers.js`

### Q60: How is memory usage optimized?
**A:** Memory optimization:

**Data Cleanup**: Old check run data is periodically cleaned
**Streaming**: Large files processed in chunks
**Limited Concurrency**: `maxConcurrentReviews` prevents memory spikes
**Garbage Collection**: Proper cleanup after analysis completion

---

## 🔐 Security & Authentication

### Q61: How are webhook signatures verified?
**A:** Signature verification process:

**Middleware**: `validateWebhookHeaders()` in `auth.middleware.js`
**Process**:
1. Extracts signature from headers
2. Computes HMAC-SHA256 with webhook secret
3. Compares signatures using timing-safe comparison
4. Rejects invalid signatures

**Security Headers**: `securityHeaders()` middleware adds protection headers

### Q62: How is sensitive data protected?
**A:** Data protection measures:

**Environment Variables**: All secrets stored as environment variables
**Private Key Security**: Base64 encoding and secure storage
**Input Sanitization**: `sanitizeForAI()` cleans data before AI processing
**Error Handling**: No sensitive data exposed in error messages

**Function**: `sanitizeForAI()` in `helpers.js`

### Q63: How is rate limiting implemented?
**A:** Rate limiting implementation:

**Middleware**: `rateLimitMiddleware()` in `auth.middleware.js`
**Strategy**: Token bucket algorithm with configurable limits
**Scope**: Per-IP rate limiting for abuse prevention
**Headers**: Returns rate limit status in response headers

---

## 🚀 Deployment & Maintenance

### Q64: How to deploy to production?
**A:** Deployment process:

**Environment Setup**:
1. Configure environment variables
2. Set up GitHub App with proper permissions
3. Configure webhook URL and secrets

**Deployment Steps**:
```bash
npm install
npm start  # or use PM2 for production
```

**Health Monitoring**: Use `/health` endpoint for monitoring

### Q65: How to monitor application health?
**A:** Monitoring strategy:

**Health Endpoints**:
- `/health` - Overall system health
- `/status` - Processing queue status
- Service-specific health checks

**Logging**: Comprehensive logging with Winston logger
**Metrics**: Memory usage, response times, error rates
**Alerts**: Set up monitoring on health endpoints

### Q66: How to handle updates and maintenance?
**A:** Maintenance procedures:

**Regular Tasks**:
- Monitor logs for errors
- Check AI service quotas
- Update dependencies
- Clean old check run data

**Update Process**:
1. Test in staging environment
2. Deploy during low traffic
3. Monitor health endpoints
4. Rollback if issues detected

### Q67: How to troubleshoot common issues?
**A:** Common troubleshooting:

**Webhook Issues**:
- Check webhook URL accessibility
- Verify signature validation
- Check GitHub App permissions

**AI Issues**:
- Verify API keys and quotas
- Check AI service status
- Review error logs

**Button Issues**:
- Check check run permissions
- Verify event subscriptions
- Review button action handling

**Debug Commands**:
```bash
# Check logs
tail -f logs/combined.log

# Test webhook
curl -X POST /webhook -H "Content-Type: application/json" -d '{}'

# Check health
curl /health
```

---

## 🔄 Common Workflows

### Q68: What's the complete flow from PR creation to AI review completion?
**A:** Complete workflow:

```
1. PR Created
   ↓ (GitHub webhook)
2. handleWebhook() receives event
   ↓
3. createInitialAIReviewButton() creates "Start Review" button
   ↓ (User clicks button)
4. triggerAIReviewWithButtons() starts analysis
   ↓
5. analyzePullRequest() performs AI analysis
   ↓
6. createInteractiveCheckRun() creates action buttons
   ↓ (User interactions)
7. postAllFindings() / commitFixesToPRBranch() / checkMergeReadiness()
   ↓
8. Button states updated, process complete
```

### Q69: How to extend functionality with custom actions?
**A:** Extension points:

**New Button Actions**: Add to `generateCheckRunActions()` and `handleButtonAction()`
**Custom AI Prompts**: Modify prompts in `src/prompts/`
**Additional AI Providers**: Extend `aiService` with new provider support
**Custom Validations**: Add to `validateWebhookPayload()` or create new middleware

**Key Extension Files**:
- `check-run-button.service.js` - For new button actions
- `ai.service.js` - For AI functionality
- `webhook.service.js` - For new event types

---

This FAQ covers all major functionality and provides specific function references for implementation details. For any specific implementation questions, refer to the function documentation in the respective service files.

*This FAQ is maintained alongside the codebase and should be updated with any significant changes to the application functionality or architecture.*
