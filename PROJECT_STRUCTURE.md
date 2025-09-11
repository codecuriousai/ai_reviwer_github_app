# GitHub AI Code Reviewer - Project Structure & Documentation

## 📋 Table of Contents
- [Project Overview](#project-overview)
- [System Architecture](#system-architecture)
- [Project Structure](#project-structure)
- [File-by-File Documentation](#file-by-file-documentation)
- [API Endpoints](#api-endpoints)
- [Deployment Guide](#deployment-guide)
- [Configuration](#configuration)
- [Troubleshooting](#troubleshooting)

---

## 🎯 Project Overview

The **GitHub AI Code Reviewer** is an enterprise-grade GitHub App that automatically reviews pull requests using AI models (OpenAI GPT-4 or Google Gemini) and applies SonarQube standards for comprehensive code quality assessment. It provides interactive buttons for posting AI findings directly to code and can automatically commit fixes.

### Key Features
- 🤖 **AI-Powered Code Analysis** using OpenAI GPT-4 or Google Gemini
- 📊 **SonarQube Standards** compliance checking
- 🔍 **Interactive Comment System** with clickable buttons
- 🚨 **Severity-based Issue Classification** (CRITICAL, HIGH, MEDIUM, LOW, INFO)
- ⚡ **Real-time Processing** via GitHub webhooks
- 🔧 **Automatic Fix Suggestions** and commit capabilities
- 📈 **Merge Readiness Assessment**
- 🛡️ **Enterprise Security** with proper authentication

---

## 🏗️ System Architecture

```
┌─────────────────┐    ┌──────────────────┐    ┌─────────────────┐
│   GitHub App    │    │   AI Reviewer    │    │   AI Service    │
│                 │    │   Application    │    │                 │
│  ┌───────────┐  │    │                  │    │  ┌───────────┐  │
│  │ Webhooks  │──┼────┼─► Webhook        │    │  │ OpenAI    │  │
│  │           │  │    │   Handler        │    │  │ GPT-4     │  │
│  └───────────┘  │    │                  │    │  └───────────┘  │
│                 │    │  ┌───────────┐   │    │                 │
│  ┌───────────┐  │    │  │ Check Run │   │    │  ┌───────────┐  │
│  │ Check     │◄─┼────┼──┤ Button    │   │    │  │ Google    │  │
│  │ Runs      │  │    │  │ Service   │   │    │  │ Gemini    │  │
│  └───────────┘  │    │  └───────────┘   │    │  └───────────┘  │
│                 │    │                  │    │                 │
│  ┌───────────┐  │    │  ┌───────────┐   │    └─────────────────┘
│  │ Comments  │◄─┼────┼──┤ GitHub    │   │
│  │ & Reviews │  │    │  │ Service   │   │
│  └───────────┘  │    │  └───────────┘   │
└─────────────────┘    └──────────────────┘
```

---

## 📁 Project Structure

```
ai_reviwer_github_app/
├── 📄 package.json                    # Project dependencies and scripts
├── 📄 package-lock.json              # Dependency lock file
├── 📄 render.yaml                    # Render.com deployment configuration
├── 📄 README.md                      # Basic project documentation
├── 📄 PROJECT_STRUCTURE.md           # This comprehensive documentation
├── 📄 ENHANCED_FEATURES.md           # Feature enhancements documentation
├── 📄 IMPLEMENTATION_SUMMARY.md      # Implementation details
├── 📄 readme_API.md                  # API documentation
├── 📁 public/                        # Static web assets
│   └── 📄 check-run-button-dashboard.html  # Interactive dashboard
├── 📁 src/                           # Main application source code
│   ├── 📄 index.js                   # Application entry point
│   ├── 📁 config/                    # Configuration management
│   │   └── 📄 config.js              # Environment and app configuration
│   ├── 📁 middleware/                # Express middleware
│   │   └── 📄 auth.middleware.js     # Authentication and security
│   ├── 📁 services/                  # Core business logic services
│   │   ├── 📄 ai.service.js          # AI analysis and processing
│   │   ├── 📄 github.service.js      # GitHub API interactions
│   │   ├── 📄 webhook.service.js     # Webhook event handling
│   │   ├── 📄 check-run-button.service.js  # Interactive button management
│   │   ├── 📄 pr-review-status.service.js  # PR review state tracking
│   │   ├── 📄 fix-history.service.js # Fix tracking and history
│   │   └── 📄 interactive-comment.service.js # Comment interaction logic
│   ├── 📁 prompts/                   # AI prompt templates
│   │   ├── 📄 prompts.js             # Basic AI prompts
│   │   ├── 📄 enhanced-prompts.js    # Advanced AI prompts
│   │   └── 📄 prompts-one.js         # Single comment prompts
│   ├── 📁 utils/                     # Utility functions
│   │   ├── 📄 helpers.js             # Common helper functions
│   │   └── 📄 logger.js              # Logging configuration
│   └── 📁 scripts/                   # Deployment and setup scripts
│       └── 📄 setup.sh               # Environment setup script
└── 📁 node_modules/                  # NPM dependencies
```

---

## 📚 File-by-File Documentation

### 🚀 Core Application Files

#### `src/index.js` - Application Entry Point
**Purpose**: Main Express.js server that handles all HTTP requests and coordinates services.

**Key Functionality**:
- **Server Initialization**: Sets up Express app with middleware
- **Webhook Processing**: Handles GitHub webhook events with signature verification
- **Health Monitoring**: Provides `/health` endpoint for system status
- **API Endpoints**: Exposes REST APIs for check run management
- **Error Handling**: Comprehensive error handling and logging
- **Security**: Implements security headers and request validation

**API Calls Made**:
- `POST /webhook` - Receives GitHub webhook events
- `GET /health` - System health check
- `GET /status` - Application status
- `GET /api/check-runs/*` - Check run management APIs

#### `src/config/config.js` - Configuration Management
**Purpose**: Centralized configuration management with environment variable handling.

**Key Functionality**:
- **Environment Variables**: Loads and validates all required environment variables
- **GitHub App Configuration**: Manages GitHub App credentials and settings
- **AI Provider Setup**: Configures OpenAI or Gemini API settings
- **Review Settings**: Defines code review parameters and file exclusions
- **Security**: Handles private key loading for different deployment environments

**Configuration Sections**:
- `server`: Port, environment, logging settings
- `github`: App ID, private key, webhook secret, installation ID
- `ai`: Provider selection, API keys, model settings
- `review`: Target branches, file exclusions, analysis limits

### 🔧 Service Layer

#### `src/services/webhook.service.js` - Webhook Event Handler
**Purpose**: Processes GitHub webhook events and triggers appropriate actions.

**Key Functionality**:
- **Event Routing**: Routes different webhook events to appropriate handlers
- **PR Processing**: Handles pull request events (opened, reopened, synchronized)
- **Check Run Management**: Creates and manages interactive check runs
- **Queue Management**: Prevents duplicate processing and manages concurrent reviews
- **Error Recovery**: Handles failures with retry mechanisms

**Webhook Events Handled**:
- `pull_request`: PR creation, updates, and synchronization
- `check_run`: Interactive button clicks and status updates
- `issue_comment`: Manual AI review triggers via comments
- `ping`: GitHub App connectivity verification

#### `src/services/ai.service.js` - AI Analysis Engine
**Purpose**: Core AI processing service that analyzes code using OpenAI or Gemini.

**Key Functionality**:
- **Code Analysis**: Analyzes pull requests using AI models
- **SonarQube Standards**: Applies industry-standard code quality rules
- **Fix Generation**: Generates code fix suggestions for identified issues
- **Merge Readiness**: Assesses if PRs are ready to merge
- **Prompt Management**: Uses sophisticated prompts for accurate analysis

**AI Capabilities**:
- Bug detection and vulnerability scanning
- Code smell identification
- Security hotspot analysis
- Performance issue detection
- Code quality assessment

#### `src/services/github.service.js` - GitHub API Integration
**Purpose**: Handles all GitHub API interactions and repository operations.

**Key Functionality**:
- **Authentication**: Manages GitHub App authentication and token generation
- **Repository Operations**: Fetches PR data, files, and commit information
- **Comment Management**: Posts inline comments and general PR comments
- **Check Run Operations**: Creates, updates, and manages GitHub check runs
- **File Operations**: Reads file contents and validates line numbers
- **Fix Committing**: Automatically commits AI-suggested fixes to PR branches in single commits

**GitHub API Endpoints Used**:
- `/repos/{owner}/{repo}/pulls` - Pull request data
- `/repos/{owner}/{repo}/pulls/{pull_number}/files` - PR file changes
- `/repos/{owner}/{repo}/pulls/{pull_number}/comments` - Review comments
- `/repos/{owner}/{repo}/check-runs` - Check run management
- `/repos/{owner}/{repo}/contents` - File content retrieval

#### `src/services/check-run-button.service.js` - Interactive Button System
**Purpose**: Manages interactive buttons in GitHub check runs for user actions.

**Key Functionality**:
- **Button Creation**: Creates interactive buttons for AI findings
- **Action Handling**: Processes button clicks and triggers appropriate actions
- **Comment Posting**: Posts AI findings as inline comments
- **Fix Committing**: Commits AI-suggested fixes to PR branches
- **State Management**: Tracks button states and user interactions

**Interactive Features**:
- "Post All Comments" - Posts all AI findings as inline comments
- "Commit Fixes" - Applies all AI-suggested fixes to the PR branch
- "Check Merge Ready" - Assesses if PR is ready to merge

### 🛡️ Middleware & Utilities

#### `src/middleware/auth.middleware.js` - Security & Authentication
**Purpose**: Provides security middleware and request validation.

**Key Functionality**:
- **Rate Limiting**: Prevents abuse with request rate limiting
- **Security Headers**: Implements security headers for protection
- **Request Logging**: Logs all incoming requests for monitoring
- **Webhook Validation**: Validates GitHub webhook signatures
- **Authentication**: Handles GitHub App authentication

#### `src/utils/logger.js` - Logging System
**Purpose**: Centralized logging configuration using Winston.

**Key Functionality**:
- **Multi-level Logging**: Supports different log levels (error, warn, info, debug)
- **File Logging**: Optional file-based logging for production
- **Console Logging**: Real-time console output for development
- **Error Tracking**: Captures and logs uncaught exceptions
- **Structured Logging**: JSON-formatted logs for easy parsing

#### `src/utils/helpers.js` - Utility Functions
**Purpose**: Common utility functions used across the application.

**Key Functions**:
- `generateTrackingId()` - Creates unique tracking IDs for analysis
- `delay()` - Implements delays for rate limiting
- `retryWithBackoff()` - Retry logic with exponential backoff
- `sanitizeForAI()` - Sanitizes data before sending to AI
- `isValidJSON()` - Validates JSON data

### 📝 Prompt Templates

#### `src/prompts/enhanced-prompts.js` - AI Prompt Templates
**Purpose**: Sophisticated prompt templates for AI analysis.

**Key Prompts**:
- **Code Review Prompt**: Comprehensive code analysis instructions
- **Fix Suggestion Prompt**: Instructions for generating code fixes
- **Merge Readiness Prompt**: Criteria for assessing merge readiness
- **SonarQube Standards**: Integration of SonarQube quality rules

---

## 🌐 API Endpoints

### Webhook Endpoints
- **`POST /webhook`** - GitHub webhook receiver
  - Handles: `pull_request`, `check_run`, `issue_comment`, `ping` events
  - Authentication: GitHub webhook signature verification

### Health & Status Endpoints
- **`GET /health`** - System health check
  - Returns: Server status, memory usage, AI service health, GitHub connectivity
- **`GET /status`** - Application status
  - Returns: Processing queue, active reviews, system metrics

### Check Run Management APIs
- **`GET /api/check-runs/active`** - List active check runs
- **`GET /api/check-runs/:checkRunId`** - Get specific check run data
- **`POST /api/check-runs/cleanup`** - Clean up old check runs
- **`POST /api/check-runs/:checkRunId/commit-fixes`** - Commit AI fixes in single commit
- **`POST /api/check-runs/:checkRunId/check-merge`** - Check merge readiness

### AI Service APIs
- **`POST /api/fix-suggestion`** - Generate fix suggestions
- **`POST /api/merge-readiness`** - Assess merge readiness
- **`GET /api/commit-fix`** - Commit fix interface

### Debug & Testing APIs
- **`POST /debug/test-check-run-buttons`** - Test check run creation
- **`POST /debug/ai-test`** - Test AI service functionality

### Commit Management Features
- **Single Commit Strategy**: All AI-suggested fixes are committed together in one commit
- **Batch Processing**: Collects all file changes before committing
- **Error Handling**: Detailed error reporting with file and line information
- **Fallback Mechanism**: Alternative commit approach if batch commit fails
- **Comprehensive Logging**: Detailed logs for debugging commit issues

---

## 🚀 Deployment Guide

### Prerequisites
- Node.js 18+ and npm 8+
- GitHub account with admin access
- OpenAI API key or Google Gemini API key
- EC2 instance or cloud server

### 1. GitHub App Setup

1. **Create GitHub App**:
   - Go to [GitHub Developer Settings](https://github.com/settings/apps)
   - Click "New GitHub App"
   - Set webhook URL: `https://your-domain.com/webhook`
   - Configure permissions:
     - Contents: Read
     - Issues: Write
     - Pull requests: Write
     - Metadata: Read
   - Subscribe to events: `pull_request`, `check_run`, `issue_comment`
   - Generate and download private key

2. **Install App**:
   - Install the app on your repositories
   - Note the Installation ID

### 2. Environment Configuration

Create `.env` file:
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

### 3. EC2 Deployment

#### Step 1: Launch EC2 Instance
```bash
# Launch Ubuntu 20.04 LTS instance
# Instance type: t3.medium or larger
# Security group: Allow HTTP (80), HTTPS (443), SSH (22)
```

#### Step 2: Install Dependencies
```bash
# Update system
sudo apt update && sudo apt upgrade -y

# Install Node.js 18
curl -fsSL https://deb.nodesource.com/setup_18.x | sudo -E bash -
sudo apt-get install -y nodejs

# Install PM2 for process management
sudo npm install -g pm2

# Install nginx for reverse proxy
sudo apt install nginx -y
```

#### Step 3: Deploy Application
```bash
# Clone repository
git clone https://github.com/your-username/github-ai-reviewer.git
cd github-ai-reviewer

# Install dependencies
npm install

# Create environment file
nano .env
# Add your environment variables

# Test application
npm start
```

#### Step 4: Configure PM2
```bash
# Create PM2 ecosystem file
cat > ecosystem.config.js << EOF
module.exports = {
  apps: [{
    name: 'github-ai-reviewer',
    script: 'src/index.js',
    instances: 1,
    exec_mode: 'cluster',
    env: {
      NODE_ENV: 'production',
      PORT: 3000
    },
    error_file: './logs/err.log',
    out_file: './logs/out.log',
    log_file: './logs/combined.log',
    time: true
  }]
};
EOF

# Start with PM2
pm2 start ecosystem.config.js
pm2 save
pm2 startup
```

#### Step 5: Configure Nginx
```bash
# Create nginx configuration
sudo nano /etc/nginx/sites-available/github-ai-reviewer

# Add configuration
server {
    listen 80;
    server_name your-domain.com;

    location / {
        proxy_pass http://localhost:3000;
        proxy_http_version 1.1;
        proxy_set_header Upgrade $http_upgrade;
        proxy_set_header Connection 'upgrade';
        proxy_set_header Host $host;
        proxy_set_header X-Real-IP $remote_addr;
        proxy_set_header X-Forwarded-For $proxy_add_x_forwarded_for;
        proxy_set_header X-Forwarded-Proto $scheme;
        proxy_cache_bypass $http_upgrade;
    }
}

# Enable site
sudo ln -s /etc/nginx/sites-available/github-ai-reviewer /etc/nginx/sites-enabled/
sudo nginx -t
sudo systemctl restart nginx
```

#### Step 6: SSL Certificate (Let's Encrypt)
```bash
# Install certbot
sudo apt install certbot python3-certbot-nginx -y

# Obtain SSL certificate
sudo certbot --nginx -d your-domain.com

# Test auto-renewal
sudo certbot renew --dry-run
```

### 4. Monitoring & Maintenance

#### Health Monitoring
```bash
# Check application status
pm2 status
pm2 logs github-ai-reviewer

# Check nginx status
sudo systemctl status nginx

# Monitor system resources
htop
df -h
```

#### Log Management
```bash
# View application logs
pm2 logs github-ai-reviewer --lines 100

# View nginx logs
sudo tail -f /var/log/nginx/access.log
sudo tail -f /var/log/nginx/error.log

# Rotate logs
pm2 install pm2-logrotate
```

#### Updates & Maintenance
```bash
# Update application
git pull origin main
npm install
pm2 restart github-ai-reviewer

# Update system
sudo apt update && sudo apt upgrade -y
```

---

## ⚙️ Configuration

### Environment Variables

| Variable | Description | Required | Default |
|----------|-------------|----------|---------|
| `GITHUB_APP_ID` | GitHub App ID | Yes | - |
| `GITHUB_PRIVATE_KEY_BASE64` | Base64 encoded private key | Yes | - |
| `GITHUB_WEBHOOK_SECRET` | Webhook secret | Yes | - |
| `GITHUB_INSTALLATION_ID` | Installation ID | Yes | - |
| `AI_PROVIDER` | AI provider (openai/gemini) | Yes | openai |
| `OPENAI_API_KEY` | OpenAI API key | If OpenAI | - |
| `GEMINI_API_KEY` | Gemini API key | If Gemini | - |
| `PORT` | Server port | No | 3000 |
| `NODE_ENV` | Environment | No | production |
| `LOG_LEVEL` | Logging level | No | info |
| `ENABLE_FILE_LOGGING` | Enable file logging | No | false |

### Review Configuration

| Setting | Description | Default |
|---------|-------------|---------|
| `targetBranches` | Branches to monitor | main,master,develop |
| `excludeFiles` | Files to ignore | *.md,*.txt,*.json,etc. |
| `maxFilesToAnalyze` | Max files per PR | 25 |
| `maxFileSizeBytes` | Max file size | 120000 |
| `maxConcurrentReviews` | Concurrent review limit | 3 |

---

## 🔧 Troubleshooting

### Common Issues

#### 1. Webhook Not Receiving Events
**Symptoms**: No AI reviews triggered on PRs
**Solutions**:
- Verify webhook URL is publicly accessible
- Check webhook secret matches configuration
- Ensure GitHub App has correct permissions
- Check nginx configuration for proper proxying

#### 2. AI API Errors
**Symptoms**: AI analysis fails with API errors
**Solutions**:
- Verify API keys are valid and have quota
- Check network connectivity to AI services
- Monitor rate limits and implement backoff
- Check AI service status

#### 3. Check Run Button Issues
**Symptoms**: Interactive buttons not working
**Solutions**:
- Verify GitHub App has check run permissions
- Check button action handling in logs
- Ensure proper webhook event subscription
- Validate check run data structure

#### 4. Memory Issues
**Symptoms**: Application crashes or slow performance
**Solutions**:
- Increase EC2 instance size
- Monitor memory usage with `htop`
- Implement proper error handling
- Clean up old check run data

#### 5. Commit Issues
**Symptoms**: Fixes not being committed or multiple commits created
**Solutions**:
- Check GitHub API rate limits
- Verify blob creation is successful
- Review tree creation logs
- Check for file size limits (100MB per file)
- Monitor commit error messages for specific file/line issues

### Debug Commands

```bash
# Check application logs
pm2 logs github-ai-reviewer --lines 50

# Test webhook endpoint
curl -X POST https://your-domain.com/webhook \
  -H "Content-Type: application/json" \
  -d '{"test": "ping"}'

# Check health endpoint
curl https://your-domain.com/health

# Monitor system resources
htop
iostat -x 1
```

### Log Analysis

```bash
# Search for errors
pm2 logs github-ai-reviewer | grep ERROR

# Monitor webhook events
pm2 logs github-ai-reviewer | grep "webhook"

# Check AI service calls
pm2 logs github-ai-reviewer | grep "AI"

# Check commit operations
pm2 logs github-ai-reviewer | grep "commit"

# Check batch commit process
pm2 logs github-ai-reviewer | grep "batch commit"
```

---

## 📊 Performance Metrics

### Key Performance Indicators
- **Response Time**: < 2 seconds for webhook processing
- **AI Analysis Time**: < 30 seconds for typical PRs
- **Memory Usage**: < 512MB per instance
- **CPU Usage**: < 70% under normal load
- **Uptime**: > 99.5% availability

### Monitoring Setup
```bash
# Install monitoring tools
sudo apt install htop iotop nethogs -y

# Set up log rotation
pm2 install pm2-logrotate
pm2 set pm2-logrotate:max_size 10M
pm2 set pm2-logrotate:retain 7
```

---

## 🔒 Security Considerations

### Security Measures
- **Webhook Signature Verification**: All webhooks verified with HMAC-SHA256
- **Rate Limiting**: Prevents abuse with configurable limits
- **Security Headers**: XSS protection, content type sniffing prevention
- **Private Key Security**: Encrypted storage and secure transmission
- **Input Validation**: All inputs sanitized before processing
- **Error Handling**: No sensitive data exposed in error messages

### Best Practices
- Use HTTPS for all communications
- Regularly update dependencies
- Monitor logs for suspicious activity
- Implement proper backup strategies
- Use environment variables for secrets
- Regular security audits

---

## 📈 Scaling & Optimization

### Horizontal Scaling
- Deploy multiple instances behind load balancer
- Use PM2 cluster mode for CPU utilization
- Implement Redis for shared state management
- Use database for persistent storage

### Vertical Scaling
- Increase EC2 instance size
- Add more memory for large PRs
- Use faster CPU for AI processing
- Implement caching for repeated analysis

### Performance Optimization
- Cache AI responses for similar code patterns
- Implement file size limits
- Use streaming for large file processing
- Optimize database queries
- Implement CDN for static assets

---

## 📞 Support & Maintenance

### Regular Maintenance Tasks
- **Weekly**: Review logs and performance metrics
- **Monthly**: Update dependencies and security patches
- **Quarterly**: Review and update AI prompts
- **Annually**: Security audit and penetration testing

### Support Channels
- **Documentation**: This file and inline code comments
- **Issues**: GitHub Issues for bug reports
- **Monitoring**: Application health endpoints
- **Logs**: Comprehensive logging for debugging

---

*This documentation is maintained alongside the codebase and should be updated with any significant changes to the application architecture or functionality.*
