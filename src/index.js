const express = require('express');

/**
 * Logs startup messages with timestamp and error status
 * @param {string} message - The message to log
 * @param {boolean} isError - Whether this is an error message
 */
function logStartup(message, isError = false) {
  const timestamp = new Date().toISOString();
  const prefix = isError ? '❌ ERROR' : '✅ INFO';
  console.log(`${timestamp} [${prefix}]: ${message}`);
}

logStartup('Starting GitHub AI Reviewer application...');

let config, logger, webhookService, authMiddleware, checkRunButtonService;

try {
  logStartup('Loading configuration...');
  config = require('./config/config');
  logStartup('Configuration loaded successfully');
  
  logStartup('Initializing logger...');
  logger = require('./utils/logger');
  logStartup('Logger initialized successfully');
  
  logStartup('Loading services...');
  webhookService = require('./services/webhook.service');
  authMiddleware = require('./middleware/auth.middleware');
  checkRunButtonService = require('./services/check-run-button.service');
  logStartup('All services loaded successfully');
  
} catch (error) {
  logStartup(`Failed to load required modules: ${error.message}`, true);
  logStartup(`Error stack: ${error.stack}`, true);
  process.exit(1);
}

const path = require('path');
const app = express();

logStartup('Express app created successfully');

app.use('/webhook', express.raw({ type: 'application/json' }));

app.use(express.json({ 
  verify: (req, res, buf) => {
    req.rawBody = buf;
  }
}));

app.use(authMiddleware.securityHeaders);
app.use(authMiddleware.requestLogger);

/**
 * Health check endpoint that returns system status and service health
 * @param {Object} req - Express request object
 * @param {Object} res - Express response object
 */
app.get('/health', async (req, res) => {
  try {
    const health = {
      status: 'OK',
      timestamp: new Date().toISOString(),
      uptime: process.uptime(),
      memory: process.memoryUsage(),
      environment: process.env.NODE_ENV,
      version: require('../package.json').version,
    };

    try {
      const aiService = require('./services/ai.service');
      const aiHealthy = await aiService.checkHealth();
      health.aiService = aiHealthy ? 'OK' : 'ERROR';
    } catch (error) {
      health.aiService = 'ERROR';
      health.aiError = error.message;
    }

    try {
      const githubService = require('./services/github.service');
      const githubHealth = await githubService.healthCheck();
      health.githubService = githubHealth.status === 'healthy' ? 'OK' : 'ERROR';
      if (githubHealth.authenticated) {
        health.githubApp = githubHealth.appName;
      }
    } catch (error) {
      health.githubService = 'ERROR';
      health.githubError = error.message;
    }

    health.checkRunButtons = checkRunButtonService.getStats();

    res.status(200).json(health);
  } catch (error) {
    logger.error('Health check failed:', error);
    res.status(503).json({
      status: 'ERROR',
      timestamp: new Date().toISOString(),
      error: error.message,
    });
  }
});

/**
 * Webhook endpoint for processing GitHub webhook events
 * @param {Object} req - Express request object
 * @param {Object} res - Express response object
 */
