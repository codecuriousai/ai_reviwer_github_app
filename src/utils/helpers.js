const logger = require('./logger');

// Utility functions for the GitHub AI Reviewer

// Add delay function
const delay = (ms) => new Promise(resolve => setTimeout(resolve, ms));

// Truncate text to specific length
const truncateText = (text, maxLength = 1000) => {
  if (!text || text.length <= maxLength) return text;
  return text.substring(0, maxLength) + '...';
};

// Extract file extension
const getFileExtension = (filename) => {
  return filename.split('.').pop().toLowerCase();
};

// Check if file is a code file
const isCodeFile = (filename) => {
  const codeExtensions = [
    'js', 'jsx', 'ts', 'tsx', 'py', 'java', 'cpp', 'c', 'cs', 'php',
    'rb', 'go', 'rs', 'swift', 'kt', 'scala', 'dart', 'vue', 'svelte'
  ];
  
  const extension = getFileExtension(filename);
  return codeExtensions.includes(extension);
};

// Parse diff to extract line numbers and changes
const parseDiffForChanges = (diff) => {
  const lines = diff.split('\n');
  const changes = [];
  let currentFile = null;
  let currentLine = 0;

  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];
    
    // File header
    if (line.startsWith('diff --git')) {
      const match = line.match(/b\/(.+)$/);
      currentFile = match ? match[1] : null;
      continue;
    }
    
    // Line number info
    if (line.startsWith('@@')) {
      const match = line.match(/@@ -\d+,?\d* \+(\d+),?\d* @@/);
      currentLine = match ? parseInt(match[1]) : 0;
      continue;
    }
    
    // Skip file headers and context
    if (line.startsWith('---') || line.startsWith('+++') || line.startsWith('index')) {
      continue;
    }
    
    // Track additions and modifications
    if (line.startsWith('+') && !line.startsWith('+++')) {
      changes.push({
        file: currentFile,
        line: currentLine,
        change: line.substring(1),
        type: 'addition',
      });
      currentLine++;
    } else if (line.startsWith('-') && !line.startsWith('---')) {
      changes.push({
        file: currentFile,
        line: currentLine,
        change: line.substring(1),
        type: 'deletion',
      });
    } else if (!line.startsWith('-') && !line.startsWith('+')) {
      currentLine++;
    }
  }
  
  return changes;
};

// Format file size
const formatFileSize = (bytes) => {
  const sizes = ['Bytes', 'KB', 'MB', 'GB'];
  if (bytes === 0) return '0 Bytes';
  const i = Math.floor(Math.log(bytes) / Math.log(1024));
  return Math.round(bytes / Math.pow(1024, i) * 100) / 100 + ' ' + sizes[i];
};

// Calculate complexity score based on file changes
const calculateComplexityScore = (files) => {
  if (!files || files.length === 0) return 0;
  
  const totalChanges = files.reduce((sum, file) => sum + file.changes, 0);
  const avgChangesPerFile = totalChanges / files.length;
  
  // Simple complexity scoring
  if (avgChangesPerFile > 100) return 'HIGH';
  if (avgChangesPerFile > 50) return 'MEDIUM';
  return 'LOW';
};

// Extract code context around specific lines
const getCodeContext = (content, lineNumber, contextLines = 3) => {
  if (!content) return '';
  
  const lines = content.split('\n');
  const start = Math.max(0, lineNumber - contextLines - 1);
  const end = Math.min(lines.length, lineNumber + contextLines);
  
  return lines.slice(start, end).join('\n');
};

