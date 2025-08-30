require('dotenv').config();

const config = {
  server: {
    port: process.env.PORT || 3000,
    nodeEnv: process.env.NODE_ENV || 'development',
  },
  github: {
    appId: process.env.GITHUB_APP_ID,
    privateKeyPath: process.env.GITHUB_PRIVATE_KEY_PATH,
    webhookSecret: process.env.GITHUB_WEBHOOK_SECRET,
    installationId: process.env.GITHUB_INSTALLATION_ID,
  },
  ai: {
    provider: process.env.AI_PROVIDER || 'openai', // 'openai' or 'gemini'
    openai: {
      apiKey: process.env.OPENAI_API_KEY,
      model: 'gpt-4-turbo-preview',
      maxTokens: 4000,
      temperature: 0.1,
    },
    gemini: {
      apiKey: process.env.GEMINI_API_KEY,
      model: 'gemini-pro',
      maxTokens: 4000,
      temperature: 0.1,
    },
  },
  sonar: {
    hostUrl: process.env.SONAR_HOST_URL,
    token: process.env.SONAR_TOKEN,
  },
  review: {
    targetBranches: ['main', 'master', 'develop'], // Branches to monitor
    excludeFiles: [
      '*.md',
      '*.txt',
      '*.json',
      'package-lock.json',
      'yarn.lock',
      '*.log',
    ],
    maxFilesToAnalyze: 20,
    maxFileSizeBytes: 100000, // 100KB
  },
};

// Validation
const requiredEnvVars = [
  'GITHUB_APP_ID',
  'GITHUB_PRIVATE_KEY_PATH',
  'GITHUB_WEBHOOK_SECRET',
];

if (config.ai.provider === 'openai' && !config.ai.openai.apiKey) {
  requiredEnvVars.push('OPENAI_API_KEY');
}

if (config.ai.provider === 'gemini' && !config.ai.gemini.apiKey) {
  requiredEnvVars.push('GEMINI_API_KEY');
}

const missingVars = requiredEnvVars.filter(varName => !process.env[varName]);
if (missingVars.length > 0) {
  throw new Error(`Missing required environment variables: ${missingVars.join(', ')}`);
}

module.exports = config;