app.post('/webhook', authMiddleware.validateWebhookHeaders, async (req, res) => {
  try {
    const signature = req.get('X-Hub-Signature-256');
    const event = req.get('X-GitHub-Event');
    const delivery = req.get('X-GitHub-Delivery');

    logger.info(`Received webhook: ${event}`, { delivery });

    const payload = req.body;
    const payloadString = payload.toString('utf8');
    
    const crypto = require('crypto');
    const expectedSignature = crypto
      .createHmac('sha256', config.github.webhookSecret)
      .update(payload)
      .digest('hex');

    const expectedSignatureBuffer = Buffer.from(`sha256=${expectedSignature}`, 'utf8');
    const actualSignatureBuffer = Buffer.from(signature, 'utf8');

    if (expectedSignatureBuffer.length !== actualSignatureBuffer.length ||
        !crypto.timingSafeEqual(expectedSignatureBuffer, actualSignatureBuffer)) {
      logger.warn('Invalid webhook signature', { 
        event, 
        delivery,
        expectedLength: expectedSignatureBuffer.length,
        actualLength: actualSignatureBuffer.length 
      });
      return res.status(401).json({ error: 'Invalid signature' });
    }

    logger.info('Webhook signature verified', { event, delivery });

    let parsedPayload;
    try {
      parsedPayload = JSON.parse(payloadString);
    } catch (parseError) {
      logger.error('Failed to parse webhook payload:', parseError);
      return res.status(400).json({ error: 'Invalid JSON payload' });
    }

    await webhookService.handleWebhook(event, parsedPayload);
    
    res.status(200).json({ 
      message: 'Webhook processed successfully',
      event,
      delivery 
    });
    
  } catch (error) {
    logger.error('Error processing webhook:', error);
    res.status(500).json({ 
      error: 'Internal server error',
      message: error.message 
    });
  }
});

/**
 * Status endpoint that returns system status and processing queue information
 * @param {Object} req - Express request object
 * @param {Object} res - Express response object
 */
app.get('/status', (req, res) => {
  const webhookStatus = webhookService.getProcessingStatus();
  res.json({
    server: {
      uptime: process.uptime(),
      memory: process.memoryUsage(),
      environment: process.env.NODE_ENV,
      timestamp: new Date().toISOString(),
    },
    webhooks: webhookStatus,
    checkRunButtons: webhookStatus.checkRunButtons,
    features: {
      codeFixSuggestions: true,
      mergeReadinessCheck: true,
      enhancedComments: true,
      aiAnalysis: true
    },
    system: {
      activeReviews: webhookStatus.activeReviews,
      queueSize: webhookStatus.queueSize,
      maxConcurrent: webhookStatus.maxConcurrent,
    }
  });
});

/**
 * Gets active check runs and their statistics
 * @param {Object} req - Express request object
 * @param {Object} res - Express response object
 */
app.get('/api/check-runs/active', (req, res) => {
  try {
    const stats = checkRunButtonService.getStats();
    res.json({
      success: true,
      timestamp: new Date().toISOString(),
      stats,
      activeCheckRuns: Array.from(checkRunButtonService.activeCheckRuns.entries()).map(([id, data]) => ({
        checkRunId: id,
        owner: data.owner,
        repo: data.repo,
        pullNumber: data.pullNumber,
        trackingId: data.trackingId,
        postableFindings: data.postableFindings.length,
        postedFindings: data.postableFindings.filter(f => f.posted).length,
        createdAt: data.createdAt,
        buttonStates: data.buttonStates
      }))
    });
  } catch (error) {
    logger.error('Error getting active check runs:', error);
    res.status(500).json({
      error: 'Failed to get active check runs',
      message: error.message
    });
  }
});

/**
 * Gets specific check run data by ID
 * @param {Object} req - Express request object with checkRunId parameter
 * @param {Object} res - Express response object
 */
app.get('/api/check-runs/:checkRunId', (req, res) => {
  try {
    const { checkRunId } = req.params;
    const checkRunData = checkRunButtonService.activeCheckRuns.get(parseInt(checkRunId));
    
    if (!checkRunData) {
      return res.status(404).json({
        error: 'Check run not found',
        checkRunId: parseInt(checkRunId)
      });
    }

    res.json({
      success: true,
      checkRunId: parseInt(checkRunId),
      data: {
        owner: checkRunData.owner,
        repo: checkRunData.repo,
        pullNumber: checkRunData.pullNumber,
        trackingId: checkRunData.trackingId,
        totalFindings: checkRunData.postableFindings.length,
        postedFindings: checkRunData.postableFindings.filter(f => f.posted).length,
        pendingFindings: checkRunData.postableFindings.filter(f => !f.posted).length,
        createdAt: checkRunData.createdAt,
        buttonStates: checkRunData.buttonStates,
        findings: checkRunData.postableFindings.map((finding, index) => ({
          index,
          file: finding.file,
          line: finding.line,
          issue: finding.issue,
          severity: finding.severity,
          category: finding.category,
          posted: finding.posted,
          commentId: finding.commentId
        }))
      }
    });
  } catch (error) {
    logger.error('Error getting check run data:', error);
    res.status(500).json({
      error: 'Failed to get check run data',
      message: error.message
    });
  }
});

