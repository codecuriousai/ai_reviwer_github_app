const express = require('express');
const { Webhooks } = require('@octokit/webhooks');
const config = require('./config/config');
const logger = require('./utils/logger');
const webhookService = require('./services/webhook.service');
const authMiddleware = require('./middleware/auth.middleware');

const app = express();
const webhooks = new Webhooks({
  secret: config.github.webhookSecret,
});

// Middleware
app.use(express.json());
app.use(authMiddleware.verifyWebhook);

// Health check endpoint
app.get('/health', (req, res) => {
  res.status(200).json({ status: 'OK', timestamp: new Date().toISOString() });
});

// Webhook endpoint
app.post('/webhook', async (req, res) => {
  try {
    const signature = req.get('X-Hub-Signature-256');
    const event = req.get('X-GitHub-Event');
    const delivery = req.get('X-GitHub-Delivery');

    logger.info(`Received webhook: ${event}`, { delivery });

    // Verify webhook signature
    const isValid = webhooks.verify(req.body, signature);
    if (!isValid) {
      logger.error('Invalid webhook signature');
      return res.status(401).json({ error: 'Invalid signature' });
    }

    // Handle the webhook event
    await webhookService.handleWebhook(event, req.body);
    
    res.status(200).json({ message: 'Webhook processed successfully' });
  } catch (error) {
    logger.error('Error processing webhook:', error);
    res.status(500).json({ error: 'Internal server error' });
  }
});

// Error handling middleware
app.use((error, req, res, next) => {
  logger.error('Unhandled error:', error);
  res.status(500).json({ error: 'Internal server error' });
});

// Start server
const PORT = config.server.port;
app.listen(PORT, () => {
  logger.info(`GitHub AI Reviewer server running on port ${PORT}`);
  logger.info(`Webhook URL: http://localhost:${PORT}/webhook`);
});

// Graceful shutdown
process.on('SIGINT', () => {
  logger.info('Shutting down gracefully...');
  process.exit(0);
});

process.on('unhandledRejection', (reason, promise) => {
  logger.error('Unhandled Rejection at:', promise, 'reason:', reason);
});

process.on('uncaughtException', (error) => {
  logger.error('Uncaught Exception:', error);
  process.exit(1);
});