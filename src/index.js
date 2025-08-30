const express = require('express');
const config = require('./config/config');
const logger = require('./utils/logger');
const webhookService = require('./services/webhook.service');
const authMiddleware = require('./middleware/auth.middleware');

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

// Status endpoint for monitoring
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
  });
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