/**
 * Manual cleanup endpoint for old check runs
 * @param {Object} req - Express request object
 * @param {Object} res - Express response object
 */
app.post('/api/check-runs/cleanup', (req, res) => {
  try {
    checkRunButtonService.cleanOldCheckRuns();
    res.json({
      success: true,
      message: 'Check run cleanup completed',
      timestamp: new Date().toISOString()
    });
  } catch (error) {
    logger.error('Error cleaning check runs:', error);
    res.status(500).json({
      error: 'Failed to clean check runs',
      message: error.message
    });
  }
});

/**
 * Generates and commits fix suggestions for a check run
 * @param {Object} req - Express request object with checkRunId parameter
 * @param {Object} res - Express response object
 */
app.post('/api/check-runs/:checkRunId/commit-fixes', async (req, res) => {
  try {
    const { checkRunId } = req.params;
    const checkRunData = checkRunButtonService.activeCheckRuns.get(parseInt(checkRunId));
    
    if (!checkRunData) {
      return res.status(404).json({
        error: 'Check run not found',
        checkRunId: parseInt(checkRunId)
      });
    }

    const { owner, repo, pullNumber, postableFindings } = checkRunData;
    
    const result = await checkRunButtonService.commitAllFixSuggestions(
      owner, repo, pullNumber, postableFindings, checkRunData
    );

    res.json({
      success: true,
      message: 'Fix suggestions committed successfully',
      checkRunId: parseInt(checkRunId),
      results: {
        successCount: result.successCount,
        errorCount: result.errorCount,
        errors: result.errors,
        committedFixes: result.committedFixes
      },
      timestamp: new Date().toISOString()
    });

  } catch (error) {
    logger.error('Error committing fix suggestions:', error);
    res.status(500).json({
      error: 'Failed to commit fix suggestions',
      message: error.message
    });
  }
});

/**
 * Checks merge readiness for a pull request
 * @param {Object} req - Express request object with checkRunId parameter
 * @param {Object} res - Express response object
 */
app.post('/api/check-runs/:checkRunId/check-merge', async (req, res) => {
  try {
    const { checkRunId } = req.params;
    const checkRunData = checkRunButtonService.activeCheckRuns.get(parseInt(checkRunId));
    
    if (!checkRunData) {
      return res.status(404).json({
        error: 'Check run not found',
        checkRunId: parseInt(checkRunId)
      });
    }

    const { owner, repo, pullNumber, analysis } = checkRunData;
    
    await checkRunButtonService.checkMergeReadiness(owner, repo, pullNumber, analysis, checkRunData);

    res.json({
      success: true,
      message: 'Merge readiness assessment completed',
      checkRunId: parseInt(checkRunId),
      mergeAssessment: checkRunData.mergeAssessment,
      timestamp: new Date().toISOString()
    });

  } catch (error) {
    logger.error('Error checking merge readiness:', error);
    res.status(500).json({
      error: 'Failed to check merge readiness',
      message: error.message
    });
  }
});

/**
 * Gets fix suggestions for a specific finding
 * @param {Object} req - Express request object with finding data in body
 * @param {Object} res - Express response object
 */
