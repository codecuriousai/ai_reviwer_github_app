const crypto = require('crypto');
const config = require('../config/config');
const logger = require('../utils/logger');

class AuthMiddleware {
  // Verify GitHub webhook signature
  verifyWebhook(req, res, next) {
    try {
      const signature = req.get('X-Hub-Signature-256');
      const event = req.get('X-GitHub-Event');
      
      if (!signature || !event) {
        logger.warn('Missing GitHub webhook headers');
        return res.status(400).json({ error: 'Missing required headers' });
      }

      // Skip verification for health check
      if (req.path === '/health') {
        return next();
      }

      const payload = JSON.stringify(req.body);
      const expectedSignature = crypto
        .createHmac('sha256', config.github.webhookSecret)
        .update(payload, 'utf8')
        .digest('hex');

      const expectedSignatureBuffer = Buffer.from(`sha256=${expectedSignature}`, 'utf8');
      const actualSignatureBuffer = Buffer.from(signature, 'utf8');

      // Use timingSafeEqual to prevent timing attacks
      if (expectedSignatureBuffer.length !== actualSignatureBuffer.length ||
          !crypto.timingSafeEqual(expectedSignatureBuffer, actualSignatureBuffer)) {
        logger.warn('Invalid webhook signature', { 
          event, 
          expectedLength: expectedSignatureBuffer.length,
          actualLength: actualSignatureBuffer.length 
        });
        return res.status(401).json({ error: 'Invalid signature' });
      }

      logger.info('Webhook signature verified', { event });
      next();
    } catch (error) {
      logger.error('Error verifying webhook signature:', error);
      res.status(500).json({ error: 'Authentication error' });
    }
  }

  // Verify GitHub installation access
  async verifyInstallation(installationId) {
    try {
      // This would typically verify the installation ID
      // against your GitHub app's installations
      return installationId === config.github.installationId;
    } catch (error) {
      logger.error('Error verifying installation:', error);
      return false;
    }
  }

  // Rate limiting middleware
  rateLimitMiddleware() {
    const requests = new Map();
    const windowMs = 15 * 60 * 1000; // 15 minutes
    const maxRequests = 100;

    return (req, res, next) => {
      const clientId = req.ip || 'unknown';
      const now = Date.now();
      
      // Clean old entries
      for (const [id, timestamps] of requests.entries()) {
        const recentTimestamps = timestamps.filter(time => now - time < windowMs);
        if (recentTimestamps.length === 0) {
          requests.delete(id);
        } else {
          requests.set(id, recentTimestamps);
        }
      }

      // Check current client
      const clientRequests = requests.get(clientId) || [];
      const recentRequests = clientRequests.filter(time => now - time < windowMs);

      if (recentRequests.length >= maxRequests) {
        logger.warn(`Rate limit exceeded for client: ${clientId}`);
        return res.status(429).json({ 
          error: 'Too many requests',
          retryAfter: Math.ceil(windowMs / 1000)
        });
      }

      // Add current request
      recentRequests.push(now);
      requests.set(clientId, recentRequests);
      
      next();
    };
  }
}

module.exports = new AuthMiddleware();