// Sanitize input for AI processing
const sanitizeForAI = (text) => {
  if (!text) return '';
  
  // Remove or escape potentially problematic characters
  return text
    .replace(/[\x00-\x1F\x7F-\x9F]/g, '') // Remove control characters
    .replace(/\r\n/g, '\n') // Normalize line endings
    .replace(/\\/g, '\\\\') // Escape backslashes
    .replace(/"/g, '\\"') // Escape quotes for JSON safety
    .trim();
};

// Retry function with exponential backoff
const retryWithBackoff = async (fn, maxRetries = 3, baseDelay = 1000) => {
  for (let i = 0; i < maxRetries; i++) {
    try {
      return await fn();
    } catch (error) {
      if (i === maxRetries - 1) throw error;
      
      const delayMs = baseDelay * Math.pow(2, i);
      logger.warn(`Retry attempt ${i + 1}/${maxRetries} failed, retrying in ${delayMs}ms:`, error.message);
      await delay(delayMs);
    }
  }
};

// Extract repository info from URL
const parseRepositoryUrl = (url) => {
  const match = url.match(/github\.com\/([^\/]+)\/([^\/]+)/);
  if (!match) return null;
  
  return {
    owner: match[1],
    repo: match[2].replace('.git', ''),
  };
};

// ENHANCED: Better JSON validation with detailed error reporting
const isValidJSON = (str) => {
  if (!str || typeof str !== 'string') {
    return false;
  }
  
  try {
    const parsed = JSON.parse(str);
    return typeof parsed === 'object' && parsed !== null;
  } catch (error) {
    logger.debug('JSON validation failed:', error.message);
    return false;
  }
};

// ENHANCED: Better JSON cleaning function
const cleanJSONResponse = (responseText) => {
  if (!responseText) return null;
  
  let cleaned = responseText.trim();
  
  // Remove markdown code blocks
  cleaned = cleaned.replace(/```json\s*/g, '').replace(/```\s*/g, '');
  
  // Remove any text before first {
  const firstBrace = cleaned.indexOf('{');
  if (firstBrace > 0) {
    cleaned = cleaned.substring(firstBrace);
  }
  
  // Remove any text after last }
  const lastBrace = cleaned.lastIndexOf('}');
  if (lastBrace >= 0 && lastBrace < cleaned.length - 1) {
    cleaned = cleaned.substring(0, lastBrace + 1);
  }
  
  // Clean common JSON issues
  cleaned = cleaned
    .replace(/\n\s*\/\/.*$/gm, '') // Remove single-line comments
    .replace(/\/\*[\s\S]*?\*\//g, '') // Remove multi-line comments
    .replace(/,(\s*[}\]])/g, '$1') // Remove trailing commas
    .replace(/(['"])\s*\n\s*\+\s*(['"])/g, '$1$2'); // Fix string concatenation
  
  return cleaned;
};

// Generate unique ID for tracking
const generateTrackingId = () => {
  return `ai-review-${Date.now()}-${Math.random().toString(36).substr(2, 9)}`;
};

// Validate email format
const isValidEmail = (email) => {
  const emailRegex = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
  return emailRegex.test(email);
};

// Clean file path for display
const cleanFilePath = (path) => {
  if (!path) return '';
  return path.replace(/^\/+/, '').replace(/\/+/g, '/');
};

// Extract language from file extension
const getLanguageFromFile = (filename) => {
  const extension = getFileExtension(filename);
  const languageMap = {
    'js': 'javascript',
    'jsx': 'javascript',
    'ts': 'typescript',
    'tsx': 'typescript',
    'py': 'python',
    'java': 'java',
    'cpp': 'cpp',
    'c': 'c',
    'cs': 'csharp',
    'php': 'php',
    'rb': 'ruby',
    'go': 'go',
    'rs': 'rust',
    'swift': 'swift',
    'kt': 'kotlin',
    'scala': 'scala',
    'dart': 'dart',
    'vue': 'vue',
    'svelte': 'svelte',
  };
  
  return languageMap[extension] || 'text';
};

module.exports = {
  delay,
  truncateText,
  getFileExtension,
  isCodeFile,
  parseDiffForChanges,
  formatFileSize,
  calculateComplexityScore,
  getCodeContext,
  sanitizeForAI,
  retryWithBackoff,
  parseRepositoryUrl,
  isValidJSON,
  cleanJSONResponse,
  generateTrackingId,
  isValidEmail,
  cleanFilePath,
  getLanguageFromFile,
};