app.post('/api/fix-suggestion', async (req, res) => {
  try {
    const { owner, repo, pullNumber, finding } = req.body;
    
    if (!owner || !repo || !pullNumber || !finding) {
      return res.status(400).json({
        error: 'Missing required fields: owner, repo, pullNumber, finding'
      });
    }

    const githubService = require('./services/github.service');
    const aiService = require('./services/ai.service');
    
    const prData = await githubService.getPullRequestData(owner, repo, pullNumber);
    
    const fileContent = await checkRunButtonService.getFileContent(owner, repo, finding.file, prData);
    
    const fixSuggestion = await aiService.generateCodeFixSuggestion(finding, fileContent, prData);

    res.json({
      success: true,
      fixSuggestion,
      timestamp: new Date().toISOString()
    });

  } catch (error) {
    logger.error('Error generating fix suggestion:', error);
    res.status(500).json({
      error: 'Failed to generate fix suggestion',
      message: error.message
    });
  }
});

/**
 * Assesses merge readiness for a pull request
 * @param {Object} req - Express request object with PR data in body
 * @param {Object} res - Express response object
 */
app.post('/api/merge-readiness', async (req, res) => {
  try {
    const { owner, repo, pullNumber } = req.body;
    
    if (!owner || !repo || !pullNumber) {
      return res.status(400).json({
        error: 'Missing required fields: owner, repo, pullNumber'
      });
    }

    const githubService = require('./services/github.service');
    const aiService = require('./services/ai.service');
    
    const prData = await githubService.getPullRequestData(owner, repo, pullNumber);
    const reviewComments = prData.comments || [];
    
    const currentStatus = {
      mergeable: prData.pr.mergeable,
      merge_state: prData.pr.mergeable_state,
      review_decision: prData.pr.review_decision
    };

    const aiFindings = [];
    
    const mergeAssessment = await aiService.assessMergeReadiness(
      prData, aiFindings, reviewComments, currentStatus
    );

    res.json({
      success: true,
      mergeAssessment,
      prData: {
        number: prData.pr.number,
        title: prData.pr.title,
        author: prData.pr.user?.login,
        mergeable: prData.pr.mergeable,
        merge_state: prData.pr.mergeable_state
      },
      timestamp: new Date().toISOString()
    });

  } catch (error) {
    logger.error('Error assessing merge readiness:', error);
    res.status(500).json({
      error: 'Failed to assess merge readiness',
      message: error.message
    });
  }
});

/**
 * Commit fix endpoint that applies AI-suggested fixes directly
 * @param {Object} req - Express request object with commit data in query
 * @param {Object} res - Express response object
 */
