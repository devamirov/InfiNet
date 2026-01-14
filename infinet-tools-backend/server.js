const express = require('express');
const cors = require('cors');
const multer = require('multer');
const path = require('path');
const fs = require('fs').promises;
require('dotenv').config();

// Import route handlers
const domainCheckRoutes = require('./routes/domain-check');
const whoisLookupRoutes = require('./routes/whois-lookup');
const qrCodeRoutes = require('./routes/qr-code');
const seoPreviewRoutes = require('./routes/seo-preview');
const businessNamesRoutes = require('./routes/business-names');
const colorPaletteRoutes = require('./routes/color-palette');
const utmGeneratorRoutes = require('./routes/utm-generator');
const speedTestRoutes = require('./routes/speed-test');
const ipLookupRoutes = require('./routes/ip-lookup');
const imageResizeRoutes = require('./routes/image-resize');
const faviconGeneratorRoutes = require('./routes/favicon-generator');
const urlShortenerRoutes = require('./routes/url-shortener');
const toolHistoryRoutes = require('./routes/tool-history');

const app = express();
const PORT = process.env.PORT || 3003;

// Track server start time for uptime calculation
const serverStartTime = Date.now();

// Create temp directory if it doesn't exist
const TEMP_DIR = path.join(__dirname, 'temp');
(async () => {
  try {
    await fs.mkdir(TEMP_DIR, { recursive: true });
  } catch (error) {
    console.error('Failed to create temp directory:', error);
  }
})();

// Middleware
const allowedOrigins = process.env.ALLOWED_ORIGINS 
  ? process.env.ALLOWED_ORIGINS.split(',')
  : '*';

app.use(cors({
  origin: allowedOrigins === '*' ? '*' : allowedOrigins,
  credentials: true
}));

app.use(express.json({ limit: '100mb' }));
app.use(express.urlencoded({ extended: true, limit: '100mb' }));

// Helper function to format uptime
function formatUptime(seconds) {
  const days = Math.floor(seconds / 86400);
  const hours = Math.floor((seconds % 86400) / 3600);
  const minutes = Math.floor((seconds % 3600) / 60);
  const secs = seconds % 60;

  if (days > 0) {
    return `${days}d ${hours}h ${minutes}m`;
  } else if (hours > 0) {
    return `${hours}h ${minutes}m ${secs}s`;
  } else if (minutes > 0) {
    return `${minutes}m ${secs}s`;
  } else {
    return `${secs}s`;
  }
}

// Health check endpoint with enhanced status
app.get('/api/health', async (req, res) => {
  const uptime = Math.floor((Date.now() - serverStartTime) / 1000); // seconds
  const health = {
    status: 'ok',
    service: 'infinet-tools-backend',
    version: '1.0.0',
    timestamp: new Date().toISOString(),
    uptime: {
      seconds: uptime,
      formatted: formatUptime(uptime)
    },
    checks: {
      database: 'unknown',
      tempDirectory: 'unknown'
    }
  };

  // Check database connectivity
  try {
    const ToolHistoryDB = require('./db/toolHistory');
    const testHistory = ToolHistoryDB.getHistory({ limit: 1 });
    health.checks.database = 'ok';
  } catch (error) {
    health.checks.database = 'error';
    health.status = 'degraded';
    health.databaseError = error.message;
  }

  // Check temp directory
  try {
    await fs.access(TEMP_DIR);
    health.checks.tempDirectory = 'ok';
  } catch (error) {
    health.checks.tempDirectory = 'error';
    health.status = 'degraded';
    health.tempDirectoryError = error.message;
  }

  const statusCode = health.status === 'ok' ? 200 : 503;
  res.status(statusCode).json(health);
});

// Routes
app.use('/api/tools/domain-check', domainCheckRoutes);
app.use('/api/tools/whois-lookup', whoisLookupRoutes);
app.use('/api/tools/qr', qrCodeRoutes);
app.use('/api/tools/seo-preview', seoPreviewRoutes);
app.use('/api/tools/business-names', businessNamesRoutes);
app.use('/api/tools/color-palette', colorPaletteRoutes);
app.use('/api/tools/utm-generator', utmGeneratorRoutes);
app.use('/api/tools/speed-test', speedTestRoutes);
app.use('/api/tools/ip-lookup', ipLookupRoutes);
app.use('/api/tools/resize-image', imageResizeRoutes);
app.use('/api/tools/generate-favicon', faviconGeneratorRoutes);
app.use('/api/tools/shorten-url', urlShortenerRoutes);
app.use('/api/tools/history', toolHistoryRoutes);

// Error handling middleware with enhanced error messages
app.use((err, req, res, next) => {
  console.error('Error:', err);
  
  // Don't send response if headers already sent
  if (res.headersSent) {
    return next(err);
  }

  const statusCode = err.status || 500;
  const message = err.message || 'An unexpected error occurred. Please try again later.';
  
  // Provide more helpful error messages based on error type
  let userMessage = message;
  if (statusCode === 500) {
    userMessage = 'An internal server error occurred. Our team has been notified. Please try again in a few moments.';
  } else if (statusCode === 404) {
    userMessage = 'The requested resource was not found. Please check the URL and try again.';
  }

  res.status(statusCode).json({
    error: userMessage,
    status: statusCode,
    timestamp: new Date().toISOString()
  });
});

// 404 handler with better message
app.use((req, res) => {
  res.status(404).json({
    error: `Endpoint not found: ${req.method} ${req.path}. Please check the API documentation.`,
    status: 404,
    timestamp: new Date().toISOString()
  });
});

// Start server
app.listen(PORT, () => {
  console.log(`🚀 InfiNet Tools Backend running on port ${PORT}`);
  console.log(`📍 Health check: http://localhost:${PORT}/api/health`);
});

module.exports = app;

