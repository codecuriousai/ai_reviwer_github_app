// src/config/config.js - Updated Configuration for Single Comment Format

require('dotenv').config();
const fs = require('fs');
const path = require('path');

// Enhanced logging function for startup
function logStartup(message, isError = false) {
  const timestamp = new Date().toISOString();
  const prefix = isError ? '❌ ERROR' : '✅ INFO';
  console.log(`${timestamp} [${prefix}]: ${message}`);
}

// Handle private key for different deployment environments
function getPrivateKey() {
  logStartup('Attempting to load GitHub private key...');
  
  if (process.env.GITHUB_PRIVATE_KEY_BASE64) {
    // Render/Cloud deployment: decode base64 key
    try {
      logStartup('Attempting to use base64 encoded private key from environment');
      const privateKeyContent = Buffer.from(process.env.GITHUB_PRIVATE_KEY_BASE64, 'base64').toString('utf-8');
      
      // Basic validation
      if (!privateKeyContent.includes('BEGIN') || !privateKeyContent.includes('PRIVATE KEY')) {
        throw new Error('Invalid private key format after base64 decode');
      }
      
      logStartup('Successfully decoded base64 private key');
      return privateKeyContent;
    } catch (error) {
      logStartup(`Failed to decode base64 private key: ${error.message}`, true);
      throw new Error(`Failed to decode private key: ${error.message}`);
    }
  } else if (process.env.GITHUB_PRIVATE_KEY) {
    // Direct private key content
    logStartup('Using direct private key from environment variable');
    return process.env.GITHUB_PRIVATE_KEY.replace(/\\n/g, '\n');
  } else if (process.env.GITHUB_PRIVATE_KEY_PATH && fs.existsSync(process.env.GITHUB_PRIVATE_KEY_PATH)) {
    // Local development: use file path
    logStartup(`Using private key from file: ${process.env.GITHUB_PRIVATE_KEY_PATH}`);
    return fs.readFileSync(process.env.GITHUB_PRIVATE_KEY_PATH, 'utf8');
  } else if (fs.existsSync('./private-key.pem')) {
    // Fallback to default location
    logStartup('Using private key from default location: ./private-key.pem');
    return fs.readFileSync('./private-key.pem', 'utf8');
  } else {
    logStartup('No private key found in any location', true);
    throw new Error('GitHub private key not found. Set GITHUB_PRIVATE_KEY_BASE64 environment variable for cloud deployment.');
  }
}

// Safely get private key with error handling
let privateKey;
try {
  privateKey = getPrivateKey();
  logStartup('Private key loaded and validated successfully');
} catch (error) {
  logStartup(`Private key loading failed: ${error.message}`, true);
  throw error;
}

const config = {
  server: {
    port: process.env.PORT || 10000, // Default to Render's port
    nodeEnv: process.env.NODE_ENV || 'production',
  },
  github: {
    appId: process.env.GITHUB_APP_ID,
    privateKey: privateKey, // Use the safely loaded key
    webhookSecret: process.env.GITHUB_WEBHOOK_SECRET,
    installationId: process.env.GITHUB_INSTALLATION_ID,
  },
  ai: {
    provider: process.env.AI_PROVIDER || 'openai',
    openai: {
      apiKey: process.env.OPENAI_API_KEY,
      model: process.env.OPENAI_MODEL || 'gpt-4-turbo-preview',
      maxTokens: parseInt(process.env.OPENAI_MAX_TOKENS) || 4000,
      temperature: parseFloat(process.env.OPENAI_TEMPERATURE) || 0.1,
    },
    gemini: {
      apiKey: process.env.GEMINI_API_KEY,
      model: process.env.GEMINI_MODEL || 'gemini-pro',
      maxTokens: parseInt(process.env.GEMINI_MAX_TOKENS) || 4000,
      temperature: parseFloat(process.env.GEMINI_TEMPERATURE) || 0.1,
    },
  },
  review: {
    targetBranches: (process.env.TARGET_BRANCHES || 'main,master,develop').split(','),
    excludeFiles: (process.env.EXCLUDE_FILES || '*.md,*.txt,*.json,package-lock.json,yarn.lock,*.log').split(','),
    maxFilesToAnalyze: parseInt(process.env.MAX_FILES_ANALYZE) || 15,
    maxFileSizeBytes: parseInt(process.env.MAX_FILE_SIZE) || 80000, // Reduced for faster processing
    maxConcurrentReviews: parseInt(process.env.MAX_CONCURRENT_REVIEWS) || 3,
    singleCommentMode: process.env.SINGLE_COMMENT_MODE !== 'false', // Default to true
    reAnalysisDelay: parseInt(process.env.REANALYSIS_DELAY) || 120000, // 2 minutes
  },
  logging: {
    level: process.env.LOG_LEVEL || 'info',
    enableFileLogging: process.env.ENABLE_FILE_LOGGING === 'true',
    enableDebugMode: process.env.ENABLE_DEBUG_MODE === 'true',
  },
  performance: {
    enableCaching: process.env.ENABLE_CACHING === 'true',
    cacheExpiryMinutes: parseInt(process.env.CACHE_EXPIRY_MINUTES) || 30,
    enableMetrics: process.env.ENABLE_METRICS === 'true',
  },
};

logStartup('Configuration object created successfully');

// Validation for required environment variables
const requiredEnvVars = [
  'GITHUB_APP_ID',
  'GITHUB_WEBHOOK_SECRET',
  'GITHUB_INSTALLATION_ID',
];

logStartup('Starting environment variable validation...');

// Check AI provider requirements
if (config.ai.provider === 'openai' && !config.ai.openai.apiKey) {
  requiredEnvVars.push('OPENAI_API_KEY');
}

if (config.ai.provider === 'gemini' && !config.ai.gemini.apiKey) {
  requiredEnvVars.push('GEMINI_API_KEY');
}

// Check which variables are actually missing
const missingVars = requiredEnvVars.filter(varName => {
  const value = process.env[varName];
  const isMissing = !value;
  
  if (isMissing) {
    logStartup(`Missing required environment variable: ${varName}`, true);
  } else {
    logStartup(`✓ Found environment variable: ${varName}`);
  }
  
  return isMissing;
});

if (missingVars.length > 0) {
  const errorMessage = `Missing required environment variables: ${missingVars.join(', ')}`;
  logStartup(errorMessage, true);
  logStartup('Please check your environment variables in Render dashboard', true);
  
  // Log available environment variables for debugging (without values)
  logStartup('Available environment variables:');
  Object.keys(process.env).forEach(key => {
    if (key.startsWith('GITHUB_') || key.startsWith('OPENAI_') || key.startsWith('GEMINI_') || key.startsWith('AI_')) {
      logStartup(`  - ${key}: ${process.env[key] ? '[SET]' : '[NOT SET]'}`);
    }
  });
  
  throw new Error(errorMessage);
}

logStartup('All required environment variables are present');

// Log configuration summary (for debugging)
logStartup('🔧 Configuration Summary:');
logStartup(`  📡 Port: ${config.server.port}`);
logStartup(`  🤖 AI Provider: ${config.ai.provider}`);
logStartup(`  🔧 Environment: ${config.server.nodeEnv}`);
logStartup(`  📝 Single Comment Mode: ${config.review.singleCommentMode}`);
logStartup(`  📊 Max Files: ${config.review.maxFilesToAnalyze}`);
logStartup(`  🎯 Target Branches: ${config.review.targetBranches.join(', ')}`);

logStartup('Configuration loaded successfully - ready to start server');

module.exports = config;