app.get('/api/commit-fix', async (req, res) => {
  try {
    const { data } = req.query;
    
    if (!data) {
      return res.status(400).json({ 
        error: 'Missing commit data parameter' 
      });
    }

    const commitData = JSON.parse(decodeURIComponent(data));
    const { file, line, currentCode, suggestedFix, explanation, trackingId, findingIndex } = commitData;

    logger.info(`Commit fix requested for ${file}:${line}`, { trackingId, findingIndex });

    const responseHtml = `
      <!DOCTYPE html>
      <html>
      <head>
        <title>🔧 AI Code Fix - Commit Suggestion</title>
        <meta name="viewport" content="width=device-width, initial-scale=1">
        <style>
          body { 
            font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', sans-serif; 
            max-width: 900px; margin: 20px auto; padding: 20px; 
            background: linear-gradient(135deg, #667eea 0%, #764ba2 100%);
            min-height: 100vh;
          }
          .container { 
            background: white; border-radius: 15px; padding: 30px; 
            box-shadow: 0 20px 60px rgba(0,0,0,0.1);
            border-left: 5px solid #28a745; 
          }
          .header { text-align: center; margin-bottom: 30px; }
          .code { 
            background: #f8f9fa; padding: 20px; border-radius: 8px; 
            font-family: 'Monaco', 'Menlo', monospace; margin: 15px 0;
            border: 1px solid #dee2e6; font-size: 14px; line-height: 1.5;
            position: relative; overflow-x: auto;
          }
          .btn { 
            background: #28a745; color: white; padding: 12px 24px; 
            text-decoration: none; border-radius: 8px; display: inline-block; 
            margin: 10px 10px 0 0; font-weight: 600; border: none; cursor: pointer;
            transition: all 0.3s ease;
          }
          .btn:hover { background: #218838; transform: translateY(-2px); }
          .btn-secondary { background: #6c757d; }
          .btn-secondary:hover { background: #545b62; }
          .btn-info { background: #17a2b8; }
          .btn-info:hover { background: #138496; }
          .success-msg { 
            background: #d4edda; color: #155724; padding: 10px; 
            border-radius: 5px; margin: 10px 0; display: none;
          }
          .section { margin: 25px 0; }
          .diff-removed { background: #ffeaea; color: #d73a49; padding: 2px 4px; }
          .diff-added { background: #e6ffed; color: #28a745; padding: 2px 4px; }
          .copy-btn { 
            position: absolute; top: 10px; right: 10px; 
            background: #007bff; color: white; border: none; 
            padding: 5px 10px; border-radius: 4px; font-size: 12px; cursor: pointer;
          }
          .copy-btn:hover { background: #0056b3; }
        </style>
      </head>
      <body>
        <div class="container">
          <div class="header">
            <h1>🔧 AI Code Fix Suggestion</h1>
            <p><strong>File:</strong> <code>${file}:${line}</code></p>
            <p><strong>Tracking ID:</strong> <code>${trackingId}</code></p>
          </div>
          
          <div class="section">
            <h3>📋 Issue Description</h3>
            <p>${explanation}</p>
          </div>
          
          <div class="section">
            <h3>❌ Current Code</h3>
            <div class="code">
              <button class="copy-btn" onclick="copyToClipboard(currentCode, this)">📋 Copy</button>
              <pre>${currentCode}</pre>
            </div>
          </div>
          
          <div class="section">
            <h3>✅ Suggested Fix</h3>
            <div class="code">
              <button class="copy-btn" onclick="copyToClipboard(suggestedFix, this)">📋 Copy</button>
              <pre>${suggestedFix}</pre>
            </div>
          </div>
          
          <div class="section">
            <h3>🚀 Next Steps</h3>
            <ol>
              <li>Review the suggested changes above</li>
              <li>Copy the fixed code using the button</li>
              <li>Apply the fix in your IDE</li>
              <li>Test the changes thoroughly</li>
              <li>Commit with the suggested message below</li>
            </ol>
          </div>
          
          <div class="section">
            <h3>💬 Suggested Commit Message</h3>
            <div class="code">
              <button class="copy-btn" onclick="copyToClipboard(commitMsg, this)">📋 Copy</button>
              <pre>Fix: ${explanation}

AI-suggested fix for ${file}:${line}
Tracking ID: ${trackingId}</pre>
            </div>
          </div>
          
          <div class="success-msg" id="successMsg">
            ✅ Copied to clipboard!
          </div>
          
          <div style="text-align: center; margin-top: 30px;">
            <button onclick="copyToClipboard(suggestedFix)" class="btn">📋 Copy Fixed Code</button>
            <button onclick="copyToClipboard(commitMsg)" class="btn btn-info">📝 Copy Commit Message</button>
            <button onclick="window.close()" class="btn btn-secondary">✅ Done</button>
          </div>
          
          <div style="text-align: center; margin-top: 20px; font-size: 12px; color: #666;">
            <p>🤖 Generated by AI Code Reviewer | ${new Date().toLocaleString()}</p>
          </div>
        </div>
        
        <script>
          const currentCode = ${JSON.stringify(currentCode)};
          const suggestedFix = ${JSON.stringify(suggestedFix)};
          const commitMsg = \`Fix: ${explanation}

AI-suggested fix for ${file}:${line}
Tracking ID: ${trackingId}\`;

          function copyToClipboard(text, button) {
            navigator.clipboard.writeText(text).then(() => {
              const successMsg = document.getElementById('successMsg');
              successMsg.style.display = 'block';
              
              if (button) {
                const originalText = button.textContent;
                button.textContent = '✅ Copied!';
                button.style.background = '#28a745';
                setTimeout(() => {
                  button.textContent = originalText;
                  button.style.background = '#007bff';
                }, 2000);
              }
              
              setTimeout(() => {
                successMsg.style.display = 'none';
              }, 3000);
            }).catch(err => {
              console.error('Failed to copy: ', err);
              alert('Failed to copy to clipboard. Please select and copy manually.');
            });
          }
        </script>
      </body>
      </html>
    `;

    res.send(responseHtml);

  } catch (error) {
    logger.error('Error in commit fix:', error);
    res.status(500).json({ 
      error: 'Commit fix failed',
      details: error.message 
    });
  }
});

