// src/config/config.js - Updated Configuration for Single Comment Format

require('dotenv').config();
const fs = require('fs');
const path = require('path');

// Handle private key for different deployment environments
function getPrivateKey() {
  if (process.env.GITHUB_PRIVATE_KEY_BASE64) {
    // Render/Cloud deployment: decode base64 key
    try {
      const privateKeyContent = Buffer.from(process.env.GITHUB_PRIVATE_KEY_BASE64, 'base64').toString('utf-8');
      
      // Basic validation
      if (!privateKeyContent.includes('BEGIN') || !privateKeyContent.includes('PRIVATE KEY')) {
        throw new Error('Invalid private key format after base64 decode');
      }
      
      return privateKeyContent;
    } catch (error) {
      throw new Error(`Failed to decode private key: ${error.message}`);
    }
  } else if (process.env.GITHUB_PRIVATE_KEY) {
    // Direct private key content
    return process.env.GITHUB_PRIVATE_KEY.replace(/\\n/g, '\n');
  } else if (process.env.GITHUB_PRIVATE_KEY_PATH && fs.existsSync(process.env.GITHUB_PRIVATE_KEY_PATH)) {
    // Local development: use file path
    return fs.readFileSync(process.env.GITHUB_PRIVATE_KEY_PATH, 'utf8');
  } else if (fs.existsSync('./private-key.pem')) {
    // Fallback to default location
    return fs.readFileSync('./private-key.pem', 'utf8');
  } else {
    throw new Error('GitHub private key not found. Set GITHUB_PRIVATE_KEY_BASE64 environment variable for cloud deployment.');
  }
}

const config = {
  server: {
    port: process.env.PORT || 10000, // Default to Render's port
    nodeEnv: process.env.NODE_ENV || 'production',
  },
  github: {
    appId: process.env.GITHUB_APP_ID,
    privateKey: getPrivateKey(), // Get key content directly
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

// Validation for required environment variables
const requiredEnvVars = [
  'GITHUB_APP_ID',
  'GITHUB_WEBHOOK_SECRET',
  'GITHUB_INSTALLATION_ID',
];

// Check AI provider requirements
if (config.ai.provider === 'openai' && !config.ai.openai.apiKey) {
  requiredEnvVars.push('OPENAI_API_KEY');
}

if (config.ai.provider === 'gemini' && !config.ai.gemini.apiKey) {
  requiredEnvVars.push('GEMINI_API_KEY');
}

// Private key requirement (check all possible methods)
const hasPrivateKey = process.env.GITHUB_PRIVATE_KEY_BASE64 || 
                     process.env.GITHUB_PRIVATE_KEY || 
                     (process.env.GITHUB_PRIVATE_KEY_PATH && fs.existsSync(process.env.GITHUB_PRIVATE_KEY_PATH)) ||
                     fs.existsSync('./private-key.pem');

if (!hasPrivateKey) {
  requiredEnvVars.push('GITHUB_PRIVATE_KEY_BASE64 (or GITHUB_PRIVATE_KEY_PATH)');
}

const missingVars = requiredEnvVars.filter(varName => {
  // Handle compound requirements
  if (varName.includes('(or')) {
    return false; // Skip compound checks, handled above
  }
  return !process.env[varName];
});

if (missingVars.length > 0) {
  console.error(`❌ Missing required environment variables: ${missingVars.join(', ')}`);
  console.error('Please check your .env file or Render environment variables');
  throw new Error(`Missing required environment variables: ${missingVars.join(', ')}`);
}

// Log configuration summary (for debugging)
if (config.logging.enableDebugMode) {
  console.log('🔧 Configuration Summary:');
  console.log(`  📡 Port: ${config.server.port}`);
  console.log(`  🤖 AI Provider: ${config.ai.provider}`);
  console.log(`  🔧 Environment: ${config.server.nodeEnv}`);
  console.log(`  📝 Single Comment Mode: ${config.review.singleCommentMode}`);
  console.log(`  📊 Max Files: ${config.review.maxFilesToAnalyze}`);
  console.log(`  🎯 Target Branches: ${config.review.targetBranches.join(', ')}`);
}

module.exports = config;