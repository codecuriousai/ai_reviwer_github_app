const express = require('express');
const config = require('./config/config');
const logger = require('./utils/logger');
const webhookService = require('./services/webhook.service');
const authMiddleware = require('./middleware/auth.middleware');
const interactiveCommentService = require('./services/interactive-comment.service');

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

// Health check endpoint
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

    // Interactive comment service stats
    health.interactiveComments = interactiveCommentService.getStats();

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

// Enhanced status endpoint with interactive comment stats
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
    interactiveComments: webhookStatus.interactiveComments,
  });
});

// NEW: Interactive comment management endpoints
app.get('/api/comments/pending/:owner/:repo/:pullNumber', async (req, res) => {
  try {
    const { owner, repo, pullNumber } = req.params;
    const pendingComments = interactiveCommentService.getPendingComments(owner, repo, parseInt(pullNumber));
    
    if (!pendingComments) {
      return res.status(404).json({
        error: 'No pending comments found for this PR',
        pullNumber: parseInt(pullNumber)
      });
    }

    res.json({
      success: true,
      pullNumber: parseInt(pullNumber),
      trackingId: pendingComments.trackingId,
      totalFindings: pendingComments.findings.length,
      postedFindings: pendingComments.findings.filter(f => f.posted).length,
      pendingFindings: pendingComments.findings.filter(f => !f.posted).length,
      allPosted: pendingComments.allPosted,
      createdAt: pendingComments.createdAt,
      findings: pendingComments.findings
    });
  } catch (error) {
    logger.error('Error getting pending comments:', error);
    res.status(500).json({
      error: 'Failed to get pending comments',
      message: error.message
    });
  }
});

// NEW: Post individual comment endpoint
app.post('/api/comments/post-individual', async (req, res) => {
  try {
    const { owner, repo, pullNumber, findingId, triggeredBy } = req.body;

    if (!owner || !repo || !pullNumber || !findingId || !triggeredBy) {
      return res.status(400).json({
        error: 'Missing required fields: owner, repo, pullNumber, findingId, triggeredBy'
      });
    }

    const prKey = `${owner}/${repo}#${pullNumber}`;
    const pendingComments = interactiveCommentService.getPendingComments(owner, repo, pullNumber);
    
    if (!pendingComments) {
      return res.status(404).json({
        error: 'No pending comments found for this PR',
        pullNumber
      });
    }

    const finding = pendingComments.findings.find(f => f.id === findingId);
    if (!finding) {
      return res.status(404).json({
        error: 'Finding not found',
        findingId
      });
    }

    if (finding.posted) {
      return res.status(409).json({
        error: 'This finding has already been posted',
        findingId,
        commentId: finding.commentId
      });
    }

    // Post the individual comment
    await interactiveCommentService.postIndividualComment(owner, repo, pullNumber, finding, triggeredBy);

    res.json({
      success: true,
      message: 'Individual comment posted successfully',
      findingId,
      file: finding.file,
      line: finding.line,
      commentId: finding.commentId
    });

  } catch (error) {
    logger.error('Error posting individual comment:', error);
    res.status(500).json({
      error: 'Failed to post individual comment',
      message: error.message
    });
  }
});

// NEW: Post all comments endpoint
app.post('/api/comments/post-all', async (req, res) => {
  try {
    const { owner, repo, pullNumber, triggeredBy } = req.body;

    if (!owner || !repo || !pullNumber || !triggeredBy) {
      return res.status(400).json({
        error: 'Missing required fields: owner, repo, pullNumber, triggeredBy'
      });
    }

    const pendingComments = interactiveCommentService.getPendingComments(owner, repo, pullNumber);
    
    if (!pendingComments) {
      return res.status(404).json({
        error: 'No pending comments found for this PR',
        pullNumber
      });
    }

    if (pendingComments.allPosted) {
      return res.status(409).json({
        error: 'All comments have already been posted for this PR',
        pullNumber
      });
    }

    // Post all comments
    await interactiveCommentService.postAllComments(owner, repo, pullNumber, pendingComments, triggeredBy);

    const successCount = pendingComments.findings.filter(f => f.posted).length;
    const totalCount = pendingComments.findings.length;

    res.json({
      success: true,
      message: 'All comments posted successfully',
      totalFindings: totalCount,
      postedFindings: successCount,
      trackingId: pendingComments.trackingId
    });

  } catch (error) {
    logger.error('Error posting all comments:', error);
    res.status(500).json({
      error: 'Failed to post all comments',
      message: error.message
    });
  }
});

// NEW: Get interactive comment stats
app.get('/api/comments/stats', (req, res) => {
  try {
    const stats = interactiveCommentService.getStats();
    res.json({
      success: true,
      timestamp: new Date().toISOString(),
      stats
    });
  } catch (error) {
    logger.error('Error getting comment stats:', error);
    res.status(500).json({
      error: 'Failed to get comment stats',
      message: error.message
    });
  }
});

// NEW: Clean old pending comments (manual trigger for admin)
app.post('/api/comments/cleanup', (req, res) => {
  try {
    interactiveCommentService.cleanOldPendingComments();
    res.json({
      success: true,
      message: 'Cleanup completed',
      timestamp: new Date().toISOString()
    });
  } catch (error) {
    logger.error('Error cleaning comments:', error);
    res.status(500).json({
      error: 'Failed to clean comments',
      message: error.message
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
  logger.info(`Interactive Comments API: http://localhost:${PORT}/api/comments/*`);
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