/**
 * Test endpoint for creating check run buttons (development/debugging)
 * @param {Object} req - Express request object with test data in body
 * @param {Object} res - Express response object
 */
app.post('/debug/test-check-run-buttons', async (req, res) => {
  try {
    const { owner, repo, pullNumber, headSha } = req.body;
    
    if (!owner || !repo || !pullNumber || !headSha) {
      return res.status(400).json({
        error: 'Missing required fields: owner, repo, pullNumber, headSha'
      });
    }

    const testAnalysis = {
      trackingId: `test-${Date.now()}`,
      prInfo: {
        prId: pullNumber,
        title: 'Test PR',
        repository: `${owner}/${repo}`,
        author: 'test-user',
        reviewers: [],
        url: `https://github.com/${owner}/${repo}/pull/${pullNumber}`,
      },
      automatedAnalysis: {
        totalIssues: 3,
        severityBreakdown: { blocker: 0, critical: 1, major: 1, minor: 1, info: 0 },
        categories: { bugs: 1, vulnerabilities: 1, securityHotspots: 0, codeSmells: 1 },
        technicalDebtMinutes: 15
      },
      humanReviewAnalysis: {
        reviewComments: 0,
        issuesAddressedByReviewers: 0,
        securityIssuesCaught: 0,
        codeQualityIssuesCaught: 0
      },
      reviewAssessment: 'NOT PROPERLY REVIEWED',
      detailedFindings: [
        {
          file: 'src/test.js',
          line: 10,
          issue: 'Test critical issue',
          severity: 'CRITICAL',
          category: 'VULNERABILITY',
          suggestion: 'Fix this critical issue'
        },
        {
          file: 'src/test.js',
          line: 25,
          issue: 'Test major issue',
          severity: 'MAJOR',
          category: 'BUG',
          suggestion: 'Fix this major issue'
        },
        {
          file: 'src/utils.js',
          line: 5,
          issue: 'Test minor issue',
          severity: 'MINOR',
          category: 'CODE_SMELL',
          suggestion: 'Fix this minor issue'
        }
      ],
      recommendation: 'This is a test check run with interactive buttons.'
    };

    const checkRun = await checkRunButtonService.createInteractiveCheckRun(
      owner, repo, pullNumber, testAnalysis, headSha
    );

    res.json({
      success: true,
      message: 'Test check run created with interactive buttons',
      checkRunId: checkRun.id,
      trackingId: testAnalysis.trackingId,
      postableFindings: 3,
      timestamp: new Date().toISOString()
    });

  } catch (error) {
    logger.error('Error creating test check run:', error);
    res.status(500).json({
      success: false,
      error: error.message,
      timestamp: new Date().toISOString()
    });
  }
});

/**
 * Debug endpoint for testing AI service directly
 * @param {Object} req - Express request object
 * @param {Object} res - Express response object
 */
