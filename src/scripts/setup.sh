#!/bin/bash

# GitHub AI Reviewer Startup Script

set -e  # Exit on any error

echo "🚀 Starting GitHub AI Reviewer..."

# Check if .env file exists
if [ ! -f .env ]; then
    echo "❌ Error: .env file not found"
    echo "Please copy .env.example to .env and configure your settings"
    exit 1
fi

# Check if private key exists
if [ ! -f private-key.pem ]; then
    echo "❌ Error: private-key.pem not found"
    echo "Please download your GitHub App private key and save it as private-key.pem"
    exit 1
fi

# Load environment variables
source .env

# Validate required environment variables
required_vars=("GITHUB_APP_ID" "GITHUB_WEBHOOK_SECRET" "AI_PROVIDER")

for var in "${required_vars[@]}"; do
    if [ -z "${!var}" ]; then
        echo "❌ Error: Required environment variable $var is not set"
        exit 1
    fi
done

# Validate AI provider and API keys
if [ "$AI_PROVIDER" = "openai" ] && [ -z "$OPENAI_API_KEY" ]; then
    echo "❌ Error: OPENAI_API_KEY is required when AI_PROVIDER is 'openai'"
    exit 1
elif [ "$AI_PROVIDER" = "gemini" ] && [ -z "$GEMINI_API_KEY" ]; then
    echo "❌ Error: GEMINI_API_KEY is required when AI_PROVIDER is 'gemini'"
    exit 1
fi

# Create logs directory if it doesn't exist
mkdir -p logs

# Check if Node.js is installed
if ! command -v node &> /dev/null; then
    echo "❌ Error: Node.js is not installed"
    echo "Please install Node.js 16+ and try again"
    exit 1
fi

# Check Node.js version
NODE_VERSION=$(node -v | cut -d'v' -f2 | cut -d'.' -f1)
if [ "$NODE_VERSION" -lt 16 ]; then
    echo "❌ Error: Node.js version 16+ is required (current: $(node -v))"
    exit 1
fi

# Install dependencies if node_modules doesn't exist
if [ ! -d "node_modules" ]; then
    echo "📦 Installing dependencies..."
    npm install
fi

# Run health checks
echo "🔍 Running pre-startup checks..."

# Check if port is available
if lsof -Pi :$PORT -sTCP:LISTEN -t >/dev/null ; then
    echo "❌ Error: Port $PORT is already in use"
    echo "Please stop the existing service or change the PORT in .env"
    exit 1
fi

# Test AI service connectivity
echo "🧠 Testing AI service connectivity..."
node -e "
const config = require('./src/config/config');
const OpenAI = require('openai');
const { GoogleGenerativeAI } = require('@google/generative-ai');

async function testAI() {
    try {
        if (config.ai.provider === 'openai') {
            const openai = new OpenAI({ apiKey: config.ai.openai.apiKey });
            await openai.chat.completions.create({
                model: 'gpt-3.5-turbo',
                messages: [{ role: 'user', content: 'test' }],
                max_tokens: 5
            });
            console.log('✅ OpenAI connection successful');
        } else if (config.ai.provider === 'gemini') {
            const gemini = new GoogleGenerativeAI(config.ai.gemini.apiKey);
            const model = gemini.getGenerativeModel({ model: 'gemini-pro' });
            await model.generateContent('test');
            console.log('✅ Gemini connection successful');
        }
    } catch (error) {
        console.error('❌ AI service test failed:', error.message);
        process.exit(1);
    }
}
testAI();
"

echo "✅ All checks passed!"
echo ""
echo "🌐 Starting server on port $PORT..."
echo "📡 Webhook endpoint: http://localhost:$PORT/webhook"
echo "❤️  Health check: http://localhost:$PORT/health"
echo ""

# Start the application
if [ "$NODE_ENV" = "production" ]; then
    echo "🚀 Starting in production mode..."
    npm start
else
    echo "🛠️  Starting in development mode..."
    npm run dev
fi