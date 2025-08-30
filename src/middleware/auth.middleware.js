const crypto = require('crypto');
const config = require('../config/config');
const logger = require('../utils/logger');

class AuthMiddleware {
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

  // Basic authentication for non-webhook endpoints
  basicAuth(req, res, next) {
    // Skip auth for health check and webhook endpoints
    if (req.path === '/health' || req.path === '/webhook' || req.path === '/status') {
      return next();
    }

    // Add basic auth logic here if needed for other endpoints
    next();
  }

  // Request logging middleware
  requestLogger(req, res, next) {
    const start = Date.now();
    
    // Log request
    logger.info(`${req.method} ${req.path}`, {
      ip: req.ip,
      userAgent: req.get('User-Agent'),
      contentType: req.get('Content-Type'),
      contentLength: req.get('Content-Length'),
    });

    // Log response when finished
    res.on('finish', () => {
      const duration = Date.now() - start;
      logger.info(`${req.method} ${req.path} - ${res.statusCode}`, {
        duration: `${duration}ms`,
        contentLength: res.get('Content-Length'),
      });
    });

    next();
  }

  // Webhook-specific validation
  validateWebhookHeaders(req, res, next) {
    const requiredHeaders = ['X-GitHub-Event', 'X-Hub-Signature-256', 'X-GitHub-Delivery'];
    const missingHeaders = requiredHeaders.filter(header => !req.get(header));
    
    if (missingHeaders.length > 0) {
      logger.warn('Missing webhook headers', { 
        missing: missingHeaders,
        received: Object.keys(req.headers).filter(h => h.startsWith('x-'))
      });
      return res.status(400).json({ 
        error: 'Missing required webhook headers',
        required: requiredHeaders,
        missing: missingHeaders
      });
    }
    
    next();
  }

  // Security headers middleware
  securityHeaders(req, res, next) {
    res.setHeader('X-Content-Type-Options', 'nosniff');
    res.setHeader('X-Frame-Options', 'DENY');
    res.setHeader('X-XSS-Protection', '1; mode=block');
    res.setHeader('Strict-Transport-Security', 'max-age=31536000; includeSubDomains');
    res.removeHeader('X-Powered-By');
    next();
  }
}

module.exports = new AuthMiddleware();