app.post('/debug/ai-test', async (req, res) => {
  try {
    const aiService = require('./services/ai.service');
    
    const testData = {
      pr: {
        number: 999,
        title: 'Test PR',
        description: 'Testing AI service',
        author: 'test-user',
        repository: 'test/repo',
        targetBranch: 'main',
        sourceBranch: 'feature',
        additions: 10,
        deletions: 5,
        url: 'https://github.com/test/repo/pull/999'
      },
      files: [{
        filename: 'test.js',
        status: 'added',
        additions: 10,
        deletions: 0,
        changes: 10
      }],
      diff: `+function testFunction() {
+  var password = "hardcoded123";
+  console.log(password);
+}`,
      comments: []
    };

    logger.info('Testing AI service with sample data');
    const result = await aiService.analyzePullRequest(testData, []);
    
    res.json({
      success: true,
      result: result,
      timestamp: new Date().toISOString()
    });
    
  } catch (error) {
    logger.error('AI test failed:', error);
    res.status(500).json({
      success: false,
      error: error.message,
      timestamp: new Date().toISOString()
    });
  }
});

/**
 * Dashboard route that serves the check run button dashboard
 * @param {Object} req - Express request object
 * @param {Object} res - Express response object
 */
app.get('/dashboard', (req, res) => {
  res.sendFile(path.join(__dirname, '../public/check-run-button-dashboard.html'));
});

app.use('/public', express.static(path.join(__dirname, '../public')));

app.use((error, req, res, next) => {
  logger.error('Unhandled error:', error);
  res.status(500).json({ 
    error: 'Internal server error',
    message: process.env.NODE_ENV === 'development' ? error.message : 'Something went wrong'
  });
});

app.use('*', (req, res) => {
  res.status(404).json({ 
    error: 'Not found',
    message: `Route ${req.method} ${req.originalUrl} not found`
  });
});

logStartup('Preparing to start HTTP server...');

const PORT = config.server.port;
logStartup(`Attempting to listen on port ${PORT}...`);

const server = app.listen(PORT, () => {
  logStartup(`✅ SERVER STARTED SUCCESSFULLY!`);
  logStartup(`GitHub AI Reviewer server running on port ${PORT}`);
  logStartup(`Webhook URL: http://localhost:${PORT}/webhook`);
  logStartup(`Health check: http://localhost:${PORT}/health`);
  logStartup(`Status endpoint: http://localhost:${PORT}/status`);
  logStartup(`Dashboard: http://localhost:${PORT}/dashboard`);
  logStartup(`Check Run Button API: http://localhost:${PORT}/api/check-runs/*`);
  logStartup(`Interactive button system enabled - PR analysis will create clickable buttons for comment posting`);
  
  if (logger) {
    logger.info(`GitHub AI Reviewer server running on port ${PORT}`);
    logger.info(`Webhook URL: http://localhost:${PORT}/webhook`);
    logger.info(`Health check: http://localhost:${PORT}/health`);
    logger.info(`Status endpoint: http://localhost:${PORT}/status`);
    logger.info(`Dashboard: http://localhost:${PORT}/dashboard`);
    logger.info(`Check Run Button API: http://localhost:${PORT}/api/check-runs/*`);
    logger.info(`Interactive button system enabled - PR analysis will create clickable buttons for comment posting`);
  }
});

server.on('error', (error) => {
  logStartup(`Server startup error: ${error.message}`, true);
  logStartup(`Error code: ${error.code}`, true);
  if (error.code === 'EADDRINUSE') {
    logStartup(`Port ${PORT} is already in use. Please check if another instance is running.`, true);
  }
  process.exit(1);
});

const shutdown = async () => {
  logger.info('Shutting down gracefully...');
  
  server.close(() => {
    logger.info('HTTP server closed');
  });

  if (webhookService.shutdown) {
    await webhookService.shutdown();
  }
  
  process.exit(0);
};

process.on('SIGINT', shutdown);
process.on('SIGTERM', shutdown);

process.on('unhandledRejection', (reason, promise) => {
  logger.error('Unhandled Rejection at:', promise, 'reason:', reason);
});

process.on('uncaughtException', (error) => {
  logger.error('Uncaught Exception:', error);
  process.exit(1);
});
