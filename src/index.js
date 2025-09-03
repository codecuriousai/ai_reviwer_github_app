const express = require('express');
const config = require('./config/config');
const logger = require('./utils/logger');
const webhookService = require('./services/webhook.service');
const authMiddleware = require('./middleware/auth.middleware');
const checkRunButtonService = require('./services/check-run-button.service');
const path = require('path');
const app = express();

// Raw body parser for webhook signature verification
app.use('/webhook', express.raw({ type: 'application/json' }));

// JSON parser for other routes
app.use(express.json({ 
  verify: (req, res, buf) => {
    // Store raw body for signature verification
    req.rawBody = buf;
  }
}));

// Security headers
app.use(authMiddleware.securityHeaders);

// Request logging
app.use(authMiddleware.requestLogger);

// Enhanced health check endpoint with check run button stats
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

    // Test AI service connectivity
    try {
      const aiService = require('./services/ai.service');
      const aiHealthy = await aiService.checkHealth();
      health.aiService = aiHealthy ? 'OK' : 'ERROR';
    } catch (error) {
      health.aiService = 'ERROR';
      health.aiError = error.message;
    }

    // Test GitHub service connectivity
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

    // Check run button service stats
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

// Webhook endpoint
app.post('/webhook', async (req, res) => {
  try {
    const signature = req.get('X-Hub-Signature-256');
    const event = req.get('X-GitHub-Event');
    const delivery = req.get('X-GitHub-Delivery');

    // Validate required headers
    if (!signature || !event) {
      logger.warn('Missing required GitHub webhook headers', { 
        hasSignature: !!signature,
        hasEvent: !!event,
        hasDelivery: !!delivery 
      });
      return res.status(400).json({ error: 'Missing required headers' });
    }

    logger.info(`Received webhook: ${event}`, { delivery });

    // Verify webhook signature using raw body
    const payload = req.body; // This is the raw buffer
    const payloadString = payload.toString('utf8');
    
    // Verify signature
    const crypto = require('crypto');
    const expectedSignature = crypto
      .createHmac('sha256', config.github.webhookSecret)
      .update(payload)
      .digest('hex');

    const expectedSignatureBuffer = Buffer.from(`sha256=${expectedSignature}`, 'utf8');
    const actualSignatureBuffer = Buffer.from(signature, 'utf8');

    // Use timingSafeEqual to prevent timing attacks
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

    // Parse the JSON payload
    let parsedPayload;
    try {
      parsedPayload = JSON.parse(payloadString);
    } catch (parseError) {
      logger.error('Failed to parse webhook payload:', parseError);
      return res.status(400).json({ error: 'Invalid JSON payload' });
    }

    // Handle the webhook event
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

// Enhanced status endpoint with check run button stats
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
    system: {
      activeReviews: webhookStatus.activeReviews,
      queueSize: webhookStatus.queueSize,
      maxConcurrent: webhookStatus.maxConcurrent,
    }
  });
});

// NEW: Check run button management endpoints
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

// NEW: Get specific check run data
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

// NEW: Manual cleanup endpoint for check runs
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

// NEW: Test check run button creation (for development/debugging)
app.post('/debug/test-check-run-buttons', async (req, res) => {
  try {
    const { owner, repo, pullNumber, headSha } = req.body;
    
    if (!owner || !repo || !pullNumber || !headSha) {
      return res.status(400).json({
        error: 'Missing required fields: owner, repo, pullNumber, headSha'
      });
    }

    // Create test analysis data
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

// Debug endpoint for testing AI service directly
app.post('/debug/ai-test', async (req, res) => {
  try {
    const aiService = require('./services/ai.service');
    
    // Simple test data
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
+  var password = "hardcoded123";
+  console.log(password);
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

// Dashboard route - serve the check run button dashboard
app.get('/dashboard', (req, res) => {
  res.sendFile(path.join(__dirname, '../public/check-run-button-dashboard.html'));
});

// Static files for dashboard
app.use('/public', express.static(path.join(__dirname, '../public')));

// Error handling middleware
app.use((error, req, res, next) => {
  logger.error('Unhandled error:', error);
  res.status(500).json({ 
    error: 'Internal server error',
    message: process.env.NODE_ENV === 'development' ? error.message : 'Something went wrong'
  });
});

// 404 handler
app.use('*', (req, res) => {
  res.status(404).json({ 
    error: 'Not found',
    message: `Route ${req.method} ${req.originalUrl} not found`
  });
});

// Start server
const PORT = config.server.port;
const server = app.listen(PORT, () => {
  logger.info(`GitHub AI Reviewer server running on port ${PORT}`);
  logger.info(`Webhook URL: http://localhost:${PORT}/webhook`);
  logger.info(`Health check: http://localhost:${PORT}/health`);
  logger.info(`Status endpoint: http://localhost:${PORT}/status`);
  logger.info(`Dashboard: http://localhost:${PORT}/dashboard`);
  logger.info(`Check Run Button API: http://localhost:${PORT}/api/check-runs/*`);
  logger.info(`Interactive button system enabled - PR analysis will create clickable buttons for comment posting`);
});

// Graceful shutdown
const shutdown = async () => {
  logger.info('Shutting down gracefully...');
  
  // Close server
  server.close(() => {
    logger.info('HTTP server closed');
  });

  // Shutdown webhook service
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