# GitHub AI Code Reviewer - Function Documentation

## 📋 Table of Contents
- [Overview](#overview)
- [Function Mapping & Call Relationships](#function-mapping--call-relationships)
- [File-by-File Function Documentation](#file-by-file-function-documentation)
- [Data Flow Diagrams](#data-flow-diagrams)
- [Function Input/Output Specifications](#function-inputoutput-specifications)

---

## 🎯 Overview

This document provides a comprehensive explanation of every function in the GitHub AI Code Reviewer application. Each function is explained in clear terms, showing what data it receives, what it does with that data, and what it returns.

### How to Read This Documentation
- **Function Name**: The exact name of the function in the code
- **Purpose**: What the function does
- **Input Data**: What information the function needs to work
- **Output Data**: What the function gives back
- **Called By**: Which other functions use this function
- **Calls**: Which other functions this function uses

---

## 🔄 Function Mapping & Call Relationships

### 📊 Main Application Flow Diagram

```
┌─────────────────┐    ┌──────────────────┐    ┌─────────────────┐
│   GitHub        │    │   Webhook        │    │   AI Analysis   │
│   Event         │───►│   Handler        │───►│   Engine        │
└─────────────────┘    └──────────────────┘    └─────────────────┘
                                │                        │
                                ▼                        ▼
                       ┌──────────────────┐    ┌─────────────────┐
                       │   Button         │    │   Interactive   │
                       │   Creation       │    │   Comments      │
                       └──────────────────┘    └─────────────────┘
                                │                        │
                                ▼                        ▼
                       ┌──────────────────┐    ┌─────────────────┐
                       │   User           │    │   Automatic     │
                       │   Actions        │    │   Fixes         │
                       └──────────────────┘    └─────────────────┘
```

### 🔗 Service Layer Architecture

```
┌─────────────────┐
│  WebhookService │ ◄─── GitHub Webhooks
└─────────┬───────┘
          │
          ▼
┌─────────────────┐    ┌─────────────────┐    ┌─────────────────┐
│ GitHubService   │◄──►│   AIService     │◄──►│ CheckRunButton  │
│                 │    │                 │    │    Service      │
└─────────────────┘    └─────────────────┘    └─────────────────┘
          │                       │                       │
          ▼                       ▼                       ▼
┌─────────────────┐    ┌─────────────────┐    ┌─────────────────┐
│ FixHistory      │    │ PRReviewStatus  │    │ Interactive     │
│ Service         │    │ Service         │    │ Comment Service │
└─────────────────┘    └─────────────────┘    └─────────────────┘
```

### 🎯 Function Call Flow

#### **1. Webhook Processing Flow**
```
handleWebhook()
    ├── validateWebhookPayload()
    ├── handlePullRequestEvent()
    │   ├── createInitialAIReviewButton()
    │   └── createCheckMergeReadyButton()
    ├── handleCheckRunEvent()
    │   ├── handleInitialReviewRequest()
    │   └── triggerAIReviewWithButtons()
    └── handleIssueCommentEvent()
```

#### **2. AI Analysis Flow**
```
analyzePullRequest()
    ├── prepareAnalysisData()
    ├── analyzeWithOpenAI() / analyzeWithGemini()
    ├── parseAnalysisResponse()
    └── enhanceAnalysisWithContext()
```

#### **3. Button Interaction Flow**
```
handleButtonAction()
    ├── postAllFindings()
    │   ├── validateCommentableLine()
    │   ├── findCommentableLine()
    │   ├── formatInlineCommentWithFix()
    │   └── postReviewComments()
    ├── commitFixesToPRBranch()
    │   └── commitFixesToPRBranch()
    └── checkMergeReadiness()
        └── assessMergeReadiness()
```

### 📈 Data Flow Sequence

```
1. GitHub Event → Webhook Handler
2. Event Validation → Event Router
3. PR Data Fetching → AI Analysis
4. Analysis Processing → Button Creation
5. User Interaction → Action Processing
6. Result Application → Status Update
```

---

## 📁 File-by-File Function Documentation

## 🚀 **src/index.js** - Main Application Entry Point

### `logStartup(message, isError)`
- **Purpose**: Displays startup messages with timestamps and status indicators
- **Input Data**: 
  - `message` (string): The message to display
  - `isError` (boolean): Whether this is an error message
- **Output Data**: None (displays message to console)
- **Called By**: Multiple functions during application startup
- **Calls**: None

### `app.listen(PORT, callback)`
- **Purpose**: Starts the web server and makes it listen for incoming requests
- **Input Data**: 
  - `PORT` (number): The port number to listen on (like 3000)
  - `callback` (function): What to do when server starts successfully
- **Output Data**: None (starts the server)
- **Called By**: Application startup process
- **Calls**: Various endpoint handlers when requests come in

### `app.get('/health', handler)`
- **Purpose**: Creates an endpoint that checks if the application is working properly
- **Input Data**: HTTP request object
- **Output Data**: JSON response with system health information
- **Called By**: External monitoring systems, load balancers
- **Calls**: `aiService.checkHealth()`, `githubService.healthCheck()`

### `app.post('/webhook', handler)`
- **Purpose**: Receives webhook events from GitHub when something happens (like a new pull request)
- **Input Data**: 
  - GitHub webhook payload (JSON data about what happened)
  - Webhook signature for security verification
- **Output Data**: Success or error response
- **Called By**: GitHub when events occur
- **Calls**: `webhookService.handleWebhook()`

---

## ⚙️ **src/config/config.js** - Configuration Management

### `logStartup(message, isError)`
- **Purpose**: Displays configuration-related messages during startup
- **Input Data**: 
  - `message` (string): Configuration message
  - `isError` (boolean): Whether this is an error
- **Output Data**: None (displays to console)
- **Called By**: Configuration loading functions
- **Calls**: None

### `getPrivateKey()`
- **Purpose**: Loads and validates the GitHub App's private key from different sources
- **Input Data**: None (reads from environment variables)
- **Output Data**: 
  - `privateKeyContent` (string): The decoded private key
- **Called By**: Configuration initialization
- **Calls**: `isValidBase64()`, `validatePrivateKeyFormat()`

### `isValidBase64(str)`
- **Purpose**: Checks if a string is properly encoded in base64 format
- **Input Data**: 
  - `str` (string): The string to validate
- **Output Data**: 
  - `boolean`: True if valid base64, false otherwise
- **Called By**: `getPrivateKey()`
- **Calls**: None

### `validatePrivateKeyFormat(keyContent)`
- **Purpose**: Validates that a private key has the correct format and structure
- **Input Data**: 
  - `keyContent` (string): The private key content to validate
- **Output Data**: 
  - `boolean`: True if valid format, false otherwise
- **Called By**: `getPrivateKey()`
- **Calls**: None

---

## 🤖 **src/services/ai.service.js** - AI Analysis Engine

### `constructor()`
- **Purpose**: Sets up the AI service with configuration and initializes AI providers
- **Input Data**: None (uses configuration)
- **Output Data**: None (initializes the service)
- **Called By**: When the service is first loaded
- **Calls**: `initializeProviders()`

### `initializeProviders()`
- **Purpose**: Connects to AI services (OpenAI or Google Gemini) using API keys
- **Input Data**: None (uses configuration)
- **Output Data**: None (creates AI client connections)
- **Called By**: `constructor()`
- **Calls**: None

### `analyzePullRequest(prData, existingComments)`
- **Purpose**: The main function that analyzes a pull request using AI to find code issues
- **Input Data**: 
  - `prData` (object): Information about the pull request (files, changes, etc.)
  - `existingComments` (array): Comments already made on the PR
- **Output Data**: 
  - `enhancedAnalysis` (object): Complete analysis with issues found, severity levels, and recommendations
- **Called By**: `webhookService.triggerAIReviewWithButtons()`
- **Calls**: `prepareAnalysisData()`, `analyzeWithOpenAI()`, `analyzeWithGemini()`, `parseAnalysisResponse()`, `enhanceAnalysisWithContext()`

### `prepareAnalysisData(prData, existingComments)`
- **Purpose**: Organizes and formats the pull request data for AI analysis
- **Input Data**: 
  - `prData` (object): Raw pull request data
  - `existingComments` (array): Existing comments
- **Output Data**: 
  - `analysisData` (object): Formatted data ready for AI processing
- **Called By**: `analyzePullRequest()`
- **Calls**: None

### `analyzeWithOpenAI(prompt)`
- **Purpose**: Sends the analysis request to OpenAI's GPT model
- **Input Data**: 
  - `prompt` (string): The formatted request for AI analysis
- **Output Data**: 
  - `response` (object): AI's analysis response
- **Called By**: `analyzePullRequest()`
- **Calls**: None

### `analyzeWithGemini(prompt)`
- **Purpose**: Sends the analysis request to Google's Gemini model
- **Input Data**: 
  - `prompt` (string): The formatted request for AI analysis
- **Output Data**: 
  - `response` (object): AI's analysis response
- **Called By**: `analyzePullRequest()`
- **Calls**: None

### `parseAnalysisResponse(rawResponse)`
- **Purpose**: Converts the AI's raw response into a structured format the application can use
- **Input Data**: 
  - `rawResponse` (string): The AI's raw text response
- **Output Data**: 
  - `parsedAnalysis` (object): Structured analysis data
- **Called By**: `analyzePullRequest()`
- **Calls**: `isValidJSON()`

### `enhanceAnalysisWithContext(parsedAnalysis, prData, existingComments)`
- **Purpose**: Adds additional context and information to the AI analysis
- **Input Data**: 
  - `parsedAnalysis` (object): Basic AI analysis
  - `prData` (object): PR information
  - `existingComments` (array): Existing comments
- **Output Data**: 
  - `enhancedAnalysis` (object): Complete analysis with context
- **Called By**: `analyzePullRequest()`
- **Calls**: None

### `generateCodeFixSuggestion(finding, fileContent, prData)`
- **Purpose**: Creates specific code fixes for issues found by AI analysis
- **Input Data**: 
  - `finding` (object): The specific issue found
  - `fileContent` (string): The current code content
  - `prData` (object): PR context
- **Output Data**: 
  - `fixSuggestion` (object): Suggested code changes
- **Called By**: `checkRunButtonService.formatInlineCommentWithFix()`
- **Calls**: `buildFixSuggestionPrompt()`, `analyzeWithOpenAI()`, `analyzeWithGemini()`

### `assessMergeReadiness(prData, aiFindings, reviewComments, currentStatus)`
- **Purpose**: Determines if a pull request is ready to be merged into the main codebase
- **Input Data**: 
  - `prData` (object): PR information
  - `aiFindings` (array): Issues found by AI
  - `reviewComments` (array): Human review comments
  - `currentStatus` (object): Current PR status
- **Output Data**: 
  - `mergeAssessment` (object): Analysis of whether PR is ready to merge
- **Called By**: `checkRunButtonService.handleButtonAction()`
- **Calls**: `getReviewThreadsViaGraphQL()`, `analyzeGraphQLReviewThreads()`

### `getReviewThreadsViaGraphQL(owner, repo, pullNumber)`
- **Purpose**: Gets detailed information about code review conversations using GitHub's advanced API
- **Input Data**: 
  - `owner` (string): Repository owner
  - `repo` (string): Repository name
  - `pullNumber` (number): PR number
- **Output Data**: 
  - `reviewThreads` (array): Detailed review conversation data
- **Called By**: `assessMergeReadiness()`
- **Calls**: None

### `analyzeGraphQLReviewThreads(reviewThreads)`
- **Purpose**: Analyzes review conversations to determine if all issues have been resolved
- **Input Data**: 
  - `reviewThreads` (array): Review conversation data
- **Output Data**: 
  - `resolvedStatus` (object): Analysis of conversation resolution status
- **Called By**: `assessMergeReadiness()`
- **Calls**: None

---

## 🔗 **src/services/github.service.js** - GitHub API Integration

### `constructor()`
- **Purpose**: Sets up the GitHub API connection using the app's credentials
- **Input Data**: None (uses configuration)
- **Output Data**: None (creates GitHub API client)
- **Called By**: When the service is first loaded
- **Calls**: `getPrivateKey()`

### `getPrivateKey()`
- **Purpose**: Loads the GitHub App's private key for authentication
- **Input Data**: None (reads from environment)
- **Output Data**: 
  - `privateKeyContent` (string): The private key
- **Called By**: `constructor()`
- **Calls**: `isValidBase64()`, `validatePrivateKeyFormat()`

### `isValidBase64(str)`
- **Purpose**: Checks if a string is properly base64 encoded
- **Input Data**: 
  - `str` (string): String to validate
- **Output Data**: 
  - `boolean`: True if valid base64
- **Called By**: `getPrivateKey()`
- **Calls**: None

### `validatePrivateKeyFormat(keyContent)`
- **Purpose**: Validates that a private key has the correct format
- **Input Data**: 
  - `keyContent` (string): Private key content
- **Output Data**: 
  - `boolean`: True if valid format
- **Called By**: `getPrivateKey()`
- **Calls**: None

### `testAuthentication()`
- **Purpose**: Tests if the GitHub App can successfully connect to GitHub
- **Input Data**: None
- **Output Data**: 
  - `result` (object): Success status and app information
- **Called By**: `healthCheck()`
- **Calls**: None

### `healthCheck()`
- **Purpose**: Checks the overall health of the GitHub service connection
- **Input Data**: None
- **Output Data**: 
  - `healthStatus` (object): Health status information
- **Called By**: `index.js` health endpoint
- **Calls**: `testAuthentication()`

### `getPullRequestData(owner, repo, pullNumber)`
- **Purpose**: Fetches all information about a specific pull request from GitHub
- **Input Data**: 
  - `owner` (string): Repository owner
  - `repo` (string): Repository name
  - `pullNumber` (number): PR number
- **Output Data**: 
  - `prData` (object): Complete PR information including files, comments, and metadata
- **Called By**: `webhookService.triggerAIReviewWithButtons()`, `aiService.assessMergeReadiness()`
- **Calls**: Multiple GitHub API endpoints

### `createCheckRun(owner, repo, checkRunData)`
- **Purpose**: Creates a new check run (status check) in GitHub for a pull request
- **Input Data**: 
  - `owner` (string): Repository owner
  - `repo` (string): Repository name
  - `checkRunData` (object): Check run configuration
- **Output Data**: 
  - `checkRun` (object): Created check run information
- **Called By**: `webhookService.createInitialAIReviewButton()`, `checkRunButtonService.createInteractiveCheckRun()`
- **Calls**: None

### `updateCheckRun(owner, repo, checkRunId, updateData)`
- **Purpose**: Updates an existing check run with new status or information
- **Input Data**: 
  - `owner` (string): Repository owner
  - `repo` (string): Repository name
  - `checkRunId` (number): ID of check run to update
  - `updateData` (object): New data to update
- **Output Data**: 
  - `updatedCheckRun` (object): Updated check run information
- **Called By**: Multiple functions throughout the application
- **Calls**: None

### `postReviewComments(owner, repo, pullNumber, headSha, comments)`
- **Purpose**: Posts inline comments on specific lines of code in a pull request
- **Input Data**: 
  - `owner` (string): Repository owner
  - `repo` (string): Repository name
  - `pullNumber` (number): PR number
  - `headSha` (string): Commit hash
  - `comments` (array): Comments to post
- **Output Data**: 
  - `postedComments` (array): Information about posted comments
- **Called By**: `checkRunButtonService.postAllFindings()`
- **Calls**: None

### `postGeneralComment(owner, repo, pullNumber, body)`
- **Purpose**: Posts a general comment on a pull request (not tied to specific lines)
- **Input Data**: 
  - `owner` (string): Repository owner
  - `repo` (string): Repository name
  - `pullNumber` (number): PR number
  - `body` (string): Comment content
- **Output Data**: 
  - `comment` (object): Posted comment information
- **Called By**: Multiple functions for general PR comments
- **Calls**: None

### `postStructuredReviewComment(owner, repo, pullNumber, analysis)`
- **Purpose**: Posts a structured, formatted review comment with analysis results
- **Input Data**: 
  - `owner` (string): Repository owner
  - `repo` (string): Repository name
  - `pullNumber` (number): PR number
  - `analysis` (object): AI analysis results
- **Output Data**: 
  - `comment` (object): Posted comment information
- **Called By**: `webhookService.completeWithButtonsCheckRun()`
- **Calls**: None

### `commitFixesToPRBranch(owner, repo, pullNumber, fixes, commitMessage)`
- **Purpose**: Automatically applies AI-suggested fixes to the pull request branch in a single commit
- **Input Data**: 
  - `owner` (string): Repository owner
  - `repo` (string): Repository name
  - `pullNumber` (number): PR number
  - `fixes` (array): List of fixes to apply
  - `commitMessage` (string): Message for the commit
- **Output Data**: 
  - `commitResults` (object): Results of applying fixes with detailed error information
- **Called By**: `checkRunButtonService.commitFixesToPRBranch()`
- **Calls**: `commitMultipleFiles()`, `getFileContentFromPR()`, `applyAdvancedFixToContent()`
- **Key Features**:
  - **Single Commit**: All fixes across multiple files are committed together
  - **Batch Processing**: Collects all file changes before committing
  - **Error Handling**: Detailed error reporting with file and line information
  - **Fallback Mechanism**: Alternative commit approach if batch commit fails

### `commitMultipleFiles(owner, repo, fileChanges, commitMessage, pullNumber)`
- **Purpose**: Creates a single commit with multiple file changes using GitHub's Git API
- **Input Data**: 
  - `owner` (string): Repository owner
  - `repo` (string): Repository name
  - `fileChanges` (Map): Map of file paths to file data with content and fixes
  - `commitMessage` (string): Commit message
  - `pullNumber` (number): PR number
- **Output Data**: 
  - `commitResult` (object): Commit information with SHA, URL, and statistics
- **Called By**: `commitFixesToPRBranch()`
- **Calls**: `createBlob()`, `createTree()`, `createCommit()`, `updateRef()`
- **Key Features**:
  - **Blob Creation**: Creates blobs for all file contents first
  - **Tree Creation**: Creates tree object with blob references
  - **Single Commit**: Uses tree SHA to create single commit
  - **Detailed Messages**: Includes summary of all applied fixes

### `validateCommentableLine(owner, repo, pullNumber, filePath, lineNumber)`
- **Purpose**: Checks if a specific line in a file can receive inline comments
- **Input Data**: 
  - `owner` (string): Repository owner
  - `repo` (string): Repository name
  - `pullNumber` (number): PR number
  - `filePath` (string): Path to the file
  - `lineNumber` (number): Line number to check
- **Output Data**: 
  - `boolean`: True if line can be commented on
- **Called By**: `checkRunButtonService.postAllFindings()`
- **Calls**: None

### `findCommentableLine(owner, repo, pullNumber, filePath, targetLine)`
- **Purpose**: Finds the nearest line that can receive comments if the target line cannot
- **Input Data**: 
  - `owner` (string): Repository owner
  - `repo` (string): Repository name
  - `pullNumber` (number): PR number
  - `filePath` (string): Path to the file
  - `targetLine` (number): Original target line
- **Output Data**: 
  - `commentableLine` (number): Nearest commentable line number
- **Called By**: `checkRunButtonService.postAllFindings()`
- **Calls**: None

---

## 🎣 **src/services/webhook.service.js** - Webhook Event Handler

### `constructor()`
- **Purpose**: Sets up the webhook service with processing queues and limits
- **Input Data**: None
- **Output Data**: None (initializes service)
- **Called By**: When the service is first loaded
- **Calls**: None

### `handleWebhook(event, payload)`
- **Purpose**: The main function that receives and routes webhook events from GitHub
- **Input Data**: 
  - `event` (string): Type of event (pull_request, check_run, etc.)
  - `payload` (object): Event data from GitHub
- **Output Data**: None (processes the event)
- **Called By**: `index.js` webhook endpoint
- **Calls**: `validateWebhookPayload()`, `handlePullRequestEvent()`, `handleCheckRunEvent()`, `handleIssueCommentEvent()`

### `validateWebhookPayload(payload, event)`
- **Purpose**: Checks if the webhook data is valid and complete
- **Input Data**: 
  - `payload` (object): Webhook data
  - `event` (string): Event type
- **Output Data**: 
  - `boolean`: True if valid
- **Called By**: `handleWebhook()`
- **Calls**: None

### `handlePullRequestEvent(payload)`
- **Purpose**: Processes pull request events (opened, updated, etc.)
- **Input Data**: 
  - `payload` (object): PR event data
- **Output Data**: None (creates buttons or processes PR)
- **Called By**: `handleWebhook()`
- **Calls**: `createInitialAIReviewButton()`, `createCheckMergeReadyButton()`

### `createInitialAIReviewButton(repository, pullRequest)`
- **Purpose**: Creates the initial "Start AI Review" button when a PR is opened
- **Input Data**: 
  - `repository` (object): Repository information
  - `pullRequest` (object): PR information
- **Output Data**: None (creates check run)
- **Called By**: `handlePullRequestEvent()`
- **Calls**: `githubService.createCheckRun()`

### `createCheckMergeReadyButton(repository, pullRequest)`
- **Purpose**: Creates a "Check Merge Ready" button for PRs that already have completed reviews
- **Input Data**: 
  - `repository` (object): Repository information
  - `pullRequest` (object): PR information
- **Output Data**: None (creates check run)
- **Called By**: `handlePullRequestEvent()`
- **Calls**: `githubService.createCheckRun()`

### `handleCheckRunEvent(payload)`
- **Purpose**: Processes when users click buttons in check runs
- **Input Data**: 
  - `payload` (object): Check run event data
- **Output Data**: None (processes button click)
- **Called By**: `handleWebhook()`
- **Calls**: `handleInitialReviewRequest()`, `checkRunButtonService.handleButtonAction()`

### `handleInitialReviewRequest(payload)`
- **Purpose**: Handles when someone clicks "Start AI Review" button
- **Input Data**: 
  - `payload` (object): Check run event data
- **Output Data**: None (starts AI analysis)
- **Called By**: `handleCheckRunEvent()`
- **Calls**: `findPRByCommitSha()`, `triggerAIReviewWithButtons()`

### `triggerAIReviewWithButtons(repository, pullRequest, initialCheckRun)`
- **Purpose**: Starts the AI analysis process and creates interactive buttons
- **Input Data**: 
  - `repository` (object): Repository information
  - `pullRequest` (object): PR information
  - `initialCheckRun` (object): Initial check run data
- **Output Data**: None (processes analysis)
- **Called By**: `handleInitialReviewRequest()`
- **Calls**: `processAIReviewWithButtons()`

### `processAIReviewWithButtons(repository, pullRequest, initialCheckRun, trackingId)`
- **Purpose**: Performs the actual AI analysis and creates interactive buttons
- **Input Data**: 
  - `repository` (object): Repository information
  - `pullRequest` (object): PR information
  - `initialCheckRun` (object): Check run data
  - `trackingId` (string): Unique tracking ID
- **Output Data**: None (completes analysis)
- **Called By**: `triggerAIReviewWithButtons()`
- **Calls**: `githubService.getPullRequestData()`, `aiService.analyzePullRequest()`, `completeWithButtonsCheckRun()`

### `completeWithButtonsCheckRun(owner, repo, pullNumber, initialCheckRun, analysis, headSha)`
- **Purpose**: Completes the AI analysis and creates interactive buttons for user actions
- **Input Data**: 
  - `owner` (string): Repository owner
  - `repo` (string): Repository name
  - `pullNumber` (number): PR number
  - `initialCheckRun` (object): Initial check run
  - `analysis` (object): AI analysis results
  - `headSha` (string): Commit hash
- **Output Data**: None (creates interactive check run)
- **Called By**: `processAIReviewWithButtons()`
- **Calls**: `githubService.postStructuredReviewComment()`, `checkRunButtonService.createInteractiveCheckRun()`

---

## 🔘 **src/services/check-run-button.service.js** - Interactive Button System

### `constructor()`
- **Purpose**: Sets up the button service with storage for active check runs
- **Input Data**: None
- **Output Data**: None (initializes service)
- **Called By**: When the service is first loaded
- **Calls**: None

### `createInteractiveCheckRun(owner, repo, pullNumber, analysis, headSha)`
- **Purpose**: Creates a check run with interactive buttons for posting comments and committing fixes
- **Input Data**: 
  - `owner` (string): Repository owner
  - `repo` (string): Repository name
  - `pullNumber` (number): PR number
  - `analysis` (object): AI analysis results
  - `headSha` (string): Commit hash
- **Output Data**: 
  - `checkRun` (object): Created check run with buttons
- **Called By**: `webhookService.completeWithButtonsCheckRun()`
- **Calls**: `getPostableFindings()`, `generateCheckRunActions()`, `githubService.createCheckRun()`

### `handleButtonAction(payload)`
- **Purpose**: Processes when users click any of the interactive buttons
- **Input Data**: 
  - `payload` (object): Button click event data
- **Output Data**: 
  - `boolean`: True if action was handled
- **Called By**: `webhookService.handleCheckRunEvent()`
- **Calls**: `postAllFindings()`, `commitFixesToPRBranch()`, `checkMergeReadiness()`

### `postAllFindings(owner, repo, pullNumber, headSha, postableFindings, checkRunData)`
- **Purpose**: Posts all AI findings as inline comments on the code
- **Input Data**: 
  - `owner` (string): Repository owner
  - `repo` (string): Repository name
  - `pullNumber` (number): PR number
  - `headSha` (string): Commit hash
  - `postableFindings` (array): Findings to post
  - `checkRunData` (object): Check run data
- **Output Data**: 
  - `results` (object): Results of posting comments
- **Called By**: `handleButtonAction()`
- **Calls**: `githubService.validateCommentableLine()`, `githubService.findCommentableLine()`, `formatInlineCommentWithFix()`, `githubService.postReviewComments()`

### `commitFixesToPRBranch(owner, repo, pullNumber, postableFindings, checkRunData)`
- **Purpose**: Automatically applies all AI-suggested fixes to the pull request branch
- **Input Data**: 
  - `owner` (string): Repository owner
  - `repo` (string): Repository name
  - `pullNumber` (number): PR number
  - `postableFindings` (array): Findings to fix
  - `checkRunData` (object): Check run data
- **Output Data**: 
  - `commitResults` (object): Results of applying fixes
- **Called By**: `handleButtonAction()`
- **Calls**: `githubService.commitFixesToPRBranch()`

### `formatInlineCommentWithFix(finding, trackingId, owner, repo, checkRunData)`
- **Purpose**: Creates a formatted comment with fix suggestions for a specific finding
- **Input Data**: 
  - `finding` (object): The specific issue found
  - `trackingId` (string): Tracking ID
  - `owner` (string): Repository owner
  - `repo` (string): Repository name
  - `checkRunData` (object): Check run data
- **Output Data**: 
  - `comment` (string): Formatted comment text
- **Called By**: `postAllFindings()`
- **Calls**: `githubService.getFileContentFromPR()`, `aiService.generateCodeFixSuggestion()`

### `generateCheckRunActions(postableFindings, buttonStates)`
- **Purpose**: Creates the interactive buttons for the check run based on current state
- **Input Data**: 
  - `postableFindings` (array): Findings that can be posted
  - `buttonStates` (object): Current state of buttons
- **Output Data**: 
  - `actions` (array): Button configurations
- **Called By**: `createInteractiveCheckRun()`, `updateCheckRunCompleted()`
- **Calls**: None

### `getPostableFindings(detailedFindings)`
- **Purpose**: Filters findings to only include those that can be posted as inline comments
- **Input Data**: 
  - `detailedFindings` (array): All findings from AI analysis
- **Output Data**: 
  - `postableFindings` (array): Findings that can be posted
- **Called By**: `createInteractiveCheckRun()`
- **Calls**: None

---

## 🛡️ **src/middleware/auth.middleware.js** - Security & Authentication

### `constructor()`
- **Purpose**: Sets up the authentication middleware
- **Input Data**: None
- **Output Data**: None (initializes middleware)
- **Called By**: When the middleware is first loaded
- **Calls**: None

### `rateLimitMiddleware()`
- **Purpose**: Prevents too many requests from the same source (rate limiting)
- **Input Data**: HTTP request and response objects
- **Output Data**: None (allows or blocks request)
- **Called By**: Express middleware chain
- **Calls**: None

### `verifyInstallation(installationId)`
- **Purpose**: Verifies that the GitHub App is properly installed
- **Input Data**: 
  - `installationId` (string): GitHub installation ID
- **Output Data**: 
  - `boolean`: True if installation is valid
- **Called By**: Various authentication functions
- **Calls**: None

### `basicAuth(req, res, next)`
- **Purpose**: Provides basic authentication for non-webhook endpoints
- **Input Data**: HTTP request and response objects
- **Output Data**: None (allows or blocks request)
- **Called By**: Express middleware chain
- **Calls**: None

### `requestLogger(req, res, next)`
- **Purpose**: Logs all incoming requests for monitoring and debugging
- **Input Data**: HTTP request and response objects
- **Output Data**: None (logs request information)
- **Called By**: Express middleware chain
- **Calls**: None

### `validateWebhookHeaders(req, res, next)`
- **Purpose**: Validates that webhook requests have the required headers
- **Input Data**: HTTP request and response objects
- **Output Data**: None (allows or blocks request)
- **Called By**: Express middleware chain
- **Calls**: None

### `securityHeaders(req, res, next)`
- **Purpose**: Adds security headers to responses to prevent attacks
- **Input Data**: HTTP request and response objects
- **Output Data**: None (adds security headers)
- **Called By**: Express middleware chain
- **Calls**: None

---

## 🛠️ **src/utils/helpers.js** - Utility Functions

### `generateTrackingId()`
- **Purpose**: Creates a unique identifier for tracking analysis requests
- **Input Data**: None
- **Output Data**: 
  - `trackingId` (string): Unique tracking identifier
- **Called By**: Multiple functions throughout the application
- **Calls**: None

### `delay(ms)`
- **Purpose**: Pauses execution for a specified amount of time
- **Input Data**: 
  - `ms` (number): Milliseconds to wait
- **Output Data**: 
  - `Promise`: Promise that resolves after delay
- **Called By**: Multiple functions for rate limiting
- **Calls**: None

### `retryWithBackoff(operation, maxRetries, baseDelay)`
- **Purpose**: Retries a failed operation with increasing delays between attempts
- **Input Data**: 
  - `operation` (function): Function to retry
  - `maxRetries` (number): Maximum retry attempts
  - `baseDelay` (number): Base delay between retries
- **Output Data**: 
  - `result` (any): Result of successful operation
- **Called By**: `aiService.analyzePullRequest()`
- **Calls**: `delay()`

### `sanitizeForAI(data)`
- **Purpose**: Cleans data before sending it to AI services to prevent issues
- **Input Data**: 
  - `data` (any): Data to sanitize
- **Output Data**: 
  - `sanitizedData` (any): Cleaned data
- **Called By**: AI service functions
- **Calls**: None

### `isValidJSON(str)`
- **Purpose**: Checks if a string contains valid JSON data
- **Input Data**: 
  - `str` (string): String to validate
- **Output Data**: 
  - `boolean`: True if valid JSON
- **Called By**: `aiService.parseAnalysisResponse()`
- **Calls**: None

---

## 📊 Data Flow Diagrams

### Main Application Flow
```
GitHub Event → Webhook Handler → Event Router → Specific Handler → AI Analysis → Button Creation → User Interaction → Action Processing
```

### AI Analysis Flow
```
PR Data → Data Preparation → AI Prompt → AI Service → Response Parsing → Context Enhancement → Structured Analysis
```

### Button Interaction Flow
```
User Clicks Button → Action Handler → Data Validation → Specific Action (Post/Commit/Check) → Result Update → Button State Update
```

---

## 🔄 Function Input/Output Specifications

### Common Data Types

#### **PR Data Object**
```javascript
{
  pr: {
    number: 123,
    title: "Fix bug in user authentication",
    author: "developer",
    repository: "owner/repo",
    url: "https://github.com/owner/repo/pull/123"
  },
  files: [
    {
      filename: "src/auth.js",
      status: "modified",
      additions: 10,
      deletions: 5,
      changes: 15
    }
  ],
  comments: [],
  reviewers: []
}
```

#### **Analysis Object**
```javascript
{
  trackingId: "analysis-123456",
  automatedAnalysis: {
    totalIssues: 5,
    severityBreakdown: {
      critical: 1,
      major: 2,
      minor: 2
    },
    categories: {
      bugs: 2,
      vulnerabilities: 1,
      codeSmells: 2
    }
  },
  detailedFindings: [
    {
      file: "src/auth.js",
      line: 42,
      issue: "SQL injection vulnerability",
      severity: "CRITICAL",
      suggestion: "Use parameterized queries"
    }
  ],
  reviewAssessment: "NEEDS_IMPROVEMENT"
}
```

#### **Check Run Data Object**
```javascript
{
  checkRunId: 789,
  owner: "owner",
  repo: "repo",
  pullNumber: 123,
  headSha: "abc123",
  trackingId: "analysis-123456",
  analysis: { /* analysis object */ },
  postableFindings: [ /* findings array */ ],
  buttonStates: {
    "post-all": "ready",
    "commit-fixes": "ready",
    "check-merge": "ready"
  }
}
```

---

This documentation provides a complete understanding of every function in the GitHub AI Code Reviewer application, showing how they work together to create an intelligent code review system.