const winston = require('winston');

// Safe config loading with fallback
let config;
try {
  config = require('../config/config');
} catch (error) {
  // Fallback configuration if config fails
  config = {
    server: { nodeEnv: process.env.NODE_ENV || 'production' },
    logging: { 
      level: process.env.LOG_LEVEL || 'info',
      enableFileLogging: process.env.ENABLE_FILE_LOGGING === 'true'
    }
  };
}

// Create base transports (console is always available)
const transports = [
  new winston.transports.Console({
    format: winston.format.combine(
      winston.format.colorize(),
      winston.format.simple(),
      winston.format.printf(({ timestamp, level, message, ...meta }) => {
        let log = `${timestamp} [${level}]: ${message}`;
        if (Object.keys(meta).length > 0) {
          log += ` ${JSON.stringify(meta)}`;
        }
        return log;
      })
    ),
  })
];

// Add file transports only if enabled and possible
if (config.logging?.enableFileLogging) {
  try {
    // Create logs directory if it doesn't exist
    const fs = require('fs');
    if (!fs.existsSync('logs')) {
      fs.mkdirSync('logs');
    }

    // Add file transports
    transports.push(
      new winston.transports.File({
        filename: 'logs/error.log',
        level: 'error',
        format: winston.format.combine(
          winston.format.timestamp(),
          winston.format.json()
        ),
      }),
      new winston.transports.File({
        filename: 'logs/combined.log',
        format: winston.format.combine(
          winston.format.timestamp(),
          winston.format.json()
        ),
      })
    );
  } catch (error) {
    console.warn('File logging disabled - unable to create log files:', error.message);
  }
}

// Create logger instance
const logger = winston.createLogger({
  level: config.logging?.level || 'info',
  format: winston.format.combine(
    winston.format.timestamp(),
    winston.format.errors({ stack: true }),
    winston.format.json(),
    winston.format.prettyPrint()
  ),
  defaultMeta: { 
    service: 'github-ai-reviewer',
    environment: config.server?.nodeEnv || 'production'
  },
  transports
});

// Handle uncaught exceptions and rejections only if file logging is enabled
if (config.logging?.enableFileLogging) {
  try {
    logger.exceptions.handle(
      new winston.transports.File({ filename: 'logs/exceptions.log' })
    );
    logger.rejections.handle(
      new winston.transports.File({ filename: 'logs/rejections.log' })
    );
  } catch (error) {
    console.warn('Exception/rejection file logging disabled:', error.message);
  }
}

module.exports = logger;