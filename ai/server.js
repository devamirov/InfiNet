const express = require('express');
const session = require('express-session');
const SQLiteStore = require('connect-sqlite3')(session);
const cookieParser = require('cookie-parser');
const path = require('path');
const fs = require('fs');
const crypto = require('crypto');
const sqlite3 = require('sqlite3').verbose();
const bcrypt = require('bcrypt');
const axios = require('axios');
const nodemailer = require('nodemailer');
const WebSocket = require('ws');
require('dotenv').config();

// Telegram Bot Configuration
const TELEGRAM_BOT_TOKEN = process.env.TELEGRAM_BOT_TOKEN || 'YOUR_TELEGRAM_BOT_TOKEN';
const TELEGRAM_CHAT_ID = process.env.TELEGRAM_CHAT_ID || 'YOUR_CHAT_ID'; // You need to set this

// Function to send Telegram notification
async function sendTelegramNotification(message) {
    if (!TELEGRAM_CHAT_ID || TELEGRAM_CHAT_ID === 'YOUR_CHAT_ID') {
        console.warn('Telegram chat ID not configured. Skipping notification.');
        return;
    }
    
    try {
        const url = `https://api.telegram.org/bot${TELEGRAM_BOT_TOKEN}/sendMessage`;
        const response = await axios.post(url, {
            chat_id: TELEGRAM_CHAT_ID,
            text: message,
            parse_mode: 'HTML'
        }, {
            headers: {
                'Content-Type': 'application/json'
            },
            timeout: 10000
        });
        console.log('Telegram notification sent successfully!');
        return response.data;
    } catch (error) {
        console.error('Error sending Telegram notification:', error.response?.data || error.message);
        throw error;
    }
}

// Function to get Telegram updates (to find chat ID)
async function getTelegramUpdates() {
    try {
        const url = `https://api.telegram.org/bot${TELEGRAM_BOT_TOKEN}/getUpdates`;
        const response = await axios.get(url);
        return response.data;
    } catch (error) {
        console.error('Error getting Telegram updates:', error.message);
        throw error;
    }
}
// #region agent log
function agentLog(payload) {
    try {
        const line = JSON.stringify({
            sessionId: 'debug-session',
            runId: payload.runId || 'run1',
            hypothesisId: payload.hypothesisId || 'H-backend',
            location: payload.location,
            message: payload.message,
            data: payload.data || {},
            timestamp: Date.now()
        }) + '\n';
        fs.appendFile('/Users/amirov/Desktop/fuck/.cursor/debug.log', line, () => {});
    } catch (e) {
        // swallow logging errors
    }
}
// #endregion

// OAuth (optional - only if credentials are provided)
let passport = null;
let GoogleStrategy = null;
try {
    if (process.env.GOOGLE_CLIENT_ID && process.env.GOOGLE_CLIENT_SECRET) {
        passport = require('passport');
        GoogleStrategy = require('passport-google-oauth20').Strategy;
    }
} catch (error) {
    console.log('OAuth packages not installed. Run: npm install passport passport-google-oauth20');
}

// Security: Rate limiting (simple in-memory store)
const rateLimitStore = new Map();
const BLOCKED_IPS = new Set([
    '115.50.139.164', // Known attacker from Dec 28, 2025
    // Add more blocked IPs here as needed
]);

// Rate limiting middleware
function rateLimit(maxRequests = 10, windowMs = 60000) {
    return (req, res, next) => {
        const ip = req.ip || req.connection.remoteAddress || req.headers['x-forwarded-for']?.split(',')[0] || 'unknown';
        
        // Check if IP is blocked
        if (BLOCKED_IPS.has(ip)) {
            console.warn(`[SECURITY] Blocked IP attempted access: ${ip}`);
            return res.status(403).json({ error: 'Access denied' });
        }
        
        const key = `${ip}:${req.path}`;
        const now = Date.now();
        const requests = rateLimitStore.get(key) || { count: 0, resetTime: now + windowMs };
        
        // Reset if window expired
        if (now > requests.resetTime) {
            requests.count = 0;
            requests.resetTime = now + windowMs;
        }
        
        // Check limit
        if (requests.count >= maxRequests) {
            console.warn(`[SECURITY] Rate limit exceeded for IP: ${ip}, Path: ${req.path}`);
            return res.status(429).json({ 
                error: 'Too many requests. Please try again later.',
                retryAfter: Math.ceil((requests.resetTime - now) / 1000)
            });
        }
        
        // Increment counter
        requests.count++;
        rateLimitStore.set(key, requests);
        
        // Clean up old entries periodically
        if (Math.random() < 0.01) { // 1% chance to clean up
            for (const [k, v] of rateLimitStore.entries()) {
                if (now > v.resetTime) {
                    rateLimitStore.delete(k);
                }
            }
        }
        
        next();
    };
}

// Input sanitization
function sanitizeInput(input) {
    if (typeof input !== 'string') return '';
    // Remove potentially dangerous characters and patterns
    return input
        .replace(/[<>\"']/g, '') // Remove HTML/script tags
        .replace(/\.\./g, '') // Remove path traversal
        .replace(/[;&|`$(){}[\]]/g, '') // Remove command injection chars
        .trim()
        .substring(0, 200); // Limit length
}

// ============================================
// IMAGE UPLOAD SECURITY VALIDATION
// ============================================

// Allowed image MIME types
const ALLOWED_MIME_TYPES = ['image/jpeg', 'image/jpg', 'image/png', 'image/webp'];
const ALLOWED_EXTENSIONS = ['.jpg', '.jpeg', '.png', '.webp'];

// Magic bytes (file signatures) for image validation
const IMAGE_SIGNATURES = {
    'image/jpeg': [
        Buffer.from([0xFF, 0xD8, 0xFF]), // JPEG signature
    ],
    'image/png': [
        Buffer.from([0x89, 0x50, 0x4E, 0x47, 0x0D, 0x0A, 0x1A, 0x0A]), // PNG signature
    ],
    'image/webp': [
        Buffer.from([0x52, 0x49, 0x46, 0x46]), // WebP RIFF header start (needs additional check)
    ]
};

// File size limits (in bytes)
const MAX_IMAGE_SIZE = 10 * 1024 * 1024; // 10MB
const MIN_IMAGE_SIZE = 100; // 100 bytes minimum

// Image dimension limits
const MAX_IMAGE_WIDTH = 8192; // 8K width
const MAX_IMAGE_HEIGHT = 8192; // 8K height
const MIN_IMAGE_DIMENSION = 1; // Minimum 1x1 pixel

/**
 * Validates image file signature (magic bytes)
 * @param {Buffer} buffer - Image file buffer
 * @returns {Object} - { valid: boolean, mimeType: string|null, error: string|null }
 */
function validateImageSignature(buffer) {
    if (!Buffer.isBuffer(buffer) || buffer.length < 8) {
        return { valid: false, mimeType: null, error: 'Invalid buffer or too small' };
    }

    const header = buffer.slice(0, 16); // Check first 16 bytes

    // Check PNG signature (most common)
    if (header.slice(0, 8).equals(IMAGE_SIGNATURES['image/png'][0])) {
        return { valid: true, mimeType: 'image/png', error: null };
    }

    // Check JPEG signature
    if (header.slice(0, 3).equals(IMAGE_SIGNATURES['image/jpeg'][0])) {
        return { valid: true, mimeType: 'image/jpeg', error: null };
    }

    // Check WebP signature (RIFF...WEBP)
    if (header.slice(0, 4).equals(IMAGE_SIGNATURES['image/webp'][0])) {
        const webpHeader = buffer.slice(8, 12);
        if (webpHeader && webpHeader.toString('ascii') === 'WEBP') {
            return { valid: true, mimeType: 'image/webp', error: null };
        }
    }

    return { valid: false, mimeType: null, error: 'File signature does not match any allowed image format' };
}

/**
 * Validates image dimensions (basic check using buffer size estimation)
 * Note: Full dimension validation requires image library like Sharp
 * @param {Buffer} buffer - Image file buffer
 * @returns {Object} - { valid: boolean, error: string|null }
 */
function validateImageSize(buffer) {
    if (!Buffer.isBuffer(buffer)) {
        return { valid: false, error: 'Invalid buffer' };
    }

    const size = buffer.length;

    if (size < MIN_IMAGE_SIZE) {
        return { valid: false, error: `Image too small (minimum ${MIN_IMAGE_SIZE} bytes)` };
    }

    if (size > MAX_IMAGE_SIZE) {
        return { valid: false, error: `Image too large (maximum ${MAX_IMAGE_SIZE / 1024 / 1024}MB)` };
    }

    return { valid: true, error: null };
}

/**
 * Sanitizes filename to prevent path traversal and injection attacks
 * @param {string} filename - Original filename
 * @param {string} mimeType - Detected MIME type
 * @returns {string} - Sanitized filename
 */
function sanitizeFilename(filename, mimeType) {
    if (!filename || typeof filename !== 'string') {
        filename = 'image';
    }

    // Remove path components
    filename = path.basename(filename);

    // Remove dangerous characters
    filename = filename.replace(/[^a-zA-Z0-9._-]/g, '_');

    // Remove leading dots
    filename = filename.replace(/^\.+/, '');

    // Limit length
    filename = filename.substring(0, 100);

    // Ensure valid extension based on MIME type
    const extMap = {
        'image/jpeg': '.jpg',
        'image/jpg': '.jpg',
        'image/png': '.png',
        'image/webp': '.webp'
    };

    const ext = extMap[mimeType] || '.png';
    const nameWithoutExt = filename.replace(/\.[^/.]+$/, '');

    return `${nameWithoutExt || 'image'}_${Date.now()}${ext}`;
}

/**
 * Validates and processes base64 image data
 * @param {string} imageBase64 - Base64 encoded image string
 * @returns {Object} - { valid: boolean, buffer: Buffer|null, mimeType: string|null, error: string|null }
 */
function validateImageUpload(imageBase64) {
    try {
        // Check if input is valid
        if (!imageBase64 || typeof imageBase64 !== 'string') {
            return { valid: false, buffer: null, mimeType: null, error: 'Invalid image data format' };
        }

        // Extract base64 data (remove data:image/...;base64, prefix if present)
        let base64Data = imageBase64;
        let declaredMimeType = null;

        if (imageBase64.includes(',')) {
            const parts = imageBase64.split(',');
            const dataUriPrefix = parts[0];
            base64Data = parts[1];

            // Extract MIME type from data URI if present
            const mimeMatch = dataUriPrefix.match(/data:([^;]+)/);
            if (mimeMatch) {
                declaredMimeType = mimeMatch[1].toLowerCase();
                // Normalize jpeg to jpg
                if (declaredMimeType === 'image/jpeg') {
                    declaredMimeType = 'image/jpg';
                }
            }
        }

        // Validate base64 format
        if (!/^[A-Za-z0-9+/=]+$/.test(base64Data)) {
            return { valid: false, buffer: null, mimeType: null, error: 'Invalid base64 format' };
        }

        // Decode base64 to buffer
        let imageBuffer;
        try {
            imageBuffer = Buffer.from(base64Data, 'base64');
        } catch (error) {
            return { valid: false, buffer: null, mimeType: null, error: 'Failed to decode base64 data' };
        }

        // Validate file size
        const sizeValidation = validateImageSize(imageBuffer);
        if (!sizeValidation.valid) {
            return { valid: false, buffer: null, mimeType: null, error: sizeValidation.error };
        }

        // Validate file signature (magic bytes)
        const signatureValidation = validateImageSignature(imageBuffer);
        if (!signatureValidation.valid) {
            console.warn(`[SECURITY] Invalid image signature - ${signatureValidation.error}`, {
                declaredMimeType,
                bufferSize: imageBuffer.length
            });
            return { valid: false, buffer: null, mimeType: null, error: signatureValidation.error || 'Invalid image file signature' };
        }

        const detectedMimeType = signatureValidation.mimeType;

        // Verify declared MIME type matches detected type (if declared)
        if (declaredMimeType && declaredMimeType !== detectedMimeType) {
            console.warn(`[SECURITY] MIME type mismatch - declared: ${declaredMimeType}, detected: ${detectedMimeType}`);
            return { valid: false, buffer: null, mimeType: null, error: 'Declared MIME type does not match file signature' };
        }

        // Verify MIME type is in whitelist
        if (!ALLOWED_MIME_TYPES.includes(detectedMimeType)) {
            return { valid: false, buffer: null, mimeType: null, error: `Image type ${detectedMimeType} is not allowed` };
        }

        return { valid: true, buffer: imageBuffer, mimeType: detectedMimeType, error: null };

    } catch (error) {
        console.error('[SECURITY] Image validation error:', error);
        return { valid: false, buffer: null, mimeType: null, error: `Validation error: ${error.message}` };
    }
}

// Enhanced logging
function logSecurityEvent(type, req, details = {}) {
    const ip = req.ip || req.connection.remoteAddress || req.headers['x-forwarded-for']?.split(',')[0] || 'unknown';
    const timestamp = new Date().toISOString();
    const logEntry = {
        timestamp,
        type,
        ip,
        path: req.path,
        method: req.method,
        userAgent: req.headers['user-agent'],
        ...details
    };
    console.log(`[SECURITY] ${JSON.stringify(logEntry)}`);
    
    // Optionally write to a security log file
    try {
        const logFile = path.join(__dirname, 'security.log');
        fs.appendFileSync(logFile, JSON.stringify(logEntry) + '\n');
    } catch (err) {
        // Ignore log file errors
    }
}

const app = express();
const PORT = process.env.PORT || 3004;

// Admin configuration from environment variables (MUST be before routes that use it)
// Admin credentials: prefer environment variables; fall back to the provided static values
// to avoid random passwords on restart. Set ADMIN_USERNAME/ADMIN_PASSWORD in .env or PM2.
const ADMIN_USERNAME = process.env.ADMIN_USERNAME || 'YOUR_ADMIN_USERNAME';
const ADMIN_PASSWORD = process.env.ADMIN_PASSWORD || 'YOUR_ADMIN_PASSWORD';
const ADMIN_IP_WHITELIST = (process.env.ADMIN_IP_WHITELIST || '').split(',').filter(ip => ip.trim());

// Admin authentication middleware for HTML pages (triggers browser Basic Auth prompt)
function requireAdminHTML(req, res, next) {
    const ip = req.ip || req.connection.remoteAddress || req.headers['x-forwarded-for']?.split(',')[0] || 'unknown';
    
    // Check if IP is blocked
    if (BLOCKED_IPS.has(ip)) {
        logSecurityEvent('BLOCKED_IP_ATTEMPT', req, { ip });
        return res.status(403).send('Access denied');
    }
    
    // IP whitelist check (if configured)
    if (ADMIN_IP_WHITELIST.length > 0 && !ADMIN_IP_WHITELIST.includes(ip)) {
        logSecurityEvent('UNAUTHORIZED_IP_ATTEMPT', req, { ip, whitelist: ADMIN_IP_WHITELIST });
        return res.status(403).send('Access denied: IP not whitelisted');
    }
    
    const authHeader = req.headers.authorization;
    if (!authHeader || !authHeader.startsWith('Basic ')) {
        logSecurityEvent('ADMIN_AUTH_FAILED', req, { reason: 'Missing or invalid auth header' });
        res.setHeader('WWW-Authenticate', 'Basic realm="Admin Area"');
        return res.status(401).send('Authentication required');
    }
    
    try {
        const credentials = Buffer.from(authHeader.split(' ')[1], 'base64').toString('utf8');
        let [username, password] = credentials.split(':');
        
        // Trim whitespace from username and password (handles browser encoding issues)
        username = username.trim();
        password = password.trim();
        
        // Compare with trimmed expected values
        const expectedUsername = String(ADMIN_USERNAME).trim();
        const expectedPassword = String(ADMIN_PASSWORD).trim();
        
        if (username === expectedUsername && password === expectedPassword) {
            logSecurityEvent('ADMIN_AUTH_SUCCESS', req, { username });
            next();
        } else {
            logSecurityEvent('ADMIN_AUTH_FAILED', req, { reason: 'Invalid credentials', username });
            res.setHeader('WWW-Authenticate', 'Basic realm="Admin Area"');
            res.status(401).send('Invalid credentials');
        }
    } catch (error) {
        logSecurityEvent('ADMIN_AUTH_ERROR', req, { error: error.message });
        res.setHeader('WWW-Authenticate', 'Basic realm="Admin Area"');
        res.status(401).send('Invalid authentication format');
    }
}

// Middleware
app.use(cookieParser());
// Body size limits - 12MB to accommodate base64 encoded images (10MB image ≈ 13.3MB base64)
app.use(express.json({ limit: '12mb' }));
app.use(express.urlencoded({ extended: true, limit: '12mb' }));

// Admin route MUST be before static middleware to prevent bypassing authentication
app.get("/admin", requireAdminHTML, (req, res) => {
    res.sendFile(path.join(__dirname, "admin", "index.html"));
});

// Root route MUST be before static middleware to prevent it from serving wrong file
app.get('/', (req, res) => {
    const indexPath = path.join(__dirname, 'index.html');
    // Prevent stale caches from serving old admin page
    res.setHeader('Cache-Control', 'no-cache, no-store, must-revalidate');
    res.setHeader('Pragma', 'no-cache');
    res.setHeader('Expires', '0');
    res.sendFile(indexPath);
});

// Explicit route for untrans1.PNG (input field icon) with proper headers for mobile compatibility (must be before static middleware)
app.get('/untrans1.PNG', (req, res) => {
    const filePath = path.join(__dirname, 'untrans1.PNG');
    if (!fs.existsSync(filePath)) {
        console.error('untrans1.PNG not found at:', filePath);
        return res.status(404).send('Not found');
    }
    res.type('image/png');
    // Aggressive no-cache headers to force mobile browsers to bypass cache
    res.setHeader('Cache-Control', 'no-cache, no-store, must-revalidate, max-age=0, private');
    res.setHeader('Pragma', 'no-cache');
    res.setHeader('Expires', '0');
    res.setHeader('Last-Modified', new Date().toUTCString());
    res.setHeader('ETag', `"untrans1-${Date.now()}"`); // Dynamic ETag to prevent caching
    res.setHeader('Access-Control-Allow-Origin', '*');
    res.setHeader('Access-Control-Allow-Methods', 'GET');
    res.sendFile(filePath, (err) => {
        if (err) {
            console.error('Error serving untrans1.PNG:', err);
            res.status(500).send('Error serving file');
        }
    });
});

// Also handle lowercase version for mobile compatibility
app.get('/untrans1.png', (req, res) => {
    const filePath = path.join(__dirname, 'untrans1.PNG');
    if (!fs.existsSync(filePath)) {
        console.error('untrans1.PNG not found at:', filePath);
        return res.status(404).send('Not found');
    }
    res.type('image/png');
    res.setHeader('Cache-Control', 'no-cache, no-store, must-revalidate, max-age=0, private');
    res.setHeader('Pragma', 'no-cache');
    res.setHeader('Expires', '0');
    res.setHeader('Last-Modified', new Date().toUTCString());
    res.setHeader('ETag', `"untrans1-${Date.now()}"`);
    res.setHeader('Access-Control-Allow-Origin', '*');
    res.setHeader('Access-Control-Allow-Methods', 'GET');
    res.sendFile(filePath, (err) => {
        if (err) {
            console.error('Error serving untrans1.PNG:', err);
            res.status(500).send('Error serving file');
        }
    });
});

// Explicit route for untrans.PNG with proper headers for mobile compatibility (must be before static middleware)
// Handle both uppercase and lowercase for mobile browser compatibility
app.get('/untrans.PNG', (req, res) => {
    const filePath = path.join(__dirname, 'untrans.PNG');
    if (!fs.existsSync(filePath)) {
        console.error('untrans.PNG not found at:', filePath);
        return res.status(404).send('Not found');
    }
    res.type('image/png');
    // Aggressive no-cache headers to force mobile browsers to bypass cache
    res.setHeader('Cache-Control', 'no-cache, no-store, must-revalidate, max-age=0, private');
    res.setHeader('Pragma', 'no-cache');
    res.setHeader('Expires', '0');
    res.setHeader('Last-Modified', new Date().toUTCString());
    res.setHeader('ETag', `"untrans-${Date.now()}"`); // Dynamic ETag to prevent caching
    res.setHeader('Access-Control-Allow-Origin', '*');
    res.setHeader('Access-Control-Allow-Methods', 'GET');
    res.sendFile(filePath, (err) => {
        if (err) {
            console.error('Error serving untrans.PNG:', err);
            res.status(500).send('Error serving file');
        }
    });
});

// Also handle lowercase version for mobile compatibility
app.get('/untrans.png', (req, res) => {
    const filePath = path.join(__dirname, 'untrans.PNG');
    if (!fs.existsSync(filePath)) {
        console.error('untrans.PNG not found at:', filePath);
        return res.status(404).send('Not found');
    }
    res.type('image/png');
    res.setHeader('Cache-Control', 'no-cache, no-store, must-revalidate, max-age=0, private');
    res.setHeader('Pragma', 'no-cache');
    res.setHeader('Expires', '0');
    res.setHeader('Last-Modified', new Date().toUTCString());
    res.setHeader('ETag', `"untrans-${Date.now()}"`);
    res.setHeader('Access-Control-Allow-Origin', '*');
    res.setHeader('Access-Control-Allow-Methods', 'GET');
    res.sendFile(filePath, (err) => {
        if (err) {
            console.error('Error serving untrans.PNG:', err);
            res.status(500).send('Error serving file');
        }
    });
});

app.use(express.static('public'));
app.use(express.static(__dirname, { index: false })); // Serve static files from root directory (for images like ghost.JPG, logo.PNG) - disable index.html auto-serving

// Security: Trust proxy for accurate IP detection
app.set('trust proxy', 1);

// Security: Apply rate limiting to all API routes
app.use('/api/', rateLimit(100, 60000)); // 100 requests per minute for general API

// Session configuration (MUST be before Passport)
// Use SQLite for persistent session storage (survives server restarts)
const sessionStore = new SQLiteStore({
    db: 'sessions.db',
    dir: './data',
    table: 'sessions'
});

app.use(session({
    store: sessionStore, // Use SQLite instead of MemoryStore
    secret: process.env.SESSION_SECRET || 'your-secret-key-change-this',
    resave: false, // Don't resave unchanged sessions
    saveUninitialized: false, // Don't save uninitialized sessions
    rolling: true, // Reset expiration on every request
    cookie: { 
        secure: false, // Set to true in production with HTTPS
        maxAge: 7 * 24 * 60 * 60 * 1000, // 7 days
        httpOnly: true,
        sameSite: 'lax'
    }
}));

// Initialize Passport if OAuth is configured (AFTER session middleware)
if (passport && GoogleStrategy) {
    app.use(passport.initialize());
    app.use(passport.session());
    
    // Configure Google OAuth Strategy
    passport.use(new GoogleStrategy({
        clientID: process.env.GOOGLE_CLIENT_ID,
        clientSecret: process.env.GOOGLE_CLIENT_SECRET,
        callbackURL: process.env.GOOGLE_CALLBACK_URL || 'https://ai.infinet.services/api/auth/google/callback'
    },
    async (accessToken, refreshToken, profile, done) => {
        try {
            // Extract Google profile picture URL
            // Google OAuth profile.photos is an array of objects with 'value' property
            const googleProfilePicture = profile.photos && profile.photos.length > 0 
                ? profile.photos[0].value 
                : null;
            const googleDisplayName = profile.displayName || profile.name?.givenName || null;
            
            console.log('Google OAuth Profile:', {
                id: profile.id,
                email: profile.emails?.[0]?.value,
                displayName: googleDisplayName,
                profilePicture: googleProfilePicture,
                photos: profile.photos
            });
            
            // Check if user exists by Google ID
            db.get('SELECT * FROM users WHERE google_id = ?', [profile.id], (err, user) => {
                if (err) return done(err);
                
                if (user) {
                    // User exists - only update with Google data if user hasn't set custom values
                    // Preserve user's custom display_name and profile_picture if they exist
                    const newProfilePicture = (user.profile_picture && user.profile_picture.trim() !== '') 
                        ? user.profile_picture 
                        : (googleProfilePicture || user.profile_picture);
                    const newDisplayName = (user.display_name && user.display_name.trim() !== '') 
                        ? user.display_name 
                        : (googleDisplayName || user.display_name);
                    
                    console.log('Updating existing user (preserving custom values):', {
                        userId: user.id,
                        oldPicture: user.profile_picture,
                        newPicture: newProfilePicture,
                        oldName: user.display_name,
                        newName: newDisplayName,
                        preservingPicture: (user.profile_picture && user.profile_picture.trim() !== ''),
                        preservingName: (user.display_name && user.display_name.trim() !== '')
                    });
                    
                    // Only update if values actually changed
                    if (newProfilePicture !== user.profile_picture || newDisplayName !== user.display_name) {
                        db.run(
                            'UPDATE users SET profile_picture = ?, display_name = ?, updated_at = CURRENT_TIMESTAMP WHERE id = ?',
                            [newProfilePicture, newDisplayName, user.id],
                            function(err) {
                                if (err) {
                                    console.error('Error updating user profile:', err);
                                    return done(err);
                                }
                                // Update user object
                                user.profile_picture = newProfilePicture;
                                user.display_name = newDisplayName;
                                console.log('User profile updated successfully');
                                return done(null, user);
                            }
                        );
                    } else {
                        console.log('No profile changes needed, preserving existing values');
                        return done(null, user);
                    }
                } else {
                    // Check if email already exists
                    db.get('SELECT * FROM users WHERE email = ?', [profile.emails[0].value], (err, existingUser) => {
                        if (err) return done(err);
                        
                        if (existingUser) {
                            // Email exists, link Google account
                            // Preserve user's custom display_name and profile_picture if they exist
                            const linkProfilePicture = (existingUser.profile_picture && existingUser.profile_picture.trim() !== '') 
                                ? existingUser.profile_picture 
                                : (googleProfilePicture || existingUser.profile_picture);
                            const linkDisplayName = (existingUser.display_name && existingUser.display_name.trim() !== '') 
                                ? existingUser.display_name 
                                : (googleDisplayName || existingUser.display_name);
                            
                            console.log('Linking Google account (preserving custom values):', {
                                userId: existingUser.id,
                                preservingPicture: (existingUser.profile_picture && existingUser.profile_picture.trim() !== ''),
                                preservingName: (existingUser.display_name && existingUser.display_name.trim() !== '')
                            });
                            
                            db.run(
                                'UPDATE users SET google_id = ?, profile_picture = ?, display_name = ?, email_verified = 1, updated_at = CURRENT_TIMESTAMP WHERE id = ?',
                                [profile.id, linkProfilePicture, linkDisplayName, existingUser.id],
                                function(err) {
                                    if (err) return done(err);
                                    existingUser.google_id = profile.id;
                                    existingUser.profile_picture = linkProfilePicture;
                                    existingUser.display_name = linkDisplayName;
                                    existingUser.email_verified = 1;
                                    return done(null, existingUser);
                                }
                            );
                        } else {
                            // New user, create account
                            db.run(
                                'INSERT INTO users (email, google_id, profile_picture, display_name, email_verified, plan) VALUES (?, ?, ?, ?, ?, ?)',
                                [profile.emails[0].value, profile.id, googleProfilePicture, googleDisplayName, 1, 'free'],
                                function(err) {
                                    if (err) return done(err);
                                    const userId = this.lastID;
                                    
                                    // Initialize tokens for new user
                                    initializeUserTokens(userId, 'free', (initErr, tokens) => {
                                        if (initErr) {
                                            console.error('Error initializing tokens for Google user:', initErr);
                                        } else {
                                            console.log(`Initialized ${tokens} tokens for Google user ${userId}`);
                                        }
                                    });
                                    
                                    // Send Telegram notification for new Google OAuth registration
                                    console.log('📱 Sending Telegram notification for new Google OAuth user:', profile.emails[0].value);
                                    const telegramMessage = `🎉 <b>New User Registered (Google OAuth)!</b>\n\n` +
                                        `📧 <b>Email:</b> ${profile.emails[0].value}\n` +
                                        `👤 <b>Display Name:</b> ${googleDisplayName || 'Not set'}\n` +
                                        `🔗 <b>Auth Method:</b> Google OAuth\n` +
                                        `📦 <b>Plan:</b> free\n` +
                                        `🆔 <b>User ID:</b> ${userId}\n` +
                                        `📅 <b>Date:</b> ${new Date().toLocaleString()}`;
                                    
                                    sendTelegramNotification(telegramMessage)
                                        .then(() => {
                                            console.log('✅ Telegram notification sent successfully for Google OAuth user');
                                        })
                                        .catch(err => {
                                            console.error('❌ Failed to send Telegram notification for Google OAuth registration:', err.message);
                                        });
                                    
                                    const newUser = {
                                        id: userId,
                                        email: profile.emails[0].value,
                                        google_id: profile.id,
                                        profile_picture: profile.photos[0]?.value,
                                        display_name: profile.displayName,
                                        email_verified: 1,
                                        plan: 'free'
                                    };
                                    return done(null, newUser);
                                }
                            );
                        }
                    });
                }
            });
        } catch (error) {
            return done(error);
        }
    }));
    
    // Serialize user for session
    passport.serializeUser((user, done) => {
        done(null, user.id);
    });
    
    // Deserialize user from session
    passport.deserializeUser((id, done) => {
        db.get('SELECT * FROM users WHERE id = ?', [id], (err, user) => {
            done(err, user);
        });
    });
}

// Database initialization
const dbPath = process.env.DB_PATH || './data/database.db';
const db = new sqlite3.Database(dbPath);

// Initialize database tables
db.serialize(() => {
    // Users table (updated with new fields)
    db.run(`CREATE TABLE IF NOT EXISTS users (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        email TEXT UNIQUE NOT NULL,
        password TEXT,
        plan TEXT DEFAULT 'free',
        profile_picture TEXT,
        display_name TEXT,
        bio TEXT,
        email_verified INTEGER DEFAULT 0,
        google_id TEXT UNIQUE,
        created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
        updated_at DATETIME DEFAULT CURRENT_TIMESTAMP
    )`);
    
    // Add new columns to existing users table if they don't exist
    db.run(`ALTER TABLE users ADD COLUMN profile_picture TEXT`, () => {});
    db.run(`ALTER TABLE users ADD COLUMN display_name TEXT`, () => {});
    db.run(`ALTER TABLE users ADD COLUMN bio TEXT`, () => {});
    db.run(`ALTER TABLE users ADD COLUMN email_verified INTEGER DEFAULT 0`, () => {});
    db.run(`ALTER TABLE users ADD COLUMN google_id TEXT UNIQUE`, () => {});
    db.run(`ALTER TABLE users ADD COLUMN updated_at DATETIME DEFAULT CURRENT_TIMESTAMP`, () => {});
    db.run(`ALTER TABLE users ADD COLUMN tokens INTEGER DEFAULT 10000`, () => {}); // Default 10K tokens for free plan

    // API usage tracking
    db.run(`CREATE TABLE IF NOT EXISTS api_usage (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        user_id INTEGER NOT NULL,
        api_calls INTEGER DEFAULT 0,
        month INTEGER NOT NULL,
        year INTEGER NOT NULL,
        FOREIGN KEY (user_id) REFERENCES users(id)
    )`);

    // Chat history (legacy - kept for backward compatibility)
    db.run(`CREATE TABLE IF NOT EXISTS chat_history (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        user_id INTEGER NOT NULL,
        message TEXT NOT NULL,
        response TEXT,
        model TEXT,
        created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
        FOREIGN KEY (user_id) REFERENCES users(id)
    )`);

    // Conversations table (new - for conversation-level storage)
    db.run(`CREATE TABLE IF NOT EXISTS conversations (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        user_id INTEGER NOT NULL,
        title TEXT,
        model TEXT DEFAULT 'model2',
        created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
        updated_at DATETIME DEFAULT CURRENT_TIMESTAMP,
        FOREIGN KEY (user_id) REFERENCES users(id)
    )`);

    // Messages table (new - for message-level storage)
    db.run(`CREATE TABLE IF NOT EXISTS messages (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        conversation_id INTEGER NOT NULL,
        role TEXT NOT NULL,
        content TEXT NOT NULL,
        created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
        FOREIGN KEY (conversation_id) REFERENCES conversations(id) ON DELETE CASCADE
    )`);

    // Email verifications table
    db.run(`CREATE TABLE IF NOT EXISTS email_verifications (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        user_id INTEGER,
        email TEXT NOT NULL,
        code TEXT NOT NULL,
        expires_at DATETIME NOT NULL,
        verified_at DATETIME,
        created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
        FOREIGN KEY (user_id) REFERENCES users(id)
    )`);

    // Password reset tokens table
    db.run(`CREATE TABLE IF NOT EXISTS password_reset_tokens (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        user_id INTEGER NOT NULL,
        token TEXT UNIQUE NOT NULL,
        expires_at DATETIME NOT NULL,
        used_at DATETIME,
        created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
        FOREIGN KEY (user_id) REFERENCES users(id)
    )`);

    // Token usage tracking table
    db.run(`CREATE TABLE IF NOT EXISTS token_usage (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        user_id INTEGER NOT NULL,
        operation_type TEXT NOT NULL,
        tokens_used INTEGER NOT NULL,
        input_tokens INTEGER DEFAULT 0,
        output_tokens INTEGER DEFAULT 0,
        created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
        FOREIGN KEY (user_id) REFERENCES users(id)
    )`);

    // IP-based token tracking table (for non-authenticated users) - now device-based
    db.run(`CREATE TABLE IF NOT EXISTS ip_token_tracking (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        ip_address TEXT NOT NULL,
        device_fingerprint TEXT NOT NULL,
        tokens_used INTEGER DEFAULT 0,
        tokens_allocated INTEGER DEFAULT 10000,
        last_used_at DATETIME DEFAULT CURRENT_TIMESTAMP,
        created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
        UNIQUE(ip_address, device_fingerprint)
    )`);

    // IP-based token usage log - now device-based
    db.run(`CREATE TABLE IF NOT EXISTS ip_token_usage (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        ip_address TEXT NOT NULL,
        device_fingerprint TEXT NOT NULL,
        operation_type TEXT NOT NULL,
        tokens_used INTEGER NOT NULL,
        input_tokens INTEGER DEFAULT 0,
        output_tokens INTEGER DEFAULT 0,
        created_at DATETIME DEFAULT CURRENT_TIMESTAMP
    )`);

    // Create indexes for better performance
    db.run(`CREATE INDEX IF NOT EXISTS idx_conversations_user_id ON conversations(user_id)`);
    db.run(`CREATE INDEX IF NOT EXISTS idx_messages_conversation_id ON messages(conversation_id)`);
    db.run(`CREATE INDEX IF NOT EXISTS idx_email_verifications_email ON email_verifications(email)`);
    db.run(`CREATE INDEX IF NOT EXISTS idx_password_reset_tokens_token ON password_reset_tokens(token)`);
    db.run(`CREATE INDEX IF NOT EXISTS idx_token_usage_user_id ON token_usage(user_id)`);
    db.run(`CREATE INDEX IF NOT EXISTS idx_ip_token_tracking_ip ON ip_token_tracking(ip_address)`);
    db.run(`CREATE INDEX IF NOT EXISTS idx_ip_token_usage_ip ON ip_token_usage(ip_address)`);
    
    // Migrate from session_id to device_fingerprint if needed
    // Migrate from session_id to device_fingerprint
    db.all(`PRAGMA table_info(ip_token_tracking)`, (err, columns) => {
        if (!err && columns) {
            const hasDeviceFingerprint = columns.some(col => col.name === 'device_fingerprint');
            const hasSessionId = columns.some(col => col.name === 'session_id');
            
            if (!hasDeviceFingerprint) {
                db.run(`ALTER TABLE ip_token_tracking ADD COLUMN device_fingerprint TEXT`, (alterErr) => {
                    if (!alterErr) {
                        if (hasSessionId) {
                            // Migrate from session_id to device_fingerprint
                            db.run(`UPDATE ip_token_tracking SET device_fingerprint = session_id WHERE device_fingerprint IS NULL`, () => {});
                        } else {
                            // Use IP as device fingerprint for legacy records
                            db.run(`UPDATE ip_token_tracking SET device_fingerprint = 'legacy_' || ip_address WHERE device_fingerprint IS NULL`, () => {});
                        }
                        db.run(`CREATE INDEX IF NOT EXISTS idx_ip_token_tracking_device ON ip_token_tracking(device_fingerprint)`, () => {});
                        console.log('Migration: Added device_fingerprint to ip_token_tracking');
                    }
                });
            } else {
                db.run(`CREATE INDEX IF NOT EXISTS idx_ip_token_tracking_device ON ip_token_tracking(device_fingerprint)`, () => {});
            }
        }
    });
    
    db.all(`PRAGMA table_info(ip_token_usage)`, (err, columns) => {
        if (!err && columns) {
            const hasDeviceFingerprint = columns.some(col => col.name === 'device_fingerprint');
            const hasSessionId = columns.some(col => col.name === 'session_id');
            
            if (!hasDeviceFingerprint) {
                db.run(`ALTER TABLE ip_token_usage ADD COLUMN device_fingerprint TEXT`, (alterErr) => {
                    if (!alterErr) {
                        if (hasSessionId) {
                            // Migrate from session_id to device_fingerprint
                            db.run(`UPDATE ip_token_usage SET device_fingerprint = session_id WHERE device_fingerprint IS NULL`, () => {});
                        } else {
                            // Use IP as device fingerprint for legacy records
                            db.run(`UPDATE ip_token_usage SET device_fingerprint = 'legacy_' || ip_address WHERE device_fingerprint IS NULL`, () => {});
                        }
                        db.run(`CREATE INDEX IF NOT EXISTS idx_ip_token_usage_device ON ip_token_usage(device_fingerprint)`, () => {});
                        console.log('Migration: Added device_fingerprint to ip_token_usage');
                    }
                });
            } else {
                db.run(`CREATE INDEX IF NOT EXISTS idx_ip_token_usage_device ON ip_token_usage(device_fingerprint)`, () => {});
            }
        }
    });
});

// Open WebUI API Configuration
const WEBUI_BASE_URL = process.env.WEBUI_BASE_URL || 'https://uncensored.infinet.services';
const API_KEYS = {
    model1: process.env.WEBUI_API_KEY_1 || 'YOUR_WEBUI_API_KEY_1',
    model2: process.env.WEBUI_API_KEY_2 || 'YOUR_WEBUI_API_KEY_2'
};

// Cryptomus Payment Configuration
// Keys should be set in .env file for security
const CRYPTOMUS_CONFIG = {
    merchantId: process.env.CRYPTOMUS_MERCHANT_ID,
    apiKey: process.env.CRYPTOMUS_API_KEY,
    apiUrl: 'https://api.cryptomus.com/v1',
    webhookSecret: process.env.CRYPTOMUS_WEBHOOK_SECRET || crypto.randomBytes(32).toString('hex')
};

// Validate that Cryptomus credentials are set
if (!CRYPTOMUS_CONFIG.merchantId || !CRYPTOMUS_CONFIG.apiKey) {
    console.error('[CRYPTOMUS] WARNING: Cryptomus credentials not found in environment variables!');
    console.error('[CRYPTOMUS] Please set CRYPTOMUS_MERCHANT_ID and CRYPTOMUS_API_KEY in .env file');
}

// Plan pricing mapping
const PLAN_PRICING = {
    'pro': { name: 'Lite', price: 9, tokens: 50000 },
    'proplus': { name: 'Pro', price: 29, tokens: 200000 },
    'expert': { name: 'Ultra', price: 59, tokens: 500000 }
};

const MODELS = {
    model1: process.env.MODEL_1 || 'hf.co/mradermacher/Huihui-Qwen3-Coder-30B-A3B-Instruct-abliterated-i1-GGUF:Q3_K_M',
    model2: process.env.MODEL_2 || 'hf.co/DavidAU/Qwen3-4B-Gemini-TripleX-High-Reasoning-Thinking-Heretic-Uncensored-GGUF:Q8_0'
};

// Helper function to get API key based on model (checks assignments first)
function getApiKey(model) {
    const assignments = loadModelAssignments();
    const apiKeys = loadApiKeys();
    
    // Check if an admin-managed model is assigned to this slot
    if (model === 'model1' && assignments.model1) {
        const assignedModel = apiKeys[assignments.model1];
        if (assignedModel && assignedModel.active) {
            return assignedModel.apiKey;
        }
    }
    if (model === 'model2' && assignments.model2) {
        const assignedModel = apiKeys[assignments.model2];
        if (assignedModel && assignedModel.active) {
            return assignedModel.apiKey;
        }
    }
    
    // For model2 (Thinker), check if hardcoded key matches a deactivated admin-managed model
    // If it does, don't use the hardcoded fallback (same behavior as validateApiKey)
    if (model === 'model2') {
        const hardcodedKey = API_KEYS.model2;
        for (const [modelId, keyData] of Object.entries(apiKeys)) {
            if (keyData.apiKey === hardcodedKey && !keyData.active) {
                // Hardcoded key matches a deactivated model - return null to prevent fallback
                return null;
            }
        }
    }
    
    // Fall back to hardcoded keys
    return model === 'model1' ? API_KEYS.model1 : API_KEYS.model2;
}

// Helper function to get model name (checks assignments first)
function getModelName(model) {
    const assignments = loadModelAssignments();
    const apiKeys = loadApiKeys();
    
    // Check if an admin-managed model is assigned to this slot
    if (model === 'model1' && assignments.model1) {
        const assignedModel = apiKeys[assignments.model1];
        if (assignedModel && assignedModel.active) {
            return assignedModel.modelName;
        }
    }
    if (model === 'model2' && assignments.model2) {
        const assignedModel = apiKeys[assignments.model2];
        if (assignedModel && assignedModel.active) {
            return assignedModel.modelName;
        }
    }
    
    // For model2 (Thinker), check if hardcoded key matches a deactivated admin-managed model
    // If it does, don't use the hardcoded fallback
    if (model === 'model2') {
        const hardcodedKey = API_KEYS.model2;
        for (const [modelId, keyData] of Object.entries(apiKeys)) {
            if (keyData.apiKey === hardcodedKey && !keyData.active) {
                // Hardcoded key matches a deactivated model - return null to prevent fallback
                return null;
            }
        }
    }
    
    // Fall back to hardcoded models
    return model === 'model1' ? MODELS.model1 : MODELS.model2;
}

// Helper function to get display name (checks assignments first)
function getDisplayName(model) {
    const assignments = loadModelAssignments();
    const apiKeys = loadApiKeys();
    
    // Check if an admin-managed model is assigned to this slot
    if (model === 'model1' && assignments.model1) {
        const assignedModel = apiKeys[assignments.model1];
        if (assignedModel && assignedModel.active) {
            return assignedModel.displayName || assignedModel.id;
        }
    }
    if (model === 'model2' && assignments.model2) {
        const assignedModel = apiKeys[assignments.model2];
        if (assignedModel && assignedModel.active) {
            return assignedModel.displayName || assignedModel.id;
        }
    }
    
    // For model2 (Thinker), check if hardcoded key matches a deactivated admin-managed model
    // If it does, don't use the hardcoded fallback
    if (model === 'model2') {
        const hardcodedKey = API_KEYS.model2;
        for (const [modelId, keyData] of Object.entries(apiKeys)) {
            if (keyData.apiKey === hardcodedKey && !keyData.active) {
                // Hardcoded key matches a deactivated model - return null to prevent fallback
                return null;
            }
        }
    }
    
    // Fall back to default names
    return model === 'model1' ? 'InfiNet-Coder' : 'InfiNet-Thinker';
}

// ============================================
// TOKEN CALCULATION SYSTEM
// ============================================

// Token costs configuration
const TOKEN_COSTS = {
    text: {
        input: 1,   // 1 token = 1 token
        output: 1   // 1 token = 1 token
    },
    image: 800,           // 1 image = 800 tokens
    imageToText: 75       // 1 operation = 75 tokens overhead
};

// Plan token allocations
const PLAN_TOKENS = {
    free: 10000,
    pro: 50000,        // Lite plan: 50K tokens (updated from 25K)
    proplus: 200000,   // Pro plan: 200K tokens (updated from 100K)
    expert: 500000,    // Ultra plan: 500K tokens (updated from 250K)
    owner: Infinity // Unlimited tokens for owner account
};

// Calculate tokens for text/code operations
function calculateTextTokens(inputText, outputText) {
    const inputTokens = Math.ceil((inputText || '').length / 4);
    const outputTokens = Math.ceil((outputText || '').length / 4);
    return {
        inputTokens,
        outputTokens,
        totalTokens: inputTokens + outputTokens
    };
}

// Calculate tokens for image generation
function calculateImageTokens(inputText) {
    const inputTokens = Math.ceil((inputText || '').length / 4);
    return {
        inputTokens,
        outputTokens: 0,
        totalTokens: inputTokens + TOKEN_COSTS.image
    };
}

// Calculate tokens for image-to-text operations
function calculateImageToTextTokens(inputText, outputText) {
    const inputTokens = Math.ceil((inputText || '').length / 4);
    const outputTokens = Math.ceil((outputText || '').length / 4);
    return {
        inputTokens,
        outputTokens,
        totalTokens: inputTokens + outputTokens + TOKEN_COSTS.imageToText
    };
}

// Check if user has enough tokens
function checkTokenBalance(userId, requiredTokens, callback) {
    db.get('SELECT tokens, plan FROM users WHERE id = ?', [userId], (err, user) => {
        if (err) {
            return callback(err, null);
        }
        if (!user) {
            return callback(new Error('User not found'), null);
        }
        
        const hasEnough = user.tokens >= requiredTokens;
        callback(null, {
            hasEnough,
            currentTokens: user.tokens,
            requiredTokens,
            plan: user.plan
        });
    });
}

// Deduct tokens from user balance
function deductTokens(userId, tokensUsed, operationType, inputTokens, outputTokens, callback) {
    db.run(
        'UPDATE users SET tokens = tokens - ? WHERE id = ?',
        [tokensUsed, userId],
        function(err) {
            if (err) {
                return callback(err);
            }
            
            // Log token usage
            db.run(
                'INSERT INTO token_usage (user_id, operation_type, tokens_used, input_tokens, output_tokens) VALUES (?, ?, ?, ?, ?)',
                [userId, operationType, tokensUsed, inputTokens, outputTokens],
                (logErr) => {
                    if (logErr) {
                        console.error('Error logging token usage:', logErr);
                    }
                    callback(null, tokensUsed);
                }
            );
        }
    );
}

// Initialize tokens for new user based on plan
function initializeUserTokens(userId, plan, callback) {
    const tokens = PLAN_TOKENS[plan] || PLAN_TOKENS.free;
    db.run(
        'UPDATE users SET tokens = ? WHERE id = ?',
        [tokens, userId],
        function(err) {
            if (err) {
                return callback(err);
            }
            callback(null, tokens);
        }
    );
}

// BULLETPROOF: Get user tokens - ALWAYS calculated from usage history (single source of truth)
// NEVER trusts users.tokens field directly - always recalculates from token_usage table
// This prevents ALL token resets - tokens can only decrease, never reset
function getOrInitializeUserTokens(userId, plan, callback) {
    const allocatedTokens = PLAN_TOKENS[plan] || PLAN_TOKENS.free;
    
    // Owner plan has unlimited tokens - always return Infinity
    if (plan === 'owner' || allocatedTokens === Infinity) {
        return callback(null, Infinity);
    }
    
    // SINGLE SOURCE OF TRUTH: Always calculate from usage history
    db.get('SELECT SUM(tokens_used) as total_used FROM token_usage WHERE user_id = ?', [userId], (usageErr, usage) => {
        if (usageErr) {
            console.error(`[TOKEN SYSTEM] Error checking usage for user ${userId}:`, usageErr);
            // On error, check if user exists and has tokens field
            db.get('SELECT tokens FROM users WHERE id = ?', [userId], (userErr, user) => {
                if (userErr || !user) {
                    return callback(userErr || new Error('User not found'));
                }
                // If tokens field exists and is valid, use it as fallback
                if (user.tokens !== null && user.tokens !== undefined && user.tokens >= 0 && user.tokens <= allocatedTokens) {
                    console.log(`[TOKEN SYSTEM] Using fallback tokens from users.tokens field: ${user.tokens}`);
                    return callback(null, user.tokens);
                }
                // No valid tokens - initialize
                const tokens = allocatedTokens;
                db.run('UPDATE users SET tokens = ? WHERE id = ?', [tokens, userId], () => {});
                console.log(`[TOKEN SYSTEM] Initialized user ${userId} with ${tokens} tokens (error fallback)`);
                return callback(null, tokens);
            });
            return;
        }
        
        const totalUsed = usage?.total_used || 0;
        const calculatedTokens = Math.max(0, allocatedTokens - totalUsed);
        
        // ALWAYS calculate from usage - this is the single source of truth
        // Never trust users.tokens field - it's just a cache
        db.get('SELECT tokens FROM users WHERE id = ?', [userId], (userErr, user) => {
            if (userErr) {
                console.error(`[TOKEN SYSTEM] Error getting user ${userId}:`, userErr);
                return callback(userErr);
            }
            
            const currentTokens = user?.tokens || 0;
            
            // Update users.tokens field to match calculated value (cache sync)
            // But ONLY if it's different (to avoid unnecessary writes)
            if (currentTokens !== calculatedTokens) {
                db.run('UPDATE users SET tokens = ? WHERE id = ?', [calculatedTokens, userId], (updateErr) => {
                    if (updateErr) {
                        console.error(`[TOKEN SYSTEM] Error updating tokens cache for user ${userId}:`, updateErr);
                    } else {
                        if (currentTokens > calculatedTokens) {
                            console.log(`[TOKEN SYSTEM] ✅ CORRECTED: User ${userId} tokens ${currentTokens} → ${calculatedTokens} (used ${totalUsed}/${allocatedTokens})`);
                        } else {
                            console.log(`[TOKEN SYSTEM] ✅ SYNCED: User ${userId} tokens ${currentTokens} → ${calculatedTokens} (used ${totalUsed}/${allocatedTokens})`);
                        }
                    }
                    callback(null, calculatedTokens);
                });
            } else {
                // Tokens are already correct
                console.log(`[TOKEN SYSTEM] ✅ User ${userId} has ${calculatedTokens} tokens (used ${totalUsed}/${allocatedTokens}) - correct`);
                callback(null, calculatedTokens);
            }
        });
    });
}

// Get client IP address
function getClientIP(req) {
    return req.ip || 
           req.connection.remoteAddress || 
           req.headers['x-forwarded-for']?.split(',')[0]?.trim() || 
           req.headers['x-real-ip'] || 
           'unknown';
}

// Get device fingerprint for token tracking (IP + User-Agent + device info)
function getDeviceFingerprint(req, res) {
    const clientIP = getClientIP(req);
    const userAgent = req.headers['user-agent'] || 'unknown';
    
    // Get device fingerprint from cookie, localStorage backup, or create one
    const cookieName = 'device_fingerprint';
    let deviceFingerprint = req.cookies && req.cookies[cookieName];
    
    // Check for localStorage backup in request header (sent by client)
    if (!deviceFingerprint && req.headers['x-device-fingerprint']) {
        deviceFingerprint = req.headers['x-device-fingerprint'];
        // Restore cookie from localStorage backup
        if (res) {
            res.cookie(cookieName, deviceFingerprint, { 
                maxAge: 365 * 24 * 60 * 60 * 1000,
                httpOnly: true,
                sameSite: 'lax'
            });
        }
    }
    
    if (!deviceFingerprint) {
        // Create device fingerprint from IP + User-Agent hash
        const crypto = require('crypto');
        const fingerprintData = `${clientIP}|${userAgent}`;
        deviceFingerprint = crypto.createHash('sha256').update(fingerprintData).digest('hex').substring(0, 32);
        
        // Set cookie that expires in 1 year
        if (res) {
            res.cookie(cookieName, deviceFingerprint, { 
                maxAge: 365 * 24 * 60 * 60 * 1000,
                httpOnly: true,
                sameSite: 'lax'
            });
        }
    }
    
    return deviceFingerprint;
}

// Initialize or get IP token tracking (device-based - shared across all accounts on same device)
// PRIMARY: Uses device_fingerprint as main identifier (survives IP changes)
// FALLBACK: Uses IP address if device_fingerprint not found
function getIPTokenTracking(ipAddress, deviceFingerprint, callback) {
    // PRIMARY: Try with device_fingerprint ONLY (ignores IP - device persists across IP changes)
    db.get('SELECT * FROM ip_token_tracking WHERE device_fingerprint = ? ORDER BY last_used_at DESC LIMIT 1', [deviceFingerprint], (err, tracking) => {
        if (err && err.code === 'SQLITE_ERROR' && err.message.includes('no such column')) {
            // Fallback: table doesn't have device_fingerprint yet, try with session_id or just IP
            db.get('SELECT * FROM ip_token_tracking WHERE ip_address = ?', [ipAddress], (legacyErr, legacyTracking) => {
                if (legacyErr) return callback(legacyErr);
                
                if (legacyTracking) {
                    const tokensRemaining = legacyTracking.tokens_allocated - legacyTracking.tokens_used;
                    callback(null, {
                        ip_address: legacyTracking.ip_address,
                        device_fingerprint: deviceFingerprint,
                        tokens_used: legacyTracking.tokens_used,
                        tokens_allocated: legacyTracking.tokens_allocated,
                        tokens_remaining: tokensRemaining
                    });
                } else {
                    // Initialize with free plan tokens for this device
                    db.run(
                        'INSERT INTO ip_token_tracking (ip_address, tokens_used, tokens_allocated) VALUES (?, ?, ?)',
                        [ipAddress, 0, PLAN_TOKENS.free],
                        function(insertErr) {
                            if (insertErr) return callback(insertErr);
                            callback(null, {
                                ip_address: ipAddress,
                                device_fingerprint: deviceFingerprint,
                                tokens_used: 0,
                                tokens_allocated: PLAN_TOKENS.free,
                                tokens_remaining: PLAN_TOKENS.free
                            });
                        }
                    );
                }
            });
            return;
        }
        
        if (err) return callback(err);
        
        if (tracking) {
            // Update IP address if it changed (device moved networks)
            if (tracking.ip_address !== ipAddress) {
                db.run('UPDATE ip_token_tracking SET ip_address = ?, last_used_at = CURRENT_TIMESTAMP WHERE device_fingerprint = ?', 
                    [ipAddress, deviceFingerprint], () => {});
                console.log(`[TOKEN TRACKING] Updated IP for device ${deviceFingerprint.substring(0, 8)}... from ${tracking.ip_address} to ${ipAddress}`);
            } else {
                // Update last_used_at timestamp
                db.run('UPDATE ip_token_tracking SET last_used_at = CURRENT_TIMESTAMP WHERE device_fingerprint = ?', 
                    [deviceFingerprint], () => {});
            }
            
            const tokensRemaining = tracking.tokens_allocated - tracking.tokens_used;
            callback(null, {
                ip_address: ipAddress, // Use current IP
                device_fingerprint: tracking.device_fingerprint || deviceFingerprint,
                tokens_used: tracking.tokens_used,
                tokens_allocated: tracking.tokens_allocated,
                tokens_remaining: tokensRemaining
            });
        } else {
            // No record found with device_fingerprint - AGGRESSIVE FALLBACK to prevent token reset
            // Try multiple strategies before creating new record:
            // 1. Same IP address (device on same network)
            // 2. Recent records (within last 24 hours) - might be same device
            // 3. Records with similar characteristics
            
            console.log(`[TOKEN TRACKING] No record found for device ${deviceFingerprint.substring(0, 8)}... - trying fallback strategies`);
            
            // Strategy 1: Try same IP address
            db.all('SELECT * FROM ip_token_tracking WHERE ip_address = ? ORDER BY last_used_at DESC LIMIT 5', [ipAddress], (ipFallbackErr, ipRecords) => {
                if (!ipFallbackErr && ipRecords && ipRecords.length > 0) {
                    // Found records with same IP - use the most recently used one
                    const mostRecent = ipRecords[0];
                    console.log(`[TOKEN TRACKING] Fallback 1: Found record with same IP ${ipAddress}, recovering tokens (${mostRecent.tokens_allocated - mostRecent.tokens_used} remaining)`);
                    
                    db.run(
                        'UPDATE ip_token_tracking SET device_fingerprint = ?, ip_address = ?, last_used_at = CURRENT_TIMESTAMP WHERE id = ?',
                        [deviceFingerprint, ipAddress, mostRecent.id],
                        function(updateErr) {
                            if (!updateErr && this.changes > 0) {
                                const tokensRemaining = mostRecent.tokens_allocated - mostRecent.tokens_used;
                                console.log(`[TOKEN TRACKING] Successfully recovered ${tokensRemaining} tokens for device ${deviceFingerprint.substring(0, 8)}...`);
                                return callback(null, {
                                    ip_address: ipAddress,
                                    device_fingerprint: deviceFingerprint,
                                    tokens_used: mostRecent.tokens_used,
                                    tokens_allocated: mostRecent.tokens_allocated,
                                    tokens_remaining: tokensRemaining
                                });
                            }
                            // Continue to next strategy
                            tryRecentRecords();
                        }
                    );
                } else {
                    // Strategy 2: Try recent records (within 24 hours)
                    tryRecentRecords();
                }
                
                function tryRecentRecords() {
                    // Strategy 2: Look for recent records (within last 24 hours) - might be same device
                    db.all(
                        `SELECT * FROM ip_token_tracking 
                         WHERE last_used_at > datetime('now', '-24 hours') 
                         ORDER BY last_used_at DESC LIMIT 10`,
                        [],
                        (recentErr, recentRecords) => {
                            if (!recentErr && recentRecords && recentRecords.length > 0) {
                                // Use the most recent record (likely same device if fingerprint was lost)
                                const mostRecent = recentRecords[0];
                                console.log(`[TOKEN TRACKING] Fallback 2: Found recent record (${mostRecent.tokens_allocated - mostRecent.tokens_used} tokens remaining), recovering...`);
                                
                                db.run(
                                    'UPDATE ip_token_tracking SET device_fingerprint = ?, ip_address = ?, last_used_at = CURRENT_TIMESTAMP WHERE id = ?',
                                    [deviceFingerprint, ipAddress, mostRecent.id],
                                    function(updateErr) {
                                        if (!updateErr && this.changes > 0) {
                                            const tokensRemaining = mostRecent.tokens_allocated - mostRecent.tokens_used;
                                            console.log(`[TOKEN TRACKING] Successfully recovered ${tokensRemaining} tokens from recent record`);
                                            return callback(null, {
                                                ip_address: ipAddress,
                                                device_fingerprint: deviceFingerprint,
                                                tokens_used: mostRecent.tokens_used,
                                                tokens_allocated: mostRecent.tokens_allocated,
                                                tokens_remaining: tokensRemaining
                                            });
                                        }
                                        // Continue to last resort
                                        tryAllRecords();
                                    }
                                );
                            } else {
                                // Strategy 3: Last resort - try all records, use most recent
                                tryAllRecords();
                            }
                        }
                    );
                }
                
                function tryAllRecords() {
                    // Strategy 3: Last resort - get most recently used record (absolute fallback)
                    db.all(
                        'SELECT * FROM ip_token_tracking ORDER BY last_used_at DESC LIMIT 1',
                        [],
                        (allErr, allRecords) => {
                            if (!allErr && allRecords && allRecords.length > 0) {
                                const mostRecent = allRecords[0];
                                const tokensRemaining = mostRecent.tokens_allocated - mostRecent.tokens_used;
                                
                                // Only use this if it has significant token usage (not a fresh record)
                                if (mostRecent.tokens_used > 0 || tokensRemaining < PLAN_TOKENS.free) {
                                    console.log(`[TOKEN TRACKING] Fallback 3: Using most recent record with ${tokensRemaining} tokens remaining (last resort)`);
                                    
                                    db.run(
                                        'UPDATE ip_token_tracking SET device_fingerprint = ?, ip_address = ?, last_used_at = CURRENT_TIMESTAMP WHERE id = ?',
                                        [deviceFingerprint, ipAddress, mostRecent.id],
                                        function(updateErr) {
                                            if (!updateErr && this.changes > 0) {
                                                return callback(null, {
                                                    ip_address: ipAddress,
                                                    device_fingerprint: deviceFingerprint,
                                                    tokens_used: mostRecent.tokens_used,
                                                    tokens_allocated: mostRecent.tokens_allocated,
                                                    tokens_remaining: tokensRemaining
                                                });
                                            }
                                            // All fallbacks failed - create new record
                                            insertNewRecord();
                                        }
                                    );
                                } else {
                                    // Record is fresh (no usage) - create new one
                                    console.log(`[TOKEN TRACKING] All fallbacks exhausted or found fresh record - creating new record`);
                                    insertNewRecord();
                                }
                            } else {
                                // No records exist at all - create new one
                                console.log(`[TOKEN TRACKING] No records found in database - creating new record`);
                                insertNewRecord();
                            }
                        }
                    );
                }
                
                function insertNewRecord() {
                        // No fallback records found, proceed with INSERT
                        db.run(
                            'INSERT INTO ip_token_tracking (ip_address, device_fingerprint, tokens_used, tokens_allocated) VALUES (?, ?, ?, ?)',
                            [ipAddress, deviceFingerprint, 0, PLAN_TOKENS.free],
                            function(insertErr) {
                                if (insertErr && insertErr.code === 'SQLITE_ERROR' && insertErr.message.includes('no such column')) {
                                    db.run(
                                        'INSERT OR IGNORE INTO ip_token_tracking (ip_address, tokens_used, tokens_allocated) VALUES (?, ?, ?)',
                                        [ipAddress, 0, PLAN_TOKENS.free],
                                        function(legacyInsertErr) {
                                            if (legacyInsertErr && legacyInsertErr.code !== 'SQLITE_CONSTRAINT') {
                                                return callback(legacyInsertErr);
                                            }
                                            db.get('SELECT * FROM ip_token_tracking WHERE ip_address = ?', [ipAddress], (fetchErr, fetched) => {
                                                if (fetchErr) return callback(fetchErr);
                                                if (!fetched) {
                                                    return callback(null, {
                                                        ip_address: ipAddress,
                                                        device_fingerprint: deviceFingerprint,
                                                        tokens_used: 0,
                                                        tokens_allocated: PLAN_TOKENS.free,
                                                        tokens_remaining: PLAN_TOKENS.free
                                                    });
                                                }
                                                const tokensRemaining = (fetched.tokens_allocated || PLAN_TOKENS.free) - (fetched.tokens_used || 0);
                                                callback(null, {
                                                    ip_address: fetched.ip_address,
                                                    device_fingerprint: deviceFingerprint,
                                                    tokens_used: fetched.tokens_used || 0,
                                                    tokens_allocated: fetched.tokens_allocated || PLAN_TOKENS.free,
                                                    tokens_remaining: tokensRemaining
                                                });
                                            });
                                        }
                                    );
                                } else if (insertErr && insertErr.code === 'SQLITE_CONSTRAINT') {
                                    db.get('SELECT * FROM ip_token_tracking WHERE ip_address = ? AND device_fingerprint = ?', [ipAddress, deviceFingerprint], (fetchErr, fetched) => {
                                        if (fetchErr) return callback(fetchErr);
                                        if (!fetched) {
                                            db.get('SELECT * FROM ip_token_tracking WHERE ip_address = ?', [ipAddress], (legacyFetchErr, legacyFetched) => {
                                                if (legacyFetchErr) return callback(legacyFetchErr);
                                                if (!legacyFetched) {
                                                    return callback(null, {
                                                        ip_address: ipAddress,
                                                        device_fingerprint: deviceFingerprint,
                                                        tokens_used: 0,
                                                        tokens_allocated: PLAN_TOKENS.free,
                                                        tokens_remaining: PLAN_TOKENS.free
                                                    });
                                                }
                                                const tokensRemaining = (legacyFetched.tokens_allocated || PLAN_TOKENS.free) - (legacyFetched.tokens_used || 0);
                                                callback(null, {
                                                    ip_address: legacyFetched.ip_address,
                                                    device_fingerprint: deviceFingerprint,
                                                    tokens_used: legacyFetched.tokens_used || 0,
                                                    tokens_allocated: legacyFetched.tokens_allocated || PLAN_TOKENS.free,
                                                    tokens_remaining: tokensRemaining
                                                });
                                            });
                                            return;
                                        }
                                        const tokensRemaining = fetched.tokens_allocated - fetched.tokens_used;
                                        callback(null, {
                                            ip_address: fetched.ip_address,
                                            device_fingerprint: fetched.device_fingerprint || deviceFingerprint,
                                            tokens_used: fetched.tokens_used,
                                            tokens_allocated: fetched.tokens_allocated,
                                            tokens_remaining: tokensRemaining
                                        });
                                    });
                                } else if (insertErr) {
                                    return callback(insertErr);
                                } else {
                                    callback(null, {
                                        ip_address: ipAddress,
                                        device_fingerprint: deviceFingerprint,
                                        tokens_used: 0,
                                        tokens_allocated: PLAN_TOKENS.free,
                                        tokens_remaining: PLAN_TOKENS.free
                                    });
                                }
                            }
                        );
                    }
                }
            );
        }
    });
}

// Deduct tokens from IP tracking (device-based - shared across all accounts on same device)
// Optimized token deduction with retry logic and exponential backoff
function deductIPTokens(ipAddress, deviceFingerprint, tokensUsed, operationType, inputTokens, outputTokens, callback, retryCount = 0) {
    const MAX_RETRIES = 3;
    const BASE_DELAY = 10; // Base delay in milliseconds
    
    // Calculate exponential backoff with jitter: delay = BASE_DELAY * (2^retryCount) + random(0-10ms)
    const delay = retryCount > 0 ? BASE_DELAY * Math.pow(2, retryCount - 1) + Math.random() * 10 : 0;
    
    if (retryCount > 0) {
        console.log(`[TOKEN DEDUCTION] Retry attempt ${retryCount}/${MAX_RETRIES} after ${delay.toFixed(0)}ms delay`);
    }
    
    // Helper function to log token usage (non-blocking, errors don't fail the operation)
    const logTokenUsage = () => {
        db.run(
            'INSERT INTO ip_token_usage (ip_address, device_fingerprint, operation_type, tokens_used, input_tokens, output_tokens) VALUES (?, ?, ?, ?, ?, ?)',
            [ipAddress, deviceFingerprint, operationType, tokensUsed, inputTokens, outputTokens],
            (logErr) => {
                if (logErr && logErr.code === 'SQLITE_ERROR' && logErr.message.includes('no such column')) {
                    // Fallback to legacy schema
                    db.run(
                        'INSERT INTO ip_token_usage (ip_address, operation_type, tokens_used, input_tokens, output_tokens) VALUES (?, ?, ?, ?, ?)',
                        [ipAddress, operationType, tokensUsed, inputTokens, outputTokens],
                        (legacyLogErr) => {
                            if (legacyLogErr) console.error('[TOKEN DEDUCTION] Error logging usage (legacy):', legacyLogErr);
                        }
                    );
                } else if (logErr) {
                    console.error('[TOKEN DEDUCTION] Error logging usage:', logErr);
                }
            }
        );
    };
    
    // Retry helper with exponential backoff
    const retry = () => {
        if (retryCount >= MAX_RETRIES) {
            console.error(`[TOKEN DEDUCTION] Max retries (${MAX_RETRIES}) exceeded for IP: ${ipAddress}`);
            return callback(new Error('Token deduction failed after maximum retries'));
        }
        setTimeout(() => {
            deductIPTokens(ipAddress, deviceFingerprint, tokensUsed, operationType, inputTokens, outputTokens, callback, retryCount + 1);
        }, delay);
    };
    
    // Try to update first (most common case - record exists)
    // PRIMARY: Use device_fingerprint (survives IP changes)
    // Also update IP address if it changed
    db.run(
        'UPDATE ip_token_tracking SET tokens_used = tokens_used + ?, ip_address = ?, last_used_at = CURRENT_TIMESTAMP WHERE device_fingerprint = ?',
        [tokensUsed, ipAddress, deviceFingerprint],
        function(updateErr) {
            if (updateErr && updateErr.code === 'SQLITE_ERROR' && updateErr.message.includes('no such column')) {
                // Fallback: legacy schema (no device_fingerprint column)
                db.run(
                    'UPDATE ip_token_tracking SET tokens_used = tokens_used + ?, last_used_at = CURRENT_TIMESTAMP WHERE ip_address = ?',
                    [tokensUsed, ipAddress],
                    function(legacyErr) {
                        if (legacyErr) {
                            console.error('[TOKEN DEDUCTION] Error updating tokens (legacy):', legacyErr);
                            return callback(legacyErr);
                        }
                        if (this.changes === 0) {
                            // Record doesn't exist, create it
                            db.run(
                                'INSERT INTO ip_token_tracking (ip_address, tokens_used, tokens_allocated) VALUES (?, ?, ?)',
                                [ipAddress, tokensUsed, PLAN_TOKENS.free],
                                (createErr) => {
                                    if (createErr && createErr.code === 'SQLITE_CONSTRAINT') {
                                        // Race condition - retry
                                        if (retryCount < MAX_RETRIES) {
                                            return retry();
                                        }
                                        // After retries, try update again (record might exist now)
                                        return deductIPTokens(ipAddress, deviceFingerprint, tokensUsed, operationType, inputTokens, outputTokens, callback, retryCount + 1);
                                    }
                                    if (createErr) {
                                        console.error('[TOKEN DEDUCTION] Error creating record (legacy):', createErr);
                                        return callback(createErr);
                                    }
                                    logTokenUsage();
                                    callback(null, tokensUsed);
                                }
                            );
                        } else {
                            logTokenUsage();
                            callback(null, tokensUsed);
                        }
                    }
                );
                return;
            }
            
            if (updateErr) {
                console.error('[TOKEN DEDUCTION] Error updating tokens:', updateErr);
                return callback(updateErr);
            }
            
            if (this.changes > 0) {
                // Success - record existed and was updated
                logTokenUsage();
                if (retryCount === 0) {
                    console.log(`[TOKEN DEDUCTION] Successfully deducted ${tokensUsed} tokens. Rows affected: ${this.changes}`);
                }
                callback(null, tokensUsed);
                return;
            }
            
            // No rows updated - record doesn't exist with this device_fingerprint
            // Check if record exists with same IP but different/null device_fingerprint
            db.get('SELECT * FROM ip_token_tracking WHERE ip_address = ?', [ipAddress], (checkErr, existingRecord) => {
                if (checkErr) {
                    console.error('[TOKEN DEDUCTION] Error checking for existing record:', checkErr);
                    // Continue to INSERT attempt
                }
                
                if (existingRecord && existingRecord.device_fingerprint !== deviceFingerprint) {
                    // Record exists but with different device_fingerprint - update it to use the new one
                    console.log(`[TOKEN DEDUCTION] Updating existing record with new device_fingerprint. IP: ${ipAddress}`);
                    db.run(
                        'UPDATE ip_token_tracking SET device_fingerprint = ?, ip_address = ?, tokens_used = tokens_used + ?, last_used_at = CURRENT_TIMESTAMP WHERE ip_address = ?',
                        [deviceFingerprint, ipAddress, tokensUsed, ipAddress],
                        function(updateDeviceErr) {
                            if (updateDeviceErr) {
                                console.error('[TOKEN DEDUCTION] Error updating device_fingerprint:', updateDeviceErr);
                                // Fall through to INSERT attempt
                            } else if (this.changes > 0) {
                                logTokenUsage();
                                if (retryCount === 0) {
                                    console.log(`[TOKEN DEDUCTION] Successfully updated device_fingerprint and deducted ${tokensUsed} tokens`);
                                }
                                callback(null, tokensUsed);
                                return;
                            }
                            // Fall through to INSERT if update failed
                        }
                    );
                }
                
                // Try to insert new record
                db.run(
                    'INSERT INTO ip_token_tracking (ip_address, device_fingerprint, tokens_used, tokens_allocated) VALUES (?, ?, ?, ?)',
                    [ipAddress, deviceFingerprint, tokensUsed, PLAN_TOKENS.free],
                    function(insertErr) {
                        if (insertErr && insertErr.code === 'SQLITE_CONSTRAINT') {
                            // Record was created by another request - retry with backoff
                            if (retryCount < MAX_RETRIES) {
                                return retry();
                            }
                            // After max retries, try update one more time (record should exist now)
                            db.run(
                                'UPDATE ip_token_tracking SET tokens_used = tokens_used + ?, ip_address = ?, last_used_at = CURRENT_TIMESTAMP WHERE device_fingerprint = ?',
                                [tokensUsed, ipAddress, deviceFingerprint],
                                function(finalUpdateErr) {
                                    if (finalUpdateErr) {
                                        console.error(`[TOKEN DEDUCTION] Final update failed after ${MAX_RETRIES} retries. IP: ${ipAddress}, Device: ${deviceFingerprint?.substring(0, 8)}...`);
                                        return callback(new Error('Token deduction failed after all retries'));
                                    }
                                    if (this.changes > 0) {
                                        logTokenUsage();
                                        callback(null, tokensUsed);
                                    } else {
                                        console.error(`[TOKEN DEDUCTION] Final update returned 0 rows. IP: ${ipAddress}, Device: ${deviceFingerprint?.substring(0, 8)}...`);
                                        // Last resort: try updating by IP only (in case device_fingerprint mismatch)
                                        db.run(
                                            'UPDATE ip_token_tracking SET device_fingerprint = ?, ip_address = ?, tokens_used = tokens_used + ?, last_used_at = CURRENT_TIMESTAMP WHERE device_fingerprint = ? OR ip_address = ?',
                                            [deviceFingerprint, ipAddress, tokensUsed, deviceFingerprint, ipAddress],
                                            function(lastResortErr) {
                                                if (lastResortErr || this.changes === 0) {
                                                    return callback(new Error('Token deduction failed - record not found after all attempts'));
                                                }
                                                logTokenUsage();
                                                callback(null, tokensUsed);
                                            }
                                        );
                                    }
                                }
                            );
                            return;
                        }
                        
                        if (insertErr) {
                            console.error('[TOKEN DEDUCTION] Error creating record:', insertErr);
                            return callback(insertErr);
                        }
                        
                        // Success - log usage and return
                        logTokenUsage();
                        if (retryCount === 0) {
                            console.log(`[TOKEN DEDUCTION] Created new record and deducted ${tokensUsed} tokens`);
                        }
                        callback(null, tokensUsed);
                    }
                );
            });
        }
    );
}

// Merge IP tokens into user account on login (from device - shared across all accounts on same device)
// BULLETPROOF: ONLY transfers usage logs, NEVER syncs/resets tokens
// Tokens are ALWAYS calculated from usage history after merge completes
function mergeIPTokensToUser(userId, ipAddress, deviceFingerprint, callback) {
    // Get device's token tracking (includes tokens_remaining)
    getIPTokenTracking(ipAddress, deviceFingerprint, (err, deviceTracking) => {
        if (err) {
            console.error(`[TOKEN MERGE] Error getting device tracking for user ${userId}:`, err);
            return callback(err);
        }
        
        if (!deviceTracking) {
            console.log(`[TOKEN MERGE] No device tracking found for user ${userId}`);
            return callback(null, 0);
        }
        
        const deviceTokensUsed = deviceTracking.tokens_used || 0;
        
        console.log(`[TOKEN MERGE] Device has used ${deviceTokensUsed} tokens - transferring logs to user ${userId}`);
        
        // Get user's plan
        db.get('SELECT plan FROM users WHERE id = ?', [userId], (userErr, user) => {
            if (userErr || !user) {
                return callback(userErr || new Error('User not found'));
            }
            
            // Transfer IP token usage logs to user token usage (from device)
            // IMPORTANT: Check if logs already exist to prevent duplicate transfers
            const transferComplete = (transferErr) => {
                if (transferErr) {
                    // Check if error is due to duplicate entries (constraint violation)
                    if (transferErr.code === 'SQLITE_CONSTRAINT') {
                        console.log(`[TOKEN MERGE] Usage logs already exist for user ${userId} - skipping duplicate transfer`);
                        return callback(null, deviceTokensUsed);
                    }
                    console.error(`[TOKEN MERGE] Error transferring IP token usage for user ${userId}:`, transferErr);
                    // Continue anyway - tokens will be recalculated on next access
                } else {
                    console.log(`[TOKEN MERGE] ✅ Transferred ${deviceTokensUsed} tokens usage logs to user ${userId}`);
                }
                
                // CRITICAL: Do NOT update users.tokens here!
                // Tokens will be automatically recalculated by getOrInitializeUserTokens() 
                // when the user accesses their tokens next time
                // This ensures tokens are ALWAYS calculated from usage history, never synced from device
                
                callback(null, deviceTokensUsed);
            };
            
            // Check if logs already exist to prevent duplicate transfers
            db.get('SELECT COUNT(*) as count FROM token_usage WHERE user_id = ?', [userId], (checkErr, checkResult) => {
                if (checkErr) {
                    console.error(`[TOKEN MERGE] Error checking existing logs for user ${userId}:`, checkErr);
                    // Continue with transfer anyway
                } else if (checkResult && checkResult.count > 0) {
                    console.log(`[TOKEN MERGE] User ${userId} already has ${checkResult.count} usage log entries - checking if device logs need transfer`);
                    // Check if device logs are already transferred
                    db.get(
                        `SELECT COUNT(*) as count FROM token_usage tu 
                         INNER JOIN ip_token_usage itu ON tu.tokens_used = itu.tokens_used 
                         AND tu.created_at = itu.created_at 
                         WHERE tu.user_id = ? AND itu.ip_address = ? AND itu.device_fingerprint = ?`,
                        [userId, ipAddress, deviceFingerprint],
                        (duplicateErr, duplicateResult) => {
                            if (duplicateErr || !duplicateResult || duplicateResult.count === 0) {
                                // No duplicates found, proceed with transfer
                                proceedWithTransfer();
                            } else {
                                console.log(`[TOKEN MERGE] Device logs already transferred for user ${userId} - skipping`);
                                callback(null, deviceTokensUsed);
                            }
                        }
                    );
                } else {
                    // No existing logs, proceed with transfer
                    proceedWithTransfer();
                }
            });
            
            function proceedWithTransfer() {
                if (deviceFingerprint) {
                    // New device-based approach
                    db.run(
                        `INSERT INTO token_usage (user_id, operation_type, tokens_used, input_tokens, output_tokens, created_at)
                         SELECT ?, operation_type, tokens_used, input_tokens, output_tokens, created_at
                         FROM ip_token_usage WHERE ip_address = ? AND device_fingerprint = ?`,
                        [userId, ipAddress, deviceFingerprint],
                        (transferErr) => {
                            if (transferErr && transferErr.code === 'SQLITE_ERROR' && transferErr.message.includes('no such column')) {
                                // Fallback: transfer without device_fingerprint
                                db.run(
                                    `INSERT INTO token_usage (user_id, operation_type, tokens_used, input_tokens, output_tokens, created_at)
                                     SELECT ?, operation_type, tokens_used, input_tokens, output_tokens, created_at
                                     FROM ip_token_usage WHERE ip_address = ?`,
                                    [userId, ipAddress],
                                    transferComplete
                                );
                            } else {
                                transferComplete(transferErr);
                            }
                        }
                    );
                } else {
                    // Legacy approach (no device_fingerprint)
                    db.run(
                        `INSERT INTO token_usage (user_id, operation_type, tokens_used, input_tokens, output_tokens, created_at)
                         SELECT ?, operation_type, tokens_used, input_tokens, output_tokens, created_at
                         FROM ip_token_usage WHERE ip_address = ?`,
                        [userId, ipAddress],
                        transferComplete
                    );
                }
            }
        });
    });
}

// OLD FUNCTION - DEPRECATED - DO NOT USE
// This function is kept for backwards compatibility but should not be called
// Tokens should ALWAYS be calculated from usage history via getOrInitializeUserTokens()
function mergeTokensForUser(userId, ipAddress, tokensToDeduct, deviceFingerprint, callback) {
    console.warn(`[DEPRECATED] mergeTokensForUser called for user ${userId} - this should not happen!`);
    // Just transfer logs, don't update tokens
    mergeIPTokensToUser(userId, ipAddress, deviceFingerprint, callback);
}

// DEPRECATED: Old merge function - DO NOT USE
// This function is kept for backwards compatibility but should not be called
// All token merging now goes through mergeIPTokensToUser() which NEVER updates tokens
// Tokens are ALWAYS calculated from usage history via getOrInitializeUserTokens()
function mergeTokensForUser(userId, ipAddress, tokensToDeduct, deviceFingerprint, callback) {
    console.warn(`[DEPRECATED] mergeTokensForUser called for user ${userId} - redirecting to mergeIPTokensToUser`);
    // Just transfer logs, don't update tokens - let getOrInitializeUserTokens() handle it
    mergeIPTokensToUser(userId, ipAddress, deviceFingerprint, callback);
}

// Authentication middleware
function requireAuth(req, res, next) {
    if (req.session.userId) {
        next();
    } else {
        // Redirect to main page to trigger login modal
        res.redirect('/?auth=login');
    }
}

// Routes
// Main routes
// SEO: robots.txt
app.get('/robots.txt', (req, res) => {
    res.type('text/plain');
    res.sendFile(path.join(__dirname, 'robots.txt'));
});

// SEO: sitemap.xml
app.get('/sitemap.xml', (req, res) => {
    res.type('application/xml');
    res.sendFile(path.join(__dirname, 'sitemap.xml'));
});

// Favicon route - ensure proper MIME type
app.get('/favicon.ico', (req, res) => {
    res.type('image/jpeg');
    res.sendFile(path.join(__dirname, 'ghost.JPG'));
});

// Apple Touch Icon route - serve non-transparent icon for Safari Web App banner
app.get('/apple-touch-icon.png', (req, res) => {
    res.type('image/png');
    // Set cache headers to allow Safari to refetch updates immediately
    res.setHeader('Cache-Control', 'public, max-age=0, must-revalidate');
    res.setHeader('Expires', '0');
    res.setHeader('Last-Modified', new Date().toUTCString());
    res.sendFile(path.join(__dirname, 'ghost.PNG'));
});


// PWA Manifest route
app.get('/manifest.json', (req, res) => {
    res.type('application/json');
    res.sendFile(path.join(__dirname, 'manifest.json'));
});

app.get('/pricing', (req, res) => {
    res.sendFile(path.join(__dirname, 'pricing.html'));
});

app.get('/features', (req, res) => {
    res.sendFile(path.join(__dirname, 'features.html'));
});

app.get('/doc', (req, res) => {
    res.sendFile(path.join(__dirname, 'doc.html'));
});

app.get('/documentation', (req, res) => {
    res.sendFile(path.join(__dirname, 'doc.html'));
});

app.get('/profile', requireAuth, (req, res) => {
    // Set cache-control headers to prevent caching
    res.setHeader('Cache-Control', 'no-cache, no-store, must-revalidate');
    res.setHeader('Pragma', 'no-cache');
    res.setHeader('Expires', '0');
    res.sendFile(path.join(__dirname, 'profile.html'));
});

app.get('/privacy', (req, res) => {
    res.sendFile(path.join(__dirname, 'privacy.html'));
});

app.get('/terms', (req, res) => {
    res.sendFile(path.join(__dirname, 'terms.html'));
});

// Admin route moved above to prevent static middleware from bypassing it

// Legacy/placeholder routes (return 404 if views don't exist)
app.get("/register", (req, res) => {
    const registerPath = path.join(__dirname, "views", "register.html");
    if (fs.existsSync(registerPath)) {
        res.sendFile(registerPath);
    } else {
        res.status(404).send('Page not found');
    }
});

app.get('/login', (req, res) => {
    const loginPath = path.join(__dirname, 'views', 'login.html');
    if (fs.existsSync(loginPath)) {
        res.sendFile(loginPath);
    } else {
        res.status(404).send('Page not found');
    }
});

app.get('/dashboard', requireAuth, (req, res) => {
    const dashboardPath = path.join(__dirname, 'views', 'dashboard.html');
    if (fs.existsSync(dashboardPath)) {
        res.sendFile(dashboardPath);
    } else {
        res.status(404).send('Page not found');
    }
});

// Password reset page
app.get('/reset-password', (req, res) => {
    const resetPasswordPath = path.join(__dirname, 'reset-password.html');
    if (fs.existsSync(resetPasswordPath)) {
        res.sendFile(resetPasswordPath);
    } else {
        res.status(404).send('Page not found');
    }
});

// Email transporter setup (using SMTP)
let emailTransporter = null;
if (process.env.SMTP_HOST && process.env.SMTP_USER && process.env.SMTP_PASS) {
    try {
        emailTransporter = nodemailer.createTransport({
            host: process.env.SMTP_HOST,
            port: parseInt(process.env.SMTP_PORT || '587'),
            secure: process.env.SMTP_SECURE === 'true' || process.env.SMTP_PORT === '465',
            auth: {
                user: process.env.SMTP_USER,
                pass: process.env.SMTP_PASS
            },
            tls: {
                rejectUnauthorized: false // Allow self-signed certificates
            }
        });
        
        // Verify connection
        emailTransporter.verify(function(error, success) {
            if (error) {
                console.error('SMTP connection verification failed:', error);
                console.error('Email sending may not work. Please check your SMTP configuration.');
            } else {
                console.log('Email transporter configured and verified successfully');
                console.log('SMTP settings:', {
                    host: process.env.SMTP_HOST,
                    port: process.env.SMTP_PORT || '587',
                    user: process.env.SMTP_USER,
                    from: process.env.SMTP_FROM || process.env.SMTP_USER
                });
            }
        });
    } catch (error) {
        console.error('Error creating email transporter:', error);
        emailTransporter = null;
    }
} else {
    console.warn('SMTP credentials not configured. Email verification will not work.');
    console.warn('Required environment variables: SMTP_HOST, SMTP_USER, SMTP_PASS');
    console.warn('Optional: SMTP_PORT (default: 587), SMTP_SECURE (default: false), SMTP_FROM');
}

// Generate 6-digit verification code
function generateVerificationCode() {
    return Math.floor(100000 + Math.random() * 900000).toString();
}

// Send verification email
async function sendVerificationEmail(email, code) {
    if (!emailTransporter) {
        console.error('Email transporter is null. SMTP configuration:', {
            host: process.env.SMTP_HOST ? 'set' : 'missing',
            user: process.env.SMTP_USER ? 'set' : 'missing',
            pass: process.env.SMTP_PASS ? 'set' : 'missing',
            port: process.env.SMTP_PORT || '587',
            secure: process.env.SMTP_SECURE || 'false'
        });
        throw new Error('Email transporter not configured. Please check SMTP settings.');
    }

    // Ensure we use admin@infinet.services as the from address
    const fromEmail = process.env.SMTP_FROM || 'admin@infinet.services';
    
    console.log('Preparing to send email:', {
        from: fromEmail,
        to: email,
        code: code,
        smtpUser: process.env.SMTP_USER,
        smtpFrom: process.env.SMTP_FROM
    });

    const mailOptions = {
        from: `"InfiNet AI" <${fromEmail}>`,
        to: email,
        replyTo: fromEmail,
        subject: 'InfiNet AI - Email Verification Code',
        html: `
            <!DOCTYPE html>
            <html>
            <head>
                <meta charset="UTF-8">
                <style>
                    body { font-family: Arial, sans-serif; line-height: 1.6; color: #333; }
                    .container { max-width: 600px; margin: 0 auto; padding: 20px; }
                    .header { background: #000; color: #e5ff3a; padding: 20px; text-align: center; }
                    .content { background: #f9f9f9; padding: 30px; border-radius: 8px; margin: 20px 0; }
                    .code { background: #000; color: #e5ff3a; font-size: 32px; font-weight: bold; 
                            padding: 20px; text-align: center; letter-spacing: 8px; border-radius: 8px; 
                            margin: 20px 0; font-family: monospace; }
                    .footer { text-align: center; color: #666; font-size: 12px; margin-top: 20px; }
                </style>
            </head>
            <body>
                <div class="container">
                    <div class="header">
                        <h1>InfiNet AI</h1>
                    </div>
                    <div class="content">
                        <h2>Email Verification</h2>
                        <p>Thank you for signing up! Please use the following code to verify your email address:</p>
                        <div class="code">${code}</div>
                        <p>This code will expire in 10 minutes.</p>
                        <p>If you didn't request this code, please ignore this email.</p>
                    </div>
                    <div class="footer">
                        <p>© ${new Date().getFullYear()} InfiNet Services. All rights reserved.</p>
                    </div>
                </div>
            </body>
            </html>
        `,
        text: `Your InfiNet AI verification code is: ${code}\n\nThis code will expire in 10 minutes.\n\nIf you didn't request this code, please ignore this email.`
    };

    try {
        console.log('Attempting to send email via transporter...');
        const info = await emailTransporter.sendMail(mailOptions);
        console.log('Verification email sent successfully:', {
            messageId: info.messageId,
            response: info.response,
            accepted: info.accepted,
            rejected: info.rejected
        });
        return true;
    } catch (error) {
        console.error('Error sending verification email:', error);
        console.error('Full error object:', JSON.stringify(error, Object.getOwnPropertyNames(error)));
        throw error;
    }
}

// API Routes

// Send verification code endpoint
app.post('/api/send-verification-code', async (req, res) => {
    const { email } = req.body;

    console.log('Send verification code request received for:', email);

    if (!email) {
        return res.status(400).json({ error: 'Email is required' });
    }

    // Basic email validation
    const emailRegex = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
    if (!emailRegex.test(email)) {
        return res.status(400).json({ error: 'Invalid email format' });
    }

    // Check if email transporter is configured
    if (!emailTransporter) {
        console.error('Email transporter not configured. SMTP settings missing.');
        return res.status(500).json({ 
            error: 'Email service is not configured. Please contact support.' 
        });
    }

    // Check if email already exists
    db.get('SELECT id FROM users WHERE email = ?', [email], async (err, user) => {
        if (err) {
            console.error('Database error checking email:', err);
            return res.status(500).json({ error: 'Server error' });
        }

        if (user) {
            return res.status(400).json({ error: 'Email already registered' });
        }

        // Generate verification code
        const code = generateVerificationCode();
        const expiresAt = new Date(Date.now() + 10 * 60 * 1000); // 10 minutes from now
        console.log('Generated verification code for', email, 'expires at', expiresAt);

        // Delete any existing verification codes for this email
        db.run('DELETE FROM email_verifications WHERE email = ?', [email], (err) => {
            if (err) {
                console.error('Error deleting old verification codes:', err);
            }

            // Insert new verification code
            db.run(
                'INSERT INTO email_verifications (email, code, expires_at) VALUES (?, ?, ?)',
                [email, code, expiresAt.toISOString()],
                async function(insertErr) {
                    if (insertErr) {
                        console.error('Error saving verification code:', insertErr);
                        return res.status(500).json({ error: 'Failed to generate verification code' });
                    }

                    console.log('Verification code saved to database. Attempting to send email...');

                    // Send email
                    try {
                        await sendVerificationEmail(email, code);
                        console.log('Verification email sent successfully to', email);
                        res.json({ 
                            success: true, 
                            message: `Verification code sent to ${email}`,
                            email: email
                        });
                    } catch (emailError) {
                        console.error('Error sending verification email:', emailError);
                        console.error('Email error details:', {
                            message: emailError.message,
                            code: emailError.code,
                            command: emailError.command,
                            response: emailError.response
                        });
                        // Delete the verification code if email failed
                        db.run('DELETE FROM email_verifications WHERE email = ?', [email]);
                        
                        let errorMessage = 'Failed to send verification email. ';
                        if (emailError.code === 'EAUTH') {
                            errorMessage += 'Email authentication failed. Please check SMTP credentials.';
                        } else if (emailError.code === 'ECONNECTION') {
                            errorMessage += 'Could not connect to email server.';
                        } else if (emailError.response) {
                            errorMessage += emailError.response;
                        } else {
                            errorMessage += 'Please try again later or contact support.';
                        }
                        
                        res.status(500).json({ error: errorMessage });
                    }
                }
            );
        });
    });
});

app.post('/api/register', async (req, res) => {
    const { email, password, plan, displayName, verificationCode } = req.body;

    if (!email || !password) {
        return res.status(400).json({ error: 'Email and password are required' });
    }

    if (!verificationCode) {
        return res.status(400).json({ error: 'Verification code is required' });
    }

    // Basic email validation
    const emailRegex = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
    if (!emailRegex.test(email)) {
        return res.status(400).json({ error: 'Invalid email format' });
    }

    // Password strength check (minimum 8 characters)
    if (password.length < 8) {
        return res.status(400).json({ error: 'Password must be at least 8 characters long' });
    }

    // Verify the code
    db.get(
        'SELECT * FROM email_verifications WHERE email = ? AND code = ? AND verified_at IS NULL ORDER BY created_at DESC LIMIT 1',
        [email, verificationCode],
        async (verifyErr, verification) => {
            if (verifyErr) {
                console.error('Error verifying code:', verifyErr);
                return res.status(500).json({ error: 'Verification failed' });
            }

            if (!verification) {
                return res.status(400).json({ error: 'Invalid or expired verification code' });
            }

            // Check if code has expired
            const expiresAt = new Date(verification.expires_at);
            if (new Date() > expiresAt) {
                return res.status(400).json({ error: 'Verification code has expired. Please request a new one.' });
            }

            // Code is valid, proceed with registration
    try {
        const hashedPassword = await bcrypt.hash(password, 10);
        
        db.run(
            'INSERT INTO users (email, password, plan, display_name, email_verified) VALUES (?, ?, ?, ?, ?)',
                    [email, hashedPassword, plan || 'free', displayName || null, 1],
            function(err) {
                if (err) {
                    if (err.message.includes('UNIQUE constraint')) {
                        return res.status(400).json({ error: 'Email already exists' });
                    }
                    return res.status(500).json({ error: 'Registration failed' });
                }
                
                const userId = this.lastID;
                const clientIP = getClientIP(req);
                const deviceFingerprint = getDeviceFingerprint(req, res);
                        
                        // Mark verification code as used
                        db.run(
                            'UPDATE email_verifications SET verified_at = ?, user_id = ? WHERE id = ?',
                            [new Date().toISOString(), userId, verification.id],
                            (updateErr) => {
                                if (updateErr) {
                                    console.error('Error updating verification code:', updateErr);
                                }
                            }
                        );
                
                // Initialize tokens for new user based on plan
                const userPlan = plan || 'free';
                initializeUserTokens(userId, userPlan, (err, tokens) => {
                    if (err) {
                        console.error('Error initializing tokens:', err);
                    } else {
                        console.log(`Initialized ${tokens} tokens for user ${userId} with plan ${userPlan}`);
                    }
                    
                    // Merge device tokens into user account (tokens used before signup)
                    mergeIPTokensToUser(userId, clientIP, deviceFingerprint, (mergeErr, tokensMerged) => {
                        if (mergeErr) {
                            console.error('Error merging IP tokens on registration:', mergeErr);
                        } else if (tokensMerged > 0) {
                            console.log(`Merged ${tokensMerged} tokens from device into user ${userId} account`);
                        }
                    });
                    
                    // Send Telegram notification for new registration
                    const telegramMessage = `🎉 <b>New User Registered!</b>\n\n` +
                        `📧 <b>Email:</b> ${email}\n` +
                        `👤 <b>Display Name:</b> ${displayName || 'Not set'}\n` +
                        `📦 <b>Plan:</b> ${userPlan}\n` +
                        `🆔 <b>User ID:</b> ${userId}\n` +
                        `🌐 <b>IP:</b> ${clientIP}\n` +
                        `📅 <b>Date:</b> ${new Date().toLocaleString()}`;
                    
                    sendTelegramNotification(telegramMessage).catch(err => {
                        console.error('Failed to send Telegram notification:', err);
                    });
                });
                
                req.session.userId = userId;
                res.json({ 
                    success: true, 
                    userId: userId,
                            message: 'Registration successful!'
                });
            }
        );
    } catch (error) {
        console.error('Registration error:', error);
        res.status(500).json({ error: 'Registration failed' });
    }
        }
    );
});

app.post('/api/login', (req, res) => {
    const { email, password } = req.body;

    if (!email || !password) {
        return res.status(400).json({ error: 'Email and password are required' });
    }

    db.get('SELECT * FROM users WHERE email = ?', [email], async (err, user) => {
        if (err) {
            return res.status(500).json({ error: 'Login failed' });
        }

        if (!user) {
            return res.status(401).json({ error: 'Invalid credentials' });
        }

        // Check if user has a password (Google OAuth users might not have one)
        if (!user.password) {
            return res.status(401).json({ error: 'Please sign in with Google' });
        }

        try {
            const match = await bcrypt.compare(password, user.password);
            if (match) {
                req.session.userId = user.id;
                
                // Simplified: No device token merging (like uncensored.chat)
                // #region agent log
                agentLog({
                    hypothesisId: 'H1',
                    location: 'server.js:/api/login',
                    message: 'Login success',
                    data: {
                        userId: user.id,
                        plan: user.plan,
                        hasProfilePicture: !!user.profile_picture
                    }
                });
                // #endregion
                res.json({ 
                    success: true, 
                    user: { 
                        id: user.id, 
                        email: user.email, 
                        plan: user.plan,
                        displayName: user.display_name,
                        profilePicture: user.profile_picture,
                        emailVerified: user.email_verified === 1
                    } 
                });
            } else {
                res.status(401).json({ error: 'Invalid credentials' });
            }
        } catch (error) {
            res.status(500).json({ error: 'Login failed' });
        }
    });
});

app.post('/api/logout', (req, res) => {
    req.session.destroy();
    res.json({ success: true });
});

// Forgot password - send reset email
app.post('/api/forgot-password', async (req, res) => {
    const { email } = req.body;

    if (!email) {
        return res.status(400).json({ error: 'Email is required' });
    }

    // Basic email validation
    const emailRegex = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
    if (!emailRegex.test(email)) {
        return res.status(400).json({ error: 'Invalid email format' });
    }

    // Check if email transporter is configured
    if (!emailTransporter) {
        console.error('Email transporter not configured. SMTP settings missing.');
        return res.status(500).json({ 
            error: 'Email service is not configured. Please contact support.' 
        });
    }

    // Check if user exists
    db.get('SELECT id, email, password FROM users WHERE email = ?', [email], async (err, user) => {
        if (err) {
            console.error('Database error checking email:', err);
            return res.status(500).json({ error: 'Server error' });
        }

        // Don't reveal if user exists or not (security best practice)
        // Always return success message even if user doesn't exist
        if (!user) {
            // Still return success to prevent email enumeration
            return res.json({ 
                success: true, 
                message: 'If an account with that email exists, a password reset link has been sent.' 
            });
        }

        // Check if user has a password (Google OAuth users can't reset password this way)
        if (!user.password) {
            return res.json({ 
                success: true, 
                message: 'If an account with that email exists, a password reset link has been sent.' 
            });
        }

        // Generate secure reset token
        const resetToken = crypto.randomBytes(32).toString('hex');
        const expiresAt = new Date(Date.now() + 60 * 60 * 1000); // 1 hour from now

        // Delete any existing reset tokens for this user
        db.run('DELETE FROM password_reset_tokens WHERE user_id = ?', [user.id], (err) => {
            if (err) {
                console.error('Error deleting old reset tokens:', err);
            }

            // Insert new reset token
            db.run(
                'INSERT INTO password_reset_tokens (user_id, token, expires_at) VALUES (?, ?, ?)',
                [user.id, resetToken, expiresAt.toISOString()],
                async function(insertErr) {
                    if (insertErr) {
                        console.error('Error saving reset token:', insertErr);
                        return res.status(500).json({ error: 'Failed to generate reset token' });
                    }

                    // Create reset link - use the actual domain, not localhost
                    const host = req.get('host');
                    const protocol = req.protocol || (req.get('x-forwarded-proto') || 'https');
                    // If host is localhost, use the actual domain
                    const baseUrl = host.includes('localhost') 
                        ? 'https://ai.infinet.services' 
                        : `${protocol}://${host}`;
                    const resetLink = `${baseUrl}/reset-password?token=${resetToken}`;

                    // Send email
                    try {
                        await sendPasswordResetEmail(user.email, resetLink);
                        console.log('Password reset email sent successfully to', user.email);
                        res.json({ 
                            success: true, 
                            message: 'Password reset link has been sent to your email',
                            email: user.email
                        });
                    } catch (emailError) {
                        console.error('Error sending password reset email:', emailError);
                        // Delete the reset token if email failed
                        db.run('DELETE FROM password_reset_tokens WHERE token = ?', [resetToken]);
                        res.status(500).json({ 
                            error: 'Failed to send password reset email. Please try again later.' 
                        });
                    }
                }
            );
        });
    });
});

// Send password reset email
async function sendPasswordResetEmail(email, resetLink) {
    if (!emailTransporter) {
        throw new Error('Email transporter not configured. Please check SMTP settings.');
    }

    const fromEmail = process.env.SMTP_FROM || 'admin@infinet.services';
    
    const mailOptions = {
        from: `"InfiNet AI" <${fromEmail}>`,
        to: email,
        replyTo: fromEmail,
        subject: 'InfiNet AI - Password Reset Request',
        html: `
            <!DOCTYPE html>
            <html>
            <head>
                <meta charset="UTF-8">
                <style>
                    body { font-family: Arial, sans-serif; line-height: 1.6; color: #333; }
                    .container { max-width: 600px; margin: 0 auto; padding: 20px; }
                    .header { background: #000; color: #e5ff3a; padding: 20px; text-align: center; }
                    .content { background: #f9f9f9; padding: 30px; border-radius: 8px; margin: 20px 0; }
                    .button { background: #000; color: #e5ff3a; padding: 15px 30px; text-decoration: none; 
                             border-radius: 8px; display: inline-block; margin: 20px 0; font-weight: bold; }
                    .button:hover { background: #333; }
                    .footer { text-align: center; color: #666; font-size: 12px; margin-top: 20px; }
                    .warning { color: #ff4444; font-size: 0.9em; margin-top: 20px; }
                </style>
            </head>
            <body>
                <div class="container">
                    <div class="header">
                        <h1>InfiNet AI</h1>
                    </div>
                    <div class="content">
                        <h2>Password Reset Request</h2>
                        <p>You requested to reset your password. Click the button below to reset it:</p>
                        <div style="text-align: center;">
                            <a href="${resetLink}" class="button">Reset Password</a>
                        </div>
                        <p>Or copy and paste this link into your browser:</p>
                        <p style="word-break: break-all; color: #666; font-size: 0.9em;">${resetLink}</p>
                        <p class="warning">⚠️ This link will expire in 1 hour.</p>
                        <p>If you didn't request a password reset, please ignore this email. Your password will remain unchanged.</p>
                    </div>
                    <div class="footer">
                        <p>© ${new Date().getFullYear()} InfiNet Services. All rights reserved.</p>
                    </div>
                </div>
            </body>
            </html>
        `,
        text: `You requested to reset your password. Click the link below to reset it:\n\n${resetLink}\n\nThis link will expire in 1 hour.\n\nIf you didn't request a password reset, please ignore this email.`
    };

    try {
        const info = await emailTransporter.sendMail(mailOptions);
        console.log('Password reset email sent successfully:', info.messageId);
        return true;
    } catch (error) {
        console.error('Error sending password reset email:', error);
        throw error;
    }
}

// Reset password with token
app.post('/api/reset-password', async (req, res) => {
    const { token, newPassword } = req.body;

    if (!token || !newPassword) {
        return res.status(400).json({ error: 'Token and new password are required' });
    }

    // Password strength check
    if (newPassword.length < 8) {
        return res.status(400).json({ error: 'Password must be at least 8 characters long' });
    }

    // Find valid reset token
    db.get(
        'SELECT * FROM password_reset_tokens WHERE token = ? AND used_at IS NULL ORDER BY created_at DESC LIMIT 1',
        [token],
        async (err, resetToken) => {
            if (err) {
                console.error('Error finding reset token:', err);
                return res.status(500).json({ error: 'Server error' });
            }

            if (!resetToken) {
                return res.status(400).json({ error: 'Invalid or expired reset token' });
            }

            // Check if token has expired
            const expiresAt = new Date(resetToken.expires_at);
            if (new Date() > expiresAt) {
                return res.status(400).json({ error: 'Reset token has expired. Please request a new one.' });
            }

            // Get user
            db.get('SELECT * FROM users WHERE id = ?', [resetToken.user_id], async (userErr, user) => {
                if (userErr || !user) {
                    return res.status(500).json({ error: 'User not found' });
                }

                // Hash new password
                try {
                    const hashedPassword = await bcrypt.hash(newPassword, 10);
                    
                    // Update password
                    db.run(
                        'UPDATE users SET password = ?, updated_at = CURRENT_TIMESTAMP WHERE id = ?',
                        [hashedPassword, user.id],
                        function(updateErr) {
                            if (updateErr) {
                                console.error('Error updating password:', updateErr);
                                return res.status(500).json({ error: 'Failed to reset password' });
                            }

                            // Mark token as used
                            db.run(
                                'UPDATE password_reset_tokens SET used_at = CURRENT_TIMESTAMP WHERE id = ?',
                                [resetToken.id],
                                (tokenUpdateErr) => {
                                    if (tokenUpdateErr) {
                                        console.error('Error marking token as used:', tokenUpdateErr);
                                    }
                                }
                            );

                            res.json({ 
                                success: true, 
                                message: 'Password has been reset successfully' 
                            });
                        }
                    );
                } catch (hashError) {
                    console.error('Error hashing password:', hashError);
                    return res.status(500).json({ error: 'Failed to reset password' });
                }
            });
        }
    );
});

// Google OAuth endpoints
app.get('/api/auth/google', (req, res, next) => {
    if (!passport) {
        return res.redirect('/?error=oauth_not_configured');
    }
    passport.authenticate('google', { scope: ['profile', 'email'] })(req, res, next);
});

app.get('/api/auth/google/callback', 
    (req, res, next) => {
        if (!passport) {
            return res.redirect('/?error=oauth_not_configured');
        }
        passport.authenticate('google', { 
            failureRedirect: '/?error=auth_failed',
            session: false // We'll handle session manually
        }, (err, user, info) => {
            if (err) {
                console.error('OAuth error:', err);
                console.error('Error details:', err.message, err.stack);
                return res.redirect('/?error=oauth_error&message=' + encodeURIComponent(err.message || 'Unknown OAuth error'));
            }
            if (!user) {
                console.error('No user returned from OAuth');
                return res.redirect('/?error=auth_failed');
            }
            
            // Successful authentication - manually create session
            req.logIn(user, (err) => {
                if (err) {
                    console.error('Login error:', err);
                    return res.redirect('/?error=login_failed');
                }
                // Set session userId
                req.session.userId = user.id;
                
                // Simplified: No device token merging (like uncensored.chat)
                req.session.save((err) => {
                    if (err) {
                        console.error('Session save error:', err);
                        return res.redirect('/?error=session_failed');
                    }
                    console.log('OAuth success for user:', user.email);
                    res.redirect('/?auth=success&user=' + encodeURIComponent(user.email));
                });
            });
        })(req, res, next);
    }
);

// Get current user info
app.get('/api/user/me', requireAuth, (req, res) => {
    const userId = req.session.userId;
    
    db.get('SELECT id, email, plan, display_name, profile_picture, email_verified, google_id, tokens FROM users WHERE id = ?', [userId], (err, user) => {
        if (err || !user) {
            return res.status(500).json({ error: 'Failed to load user' });
        }
        
        // Simplified: Calculate tokens from usage history (like uncensored.chat - server-side only)
        getOrInitializeUserTokens(userId, user.plan || 'free', (tokenErr, remainingTokens) => {
            if (tokenErr) {
                console.error('Error getting user tokens:', tokenErr);
                remainingTokens = 0;
            }
            
            // Get token usage stats
            db.all(
            `SELECT operation_type, SUM(tokens_used) as total_tokens, COUNT(*) as operation_count 
             FROM token_usage 
             WHERE user_id = ? 
             GROUP BY operation_type`,
            [userId],
            (usageErr, usageStats) => {
                const usage = {};
                if (!usageErr && usageStats) {
                    usageStats.forEach(stat => {
                        usage[stat.operation_type] = {
                            totalTokens: stat.total_tokens,
                            operationCount: stat.operation_count
                        };
                    });
                }
                
                const allocatedTokens = PLAN_TOKENS[user.plan] || PLAN_TOKENS.free;
                // #region agent log
                agentLog({
                    hypothesisId: 'H1',
                    location: 'server.js:/api/user/me',
                    message: 'Fetched user profile',
                    data: {
                        userId,
                        plan: user.plan,
                        hasProfilePicture: !!user.profile_picture,
                        remainingTokens: remainingTokens === Infinity ? 'unlimited' : remainingTokens
                    }
                });
                // #endregion
                
                res.json({
                    id: user.id,
                    email: user.email,
                    plan: user.plan,
                    displayName: user.display_name || null,
                    profilePicture: user.profile_picture || null,
                    emailVerified: user.email_verified === 1,
                    googleId: user.google_id || null,
                    remainingToken: remainingTokens === Infinity ? 'unlimited' : (remainingTokens || 0), // Match uncensored.chat field name
                    tokens: remainingTokens === Infinity ? 'unlimited' : (remainingTokens || 0), // Keep for backward compatibility
                    tokensAllocated: allocatedTokens === Infinity ? 'unlimited' : allocatedTokens,
                    usage: usage
                });
            }
            );
        });
    });
});

// Update user profile
app.put('/api/user/profile', requireAuth, (req, res) => {
    const userId = req.session.userId;
    const { displayName, profilePicture } = req.body;
    
    console.log('Profile update request:', { userId, displayName, profilePicture: profilePicture ? 'provided' : 'not provided' });
    
    const updates = [];
    const values = [];
    
    // Handle displayName - allow empty strings but convert null/undefined to null
    if (displayName !== undefined) {
        updates.push('display_name = ?');
        // Save empty string as empty string, null as null
        values.push(displayName === null || displayName === '' ? null : displayName.trim());
    }
    
    // Handle profilePicture - allow empty strings but convert null/undefined to null
    if (profilePicture !== undefined) {
        updates.push('profile_picture = ?');
        // Save empty string as null, otherwise save as-is
        values.push(profilePicture === null || profilePicture === '' ? null : profilePicture);
    }
    
    if (updates.length === 0) {
        console.error('No updates provided in profile update request');
        return res.status(400).json({ error: 'No updates provided' });
    }
    
    updates.push('updated_at = CURRENT_TIMESTAMP');
    values.push(userId);
    
    const updateQuery = `UPDATE users SET ${updates.join(', ')} WHERE id = ?`;
    console.log('Executing update query:', updateQuery);
    console.log('With values:', values.map((v, i) => i === values.length - 1 ? v : (typeof v === 'string' && v.length > 50 ? v.substring(0, 50) + '...' : v)));
    
    db.run(
        updateQuery,
        values,
        function(err) {
            if (err) {
                console.error('Error updating profile:', err);
                return res.status(500).json({ error: 'Failed to update profile', details: err.message });
            }
            
            console.log('Profile update successful, rows affected:', this.changes);
            
            if (this.changes === 0) {
                console.warn('No rows were updated - user may not exist or values unchanged');
            }
            
            // Return updated user data - verify the update was successful
            db.get('SELECT id, email, plan, display_name, profile_picture, email_verified FROM users WHERE id = ?', [userId], (err, user) => {
                if (err || !user) {
                    console.error('Error fetching updated user:', err);
                    return res.status(500).json({ error: 'Failed to load updated user' });
                }
                
                console.log('Returning updated user data from database:', {
                    id: user.id,
                    email: user.email,
                    displayName: user.display_name,
                    profilePicture: user.profile_picture ? 'present' : 'null',
                    displayNameLength: user.display_name ? user.display_name.length : 0,
                    profilePictureLength: user.profile_picture ? user.profile_picture.length : 0
                });
                
                res.json({
                    id: user.id,
                    email: user.email,
                    plan: user.plan,
                    displayName: user.display_name || null, // Ensure null instead of undefined
                    profilePicture: user.profile_picture || null, // Ensure null instead of undefined
                    emailVerified: user.email_verified === 1
                });
            });
        }
    );
});

// Get token balance and usage
app.get('/api/user/tokens', requireAuth, (req, res) => {
    // Simplified: Server-side only token tracking (like uncensored.chat)
    const userId = req.session.userId;
    
    // Get user's plan from database
    db.get('SELECT plan FROM users WHERE id = ?', [userId], (userErr, user) => {
        if (userErr || !user) {
            return res.status(500).json({ error: 'Failed to load user data' });
        }
        
        const userPlan = user.plan || 'free';
        const allocatedTokens = PLAN_TOKENS[userPlan] || PLAN_TOKENS.free;
        
        // Calculate tokens from usage history
        getOrInitializeUserTokens(userId, userPlan, (tokenErr, remainingTokens) => {
            if (tokenErr) {
                return res.status(500).json({ error: 'Failed to load tokens' });
            }
            
            const tokensUsed = allocatedTokens - (remainingTokens || 0);
            // #region agent log
            agentLog({
                hypothesisId: 'H3',
                location: 'server.js:/api/user/tokens',
                message: 'Fetched tokens',
                data: {
                    userId,
                    plan: userPlan,
                    remainingTokens: remainingTokens === Infinity ? 'unlimited' : remainingTokens,
                    allocatedTokens: allocatedTokens === Infinity ? 'unlimited' : allocatedTokens
                }
            });
            // #endregion
            
            // Get usage stats
            db.all(
                `SELECT operation_type, SUM(tokens_used) as total_tokens, COUNT(*) as operation_count 
                 FROM token_usage 
                 WHERE user_id = ?
                 GROUP BY operation_type`,
                [userId],
                (usageErr, usageStats) => {
                    const usage = {};
                    if (!usageErr && usageStats) {
                        usageStats.forEach(stat => {
                            usage[stat.operation_type] = {
                                totalTokens: stat.total_tokens,
                                operationCount: stat.operation_count
                            };
                        });
                    }
                    
                    res.json({
                        tokens: remainingTokens === Infinity ? 'unlimited' : (remainingTokens || 0),
                        remainingToken: remainingTokens === Infinity ? 'unlimited' : (remainingTokens || 0), // Match uncensored.chat
                        tokensAllocated: allocatedTokens === Infinity ? 'unlimited' : allocatedTokens,
                        tokensUsed: tokensUsed,
                        plan: userPlan,
                        usage: usage
                    });
                }
            );
        });
    });
});

// DISABLED: IP-based token tracking removed (now requires authentication like uncensored.chat)
app.get('/api/tokens/ip', (req, res) => {
    // Return error - authentication required
    res.status(401).json({ 
        error: 'Authentication required',
        message: 'Please sign in to view your token balance.'
    });
});

// OLD CODE - DISABLED (kept for reference)
/*
app.get('/api/tokens/ip', (req, res) => {
    const clientIP = getClientIP(req);
    const deviceFingerprint = getDeviceFingerprint(req, res);
    
    getIPTokenTracking(clientIP, deviceFingerprint, (err, tracking) => {
        if (err) {
            return res.status(500).json({ error: 'Failed to load IP token balance' });
        }
        
        // Get usage stats for this session (with fallback for legacy tables)
        db.all(
            `SELECT operation_type, SUM(tokens_used) as total_tokens, COUNT(*) as operation_count 
             FROM ip_token_usage 
             WHERE ip_address = ? AND device_fingerprint = ?
             GROUP BY operation_type`,
            [clientIP, deviceFingerprint],
            (usageErr, usageStats) => {
                if (usageErr && usageErr.code === 'SQLITE_ERROR' && usageErr.message.includes('no such column')) {
                    // Fallback: get stats without device_fingerprint
                    db.all(
                        `SELECT operation_type, SUM(tokens_used) as total_tokens, COUNT(*) as operation_count 
                         FROM ip_token_usage 
                         WHERE ip_address = ?
                         GROUP BY operation_type`,
                        [clientIP],
                        (legacyUsageErr, legacyUsageStats) => {
                            const usage = {};
                            if (!legacyUsageErr && legacyUsageStats) {
                                legacyUsageStats.forEach(stat => {
                                    usage[stat.operation_type] = {
                                        totalTokens: stat.total_tokens,
                                        operationCount: stat.operation_count
                                    };
                                });
                            }
                            
                            res.json({
                                tokens: tracking.tokens_remaining || 0,
                                tokensAllocated: tracking.tokens_allocated || PLAN_TOKENS.free,
                                tokensUsed: tracking.tokens_used || 0,
                                plan: 'free',
                                usage: usage
                            });
                        }
                    );
                    return;
                }
                
                if (usageErr) {
                    return res.status(500).json({ error: 'Failed to load usage stats' });
                }
                
                const usage = {};
                if (usageStats) {
                    usageStats.forEach(stat => {
                        usage[stat.operation_type] = {
                            totalTokens: stat.total_tokens,
                            operationCount: stat.operation_count
                        };
                    });
                }
                
                res.json({
                    tokens: tracking.tokens_remaining || 0,
                    tokensAllocated: tracking.tokens_allocated || PLAN_TOKENS.free,
                    tokensUsed: tracking.tokens_used || 0,
                    plan: 'free',
                    usage: usage
                });
            }
        );
    });
});
*/

// Change password
app.post('/api/user/change-password', requireAuth, (req, res) => {
    const userId = req.session.userId;
    const { currentPassword, newPassword } = req.body;
    
    if (!currentPassword || !newPassword) {
        return res.status(400).json({ error: 'Current password and new password are required' });
    }
    
    if (newPassword.length < 8) {
        return res.status(400).json({ error: 'Password must be at least 8 characters long' });
    }
    
    // Get user with password
    db.get('SELECT * FROM users WHERE id = ?', [userId], async (err, user) => {
        if (err || !user) {
            return res.status(500).json({ error: 'Failed to load user' });
        }
        
        // Check if user has a password (Google OAuth users might not have one)
        if (!user.password) {
            return res.status(400).json({ error: 'Password change not available for Google OAuth accounts' });
        }
        
        // Verify current password
        const isValid = await bcrypt.compare(currentPassword, user.password);
        if (!isValid) {
            return res.status(401).json({ error: 'Current password is incorrect' });
        }
        
        // Hash new password
        const hashedPassword = await bcrypt.hash(newPassword, 10);
        
        // Update password
        db.run(
            'UPDATE users SET password = ?, updated_at = CURRENT_TIMESTAMP WHERE id = ?',
            [hashedPassword, userId],
            function(err) {
                if (err) {
                    console.error('Error changing password:', err);
                    return res.status(500).json({ error: 'Failed to change password' });
                }
                
                res.json({ success: true, message: 'Password changed successfully' });
            }
        );
    });
});

// ============================================
// CONVERSATION API ENDPOINTS
// ============================================

// Get all conversations for the authenticated user
app.get('/api/conversations', requireAuth, (req, res) => {
    const userId = req.session.userId;
    
    db.all(
        `SELECT c.*, 
         (SELECT COUNT(*) FROM messages WHERE conversation_id = c.id) as message_count,
         (SELECT content FROM messages WHERE conversation_id = c.id ORDER BY created_at DESC LIMIT 1) as last_message
         FROM conversations c 
         WHERE c.user_id = ? 
         ORDER BY c.updated_at DESC`,
        [userId],
        (err, conversations) => {
            if (err) {
                console.error('Error fetching conversations:', err);
                return res.status(500).json({ error: 'Failed to load conversations' });
            }
            
            // Format conversations for frontend
            const formattedConversations = conversations.map(conv => ({
                id: conv.id,
                title: conv.title || 'New Chat',
                model: conv.model || 'model2',
                createdAt: conv.created_at,
                updatedAt: conv.updated_at,
                messageCount: conv.message_count || 0,
                lastMessage: conv.last_message || ''
            }));
            
            res.json({ conversations: formattedConversations });
        }
    );
});

// Get a specific conversation with all messages
app.get('/api/conversations/:id', requireAuth, (req, res) => {
    const userId = req.session.userId;
    const conversationId = req.params.id;
    
    // First verify the conversation belongs to the user
    db.get(
        'SELECT * FROM conversations WHERE id = ? AND user_id = ?',
        [conversationId, userId],
        (err, conversation) => {
            if (err) {
                return res.status(500).json({ error: 'Failed to load conversation' });
            }
            
            if (!conversation) {
                return res.status(404).json({ error: 'Conversation not found' });
            }
            
            // Get all messages for this conversation
            db.all(
                'SELECT * FROM messages WHERE conversation_id = ? ORDER BY created_at ASC',
                [conversationId],
                (err, messages) => {
                    if (err) {
                        return res.status(500).json({ error: 'Failed to load messages' });
                    }
                    
                    res.json({
                        id: conversation.id,
                        title: conversation.title || 'New Chat',
                        model: conversation.model || 'model2',
                        createdAt: conversation.created_at,
                        updatedAt: conversation.updated_at,
                        messages: messages.map(msg => ({
                            role: msg.role,
                            content: msg.content,
                            createdAt: msg.created_at
                        }))
                    });
                }
            );
        }
    );
});

// Create a new conversation
app.post('/api/conversations', requireAuth, (req, res) => {
    const userId = req.session.userId;
    const { title, model } = req.body;
    
    db.run(
        'INSERT INTO conversations (user_id, title, model) VALUES (?, ?, ?)',
        [userId, title || 'New Chat', model || 'model2'],
        function(err) {
            if (err) {
                console.error('Error creating conversation:', err);
                return res.status(500).json({ error: 'Failed to create conversation' });
            }
            
            res.json({
                success: true,
                conversation: {
                    id: this.lastID,
                    title: title || 'New Chat',
                    model: model || 'model2',
                    createdAt: new Date().toISOString(),
                    updatedAt: new Date().toISOString(),
                    messages: []
                }
            });
        }
    );
});

// Update a conversation (title, model, etc.)
app.put('/api/conversations/:id', requireAuth, (req, res) => {
    const userId = req.session.userId;
    const conversationId = req.params.id;
    const { title, model } = req.body;
    
    // Verify ownership
    db.get(
        'SELECT * FROM conversations WHERE id = ? AND user_id = ?',
        [conversationId, userId],
        (err, conversation) => {
            if (err || !conversation) {
                return res.status(404).json({ error: 'Conversation not found' });
            }
            
            const updates = [];
            const values = [];
            
            if (title !== undefined) {
                updates.push('title = ?');
                values.push(title);
            }
            if (model !== undefined) {
                updates.push('model = ?');
                values.push(model);
            }
            
            if (updates.length === 0) {
                return res.status(400).json({ error: 'No updates provided' });
            }
            
            updates.push('updated_at = CURRENT_TIMESTAMP');
            values.push(conversationId);
            
            db.run(
                `UPDATE conversations SET ${updates.join(', ')} WHERE id = ?`,
                values,
                function(err) {
                    if (err) {
                        return res.status(500).json({ error: 'Failed to update conversation' });
                    }
                    
                    res.json({ success: true });
                }
            );
        }
    );
});

// Delete a conversation
app.delete('/api/conversations/:id', requireAuth, (req, res) => {
    const userId = req.session.userId;
    const conversationId = req.params.id;
    
    // Verify ownership
    db.get(
        'SELECT * FROM conversations WHERE id = ? AND user_id = ?',
        [conversationId, userId],
        (err, conversation) => {
            if (err || !conversation) {
                return res.status(404).json({ error: 'Conversation not found' });
            }
            
            // Delete conversation (messages will be cascade deleted)
            db.run(
                'DELETE FROM conversations WHERE id = ?',
                [conversationId],
                function(err) {
                    if (err) {
                        return res.status(500).json({ error: 'Failed to delete conversation' });
                    }
                    
                    res.json({ success: true });
                }
            );
        }
    );
});

// Add a message to a conversation
app.post('/api/conversations/:id/messages', requireAuth, (req, res) => {
    const userId = req.session.userId;
    const conversationId = req.params.id;
    const { role, content } = req.body;
    
    if (!role || !content) {
        return res.status(400).json({ error: 'Role and content are required' });
    }
    
    if (!['user', 'assistant'].includes(role)) {
        return res.status(400).json({ error: 'Invalid role. Must be "user" or "assistant"' });
    }
    
    // Verify ownership
    db.get(
        'SELECT * FROM conversations WHERE id = ? AND user_id = ?',
        [conversationId, userId],
        (err, conversation) => {
            if (err || !conversation) {
                return res.status(404).json({ error: 'Conversation not found' });
            }
            
            // Insert message
            db.run(
                'INSERT INTO messages (conversation_id, role, content) VALUES (?, ?, ?)',
                [conversationId, role, content],
                function(err) {
                    if (err) {
                        return res.status(500).json({ error: 'Failed to add message' });
                    }
                    
                    // Update conversation's updated_at timestamp
                    db.run(
                        'UPDATE conversations SET updated_at = CURRENT_TIMESTAMP WHERE id = ?',
                        [conversationId]
                    );
                    
                    // Update title if it's the first user message
                    if (role === 'user' && !conversation.title || conversation.title === 'New Chat') {
                        const title = content.substring(0, 50).trim();
                        db.run(
                            'UPDATE conversations SET title = ? WHERE id = ?',
                            [title, conversationId]
                        );
                    }
                    
                    res.json({
                        success: true,
                        message: {
                            id: this.lastID,
                            role,
                            content,
                            createdAt: new Date().toISOString()
                        }
                    });
                }
            );
        }
    );
});

app.get('/api/dashboard', requireAuth, (req, res) => {
    const userId = req.session.userId;

    db.get('SELECT * FROM users WHERE id = ?', [userId], (err, user) => {
        if (err || !user) {
            return res.status(500).json({ error: 'Failed to load dashboard' });
        }

        const now = new Date();
        const month = now.getMonth() + 1;
        const year = now.getFullYear();

        // Get API usage
        db.get(
            'SELECT api_calls FROM api_usage WHERE user_id = ? AND month = ? AND year = ?',
            [userId, month, year],
            (err, usage) => {
                const apiCalls = usage ? usage.api_calls : 0;

                res.json({
                    subscription: {
                        plan: user.plan.charAt(0).toUpperCase() + user.plan.slice(1),
                        details: user.plan === 'free' ? 'Limited access' : 'Full access with API keys'
                    },
                    apiKeys: {
                        key1: user.plan !== 'free' ? API_KEYS.model1 : null,
                        key2: user.plan !== 'free' ? API_KEYS.model2 : null
                    },
                    usage: {
                        calls: apiCalls
                    },
                    models: [
                        'Huihui Qwen3 Coder 30B',
                        'Qwen3 Omega Directive 22B'
                    ]
                });
            }
        );
    });
});

app.post('/api/chat', requireAuth, async (req, res) => {
    const userId = req.session.userId;
    const { message, model } = req.body;

    if (!message) {
        return res.status(400).json({ error: 'Message is required' });
    }

    // CRITICAL: Use device tokens as source of truth (they MUST match logged-out state)
    const clientIP = getClientIP(req);
    const deviceFingerprint = getDeviceFingerprint(req, res);
    
    const userTokenData = await new Promise((resolve, reject) => {
        db.get('SELECT plan FROM users WHERE id = ?', [userId], (err, user) => {
            if (err) return reject(err);
            if (!user) return reject(new Error('User not found'));
            
            // Get device tokens (source of truth)
            getIPTokenTracking(clientIP, deviceFingerprint, (deviceErr, deviceTracking) => {
                if (deviceErr || !deviceTracking) {
                    // Fallback to user tokens
                    getOrInitializeUserTokens(userId, user.plan || 'free', (tokenErr, tokensRemaining) => {
                        if (tokenErr) return reject(tokenErr);
                        const tokensAllocated = PLAN_TOKENS[user.plan] || PLAN_TOKENS.free;
                        resolve({ tokensRemaining, tokensAllocated, plan: user.plan || 'free' });
                    });
                } else {
                    const tokensRemaining = deviceTracking.tokens_remaining || 0;
                    const tokensAllocated = PLAN_TOKENS[user.plan] || PLAN_TOKENS.free;
                    // Sync user tokens to match device
                    db.run('UPDATE users SET tokens = ? WHERE id = ?', [tokensRemaining, userId], () => {});
                    resolve({ tokensRemaining, tokensAllocated, plan: user.plan || 'free' });
                }
            });
        });
    });

    // Estimate tokens needed (we'll calculate exact after response)
    const estimatedTokens = Math.ceil(message.length / 4) + 100; // Rough estimate

    // Check user token balance
    if (userTokenData.tokensRemaining < estimatedTokens) {
        return res.status(402).json({ 
            error: 'Insufficient tokens',
            message: 'You have reached your token limit. Please upgrade to a paid plan to continue.',
            tokensRemaining: userTokenData.tokensRemaining,
            tokensRequired: estimatedTokens
        });
    }

        try {
            const apiKey = getApiKey(model || 'model1');
            const modelName = getModelName(model || 'model1');

            const response = await axios.post(
                `${WEBUI_BASE_URL}/api/v1/chat/completions`,
                {
                    model: modelName,
                    messages: [
                        { role: 'user', content: message }
                    ],
                    stream: false
                },
                {
                    headers: {
                        'Authorization': `Bearer ${apiKey}`,
                        'Content-Type': 'application/json'
                    }
                }
            );

            const aiResponse = response.data.choices[0]?.message?.content || 'No response received';

            // Calculate actual tokens used
            const tokenCalc = calculateTextTokens(message, aiResponse);
            const tokensUsed = tokenCalc.totalTokens;

            // Check again with actual token count
            if (userTokenData.tokensRemaining < tokensUsed) {
                return res.status(402).json({ 
                    error: 'Insufficient tokens',
                    message: 'You have reached your token limit. Please upgrade to a paid plan to continue.',
                    tokensRemaining: userTokenData.tokensRemaining,
                    tokensRequired: tokensUsed
                });
            }

            // CRITICAL: Deduct from BOTH user account AND device tracking (they MUST stay in sync)
            const clientIP = getClientIP(req);
            const deviceFingerprint = getDeviceFingerprint(req, res);
            
            // Deduct from device tracking (source of truth)
            deductIPTokens(clientIP, deviceFingerprint, tokensUsed, 'text', tokenCalc.inputTokens, tokenCalc.outputTokens, (deviceDeductErr) => {
                if (deviceDeductErr) {
                    console.error('Error deducting device tokens:', deviceDeductErr);
                }
                
                // Also deduct from user account (for consistency)
                deductTokens(userId, tokensUsed, 'text', tokenCalc.inputTokens, tokenCalc.outputTokens, (userDeductErr) => {
                    if (userDeductErr) {
                        console.error('Error deducting user tokens:', userDeductErr);
                    } else {
                        console.log(`[TOKEN SYNC] Deducted ${tokensUsed} tokens from both device and user ${userId}`);
                    }
                });
            });
            
            // Log token usage
            db.run(
                'INSERT INTO token_usage (user_id, operation_type, tokens_used, input_tokens, output_tokens) VALUES (?, ?, ?, ?, ?)',
                [userId, 'text', tokensUsed, tokenCalc.inputTokens, tokenCalc.outputTokens],
                (logErr) => {
                    if (logErr) console.error('Error logging token usage:', logErr);
                }
            );

            // Save to chat history
            db.run(
                'INSERT INTO chat_history (user_id, message, response, model) VALUES (?, ?, ?, ?)',
                [userId, message, aiResponse, modelName]
            );

            // Update API usage
            const now = new Date();
            const month = now.getMonth() + 1;
            const year = now.getFullYear();

            db.run(
                `INSERT INTO api_usage (user_id, api_calls, month, year) 
                 VALUES (?, 1, ?, ?)
                 ON CONFLICT(user_id, month, year) DO UPDATE SET api_calls = api_calls + 1`,
                [userId, month, year]
            );

            // Get updated user token balance
            db.get('SELECT tokens FROM users WHERE id = ?', [userId], (err, updatedUser) => {
                if (err) {
                    console.error('Error getting updated token balance:', err);
                }
                res.json({ 
                    response: aiResponse,
                    tokensUsed: tokensUsed,
                    tokensRemaining: updatedUser?.tokens || (userTokenData.tokensRemaining - tokensUsed)
                });
            });
        } catch (error) {
            console.error('Chat API error:', error.response?.data || error.message);
            res.status(500).json({ error: '🤔 Hmm, something went wrong while getting a response. Please try again!' });
        }
});

// Telegram webhook/polling endpoint to get chat ID (for setup)
app.get('/api/telegram/get-chat-id', async (req, res) => {
    try {
        const updates = await getTelegramUpdates();
        
        if (updates.result && updates.result.length > 0) {
            const chatIds = new Set();
            updates.result.forEach(update => {
                if (update.message && update.message.chat) {
                    chatIds.add({
                        chatId: update.message.chat.id,
                        firstName: update.message.chat.first_name,
                        username: update.message.chat.username,
                        text: update.message.text
                    });
                }
            });
            
            res.json({
                success: true,
                message: 'Send a message to your bot first, then refresh this page',
                chats: Array.from(chatIds),
                instructions: 'Copy one of the chat IDs and add it to your .env file as TELEGRAM_CHAT_ID'
            });
        } else {
            res.json({
                success: false,
                message: 'No messages found. Send /start to your bot in Telegram first.',
                instructions: 'Open Telegram, search for your bot, and send /start'
            });
        }
    } catch (error) {
        res.status(500).json({ 
            error: 'Failed to get updates', 
            message: error.message 
        });
    }
});

// Test Telegram notification endpoint
app.get('/api/telegram/test', async (req, res) => {
    try {
        await sendTelegramNotification('🧪 Test notification from InfiNet AI!');
        res.json({ success: true, message: 'Test notification sent!' });
    } catch (error) {
        res.status(500).json({ 
            success: false, 
            error: 'Failed to send notification', 
            message: error.message 
        });
    }
});

// Start server
app.listen(PORT, async () => {
    console.log(`AI Uncensored Platform running on http://localhost:${PORT}`);
    
    // Check and start ComfyUI on server startup
    setTimeout(async () => {
        console.log('[ComfyUI] Checking ComfyUI service status on startup...');
        const isHealthy = await checkComfyUIHealth();
        if (!isHealthy) {
            console.log('[ComfyUI] Service is not running, attempting to start...');
            try {
                await startComfyUI();
                console.log('[ComfyUI] Service started successfully on server startup');
            } catch (error) {
                console.error('[ComfyUI] Failed to start service on startup:', error.message);
                console.error('[ComfyUI] You may need to manually start ComfyUI or check the logs at:', COMFYUI_LOG_FILE);
            }
        } else {
            console.log('[ComfyUI] Service is already running');
        }
    }, 3000); // Wait 3 seconds after server starts to check ComfyUI
});


// ============================================
// OLLAMA API KEY MANAGEMENT SYSTEM
// ============================================

const API_KEYS_FILE = path.join(__dirname, 'api-keys.json');
const MODEL_ASSIGNMENTS_FILE = path.join(__dirname, 'model-assignments.json');

// Load API keys from JSON file
function loadApiKeys() {
    try {
        if (fs.existsSync(API_KEYS_FILE)) {
            const data = fs.readFileSync(API_KEYS_FILE, 'utf8');
            return JSON.parse(data);
        }
    } catch (error) {
        console.error('Error loading API keys:', error);
    }
    return {};
}

// Load model assignments (which admin models are assigned to model1/model2)
function loadModelAssignments() {
    try {
        if (fs.existsSync(MODEL_ASSIGNMENTS_FILE)) {
            const data = fs.readFileSync(MODEL_ASSIGNMENTS_FILE, 'utf8');
            return JSON.parse(data);
        }
    } catch (error) {
        console.error('Error loading model assignments:', error);
    }
    return { model1: null, model2: null }; // Default: no assignments
}

// Save model assignments
function saveModelAssignments(assignments) {
    try {
        fs.writeFileSync(MODEL_ASSIGNMENTS_FILE, JSON.stringify(assignments, null, 2));
        return true;
    } catch (error) {
        console.error('Error saving model assignments:', error);
        return false;
    }
}

// Save API keys to JSON file
function saveApiKeys(apiKeys) {
    try {
        fs.writeFileSync(API_KEYS_FILE, JSON.stringify(apiKeys, null, 2));
        return true;
    } catch (error) {
        console.error('Error saving API keys:', error);
        return false;
    }
}

// Generate a new API key
function generateApiKey() {
    const randomBytes = crypto.randomBytes(32);
    return 'sk-' + randomBytes.toString('hex');
}

// Mask API key for display (show first 8 and last 4 characters)
function maskApiKey(apiKey) {
    if (!apiKey || apiKey.length < 12) {
        return 'sk-****';
    }
    const prefix = apiKey.substring(0, 8); // First 8 chars (e.g., "sk-2VOOb")
    const suffix = apiKey.substring(apiKey.length - 4); // Last 4 chars (e.g., "Kjzo")
    const maskedLength = apiKey.length - 12; // How many chars to mask
    const masked = '*'.repeat(Math.min(maskedLength, 20)); // Max 20 asterisks
    return `${prefix}${masked}${suffix}`;
}

// Validate API key and return model info
function validateApiKey(apiKey) {
    // First check assigned admin-managed models
    const assignments = loadModelAssignments();
    const apiKeys = loadApiKeys();
    
    if (assignments.model1) {
        const assignedModel = apiKeys[assignments.model1];
        if (assignedModel && assignedModel.apiKey === apiKey && assignedModel.active) {
            return { valid: true, modelId: 'model1', modelName: assignedModel.modelName, displayName: assignedModel.displayName || 'InfiNet-Coder' };
        }
    }
    if (assignments.model2) {
        const assignedModel = apiKeys[assignments.model2];
        if (assignedModel && assignedModel.apiKey === apiKey && assignedModel.active) {
            return { valid: true, modelId: 'model2', modelName: assignedModel.modelName, displayName: assignedModel.displayName || 'InfiNet-Thinker' };
        }
    }
    
    // Check if this API key belongs to any admin-managed model (even if inactive)
    // If it does, don't allow it to work if it's inactive
    for (const [modelId, keyData] of Object.entries(apiKeys)) {
        if (keyData.apiKey === apiKey) {
            // If it's in admin-managed models, it must be active to work
            if (keyData.active) {
            return { valid: true, modelId, modelName: keyData.modelName, displayName: keyData.displayName };
            } else {
                // Key exists but is deactivated - reject it (even if it matches hardcoded key)
                return { valid: false };
            }
        }
    }
    
    // Only use hardcoded keys if they don't match any admin-managed model
    // This prevents deactivated admin models from working via hardcoded fallback
    if (apiKey === API_KEYS.model1) {
        return { valid: true, modelId: 'model1', modelName: MODELS.model1, displayName: 'InfiNet-Coder' };
    }
    if (apiKey === API_KEYS.model2) {
        // For model2, check if there's a deactivated admin-managed model that uses the same model name
        // If so, don't allow the hardcoded fallback
        for (const [modelId, keyData] of Object.entries(apiKeys)) {
            if (keyData.modelName === MODELS.model2 && !keyData.active) {
                // There's a deactivated admin-managed model with the same model name - reject hardcoded key
    return { valid: false };
            }
        }
        return { valid: true, modelId: 'model2', modelName: MODELS.model2, displayName: 'InfiNet-Thinker' };
    }
    
    return { valid: false };
}

// Admin route moved above to prevent static middleware from bypassing it

// Admin authentication middleware with enhanced security (for API endpoints)
function requireAdmin(req, res, next) {
    const ip = req.ip || req.connection.remoteAddress || req.headers['x-forwarded-for']?.split(',')[0] || 'unknown';
    
    // Check if IP is blocked
    if (BLOCKED_IPS.has(ip)) {
        logSecurityEvent('BLOCKED_IP_ATTEMPT', req, { ip });
        return res.status(403).json({ error: 'Access denied' });
    }
    
    // IP whitelist check (if configured)
    if (ADMIN_IP_WHITELIST.length > 0 && !ADMIN_IP_WHITELIST.includes(ip)) {
        logSecurityEvent('UNAUTHORIZED_IP_ATTEMPT', req, { ip, whitelist: ADMIN_IP_WHITELIST });
        return res.status(403).json({ error: 'Access denied: IP not whitelisted' });
    }
    
    // Rate limiting for admin endpoints (stricter)
    const adminRateLimit = rateLimit(5, 60000); // 5 requests per minute for admin
    adminRateLimit(req, res, () => {
        const authHeader = req.headers.authorization;
        if (!authHeader || !authHeader.startsWith('Basic ')) {
            logSecurityEvent('ADMIN_AUTH_FAILED', req, { reason: 'Missing or invalid auth header' });
            return res.status(401).json({ error: 'Admin authentication required' });
        }
        
        try {
            const credentials = Buffer.from(authHeader.split(' ')[1], 'base64').toString('utf8');
            const [username, password] = credentials.split(':');
            
            if (username === ADMIN_USERNAME && password === ADMIN_PASSWORD) {
                logSecurityEvent('ADMIN_AUTH_SUCCESS', req, { username });
                next();
            } else {
                logSecurityEvent('ADMIN_AUTH_FAILED', req, { reason: 'Invalid credentials', username });
                res.status(401).json({ error: 'Invalid admin credentials' });
            }
        } catch (error) {
            logSecurityEvent('ADMIN_AUTH_ERROR', req, { error: error.message });
            res.status(401).json({ error: 'Invalid authentication format' });
        }
    });
}

// ============================================
// COMFYUI INTEGRATION
// ============================================

// ComfyUI configuration
const COMFYUI_URL = process.env.COMFYUI_URL || 'http://127.0.0.1:8188';
const COMFYUI_MODEL = process.env.COMFYUI_MODEL || 'realisticVisionV60.safetensors';
const COMFYUI_START_SCRIPT = '/opt/ComfyUI/start_comfyui.sh';
const COMFYUI_LOG_FILE = '/opt/ComfyUI/comfyui.log';

// Check if ComfyUI is running and accessible
async function checkComfyUIHealth() {
    try {
        const response = await axios.get(`${COMFYUI_URL}/system_stats`, { 
            timeout: 5000,
            validateStatus: (status) => status < 500 // Accept 200-499 as "service is up"
        });
        return true;
    } catch (error) {
        // Try alternative endpoint
        try {
            const response = await axios.get(`${COMFYUI_URL}/queue`, { 
                timeout: 5000,
                validateStatus: (status) => status < 500
            });
            return true;
        } catch (err) {
            console.log('[ComfyUI] Health check failed:', err.message);
            return false;
        }
    }
}

// Start ComfyUI service
function startComfyUI() {
    return new Promise((resolve, reject) => {
        const { exec } = require('child_process');
        const env = {
            ...process.env,
            PATH: process.env.PATH || '/usr/local/sbin:/usr/local/bin:/usr/sbin:/usr/bin:/sbin:/bin',
            HOME: process.env.HOME || '/root'
        };

        // Check if script exists
        const fs = require('fs');
        if (!fs.existsSync(COMFYUI_START_SCRIPT)) {
            console.error(`[ComfyUI] Start script not found: ${COMFYUI_START_SCRIPT}`);
            reject(new Error(`Start script not found: ${COMFYUI_START_SCRIPT}`));
            return;
        }

        console.log('[ComfyUI] Starting ComfyUI service...');
        exec(`bash ${COMFYUI_START_SCRIPT} > ${COMFYUI_LOG_FILE} 2>&1 &`, { env: env }, (error, stdout, stderr) => {
            if (error) {
                console.error('[ComfyUI] Start error:', error);
                reject(error);
                return;
            }
            console.log('[ComfyUI] Start command executed, waiting for service to be ready...');
            
            // Wait and verify ComfyUI is actually running
            let attempts = 0;
            const maxAttempts = 30; // 30 seconds max wait
            const checkInterval = setInterval(async () => {
                attempts++;
                const isHealthy = await checkComfyUIHealth();
                if (isHealthy) {
                    clearInterval(checkInterval);
                    console.log('[ComfyUI] Service is now running and accessible');
                    resolve(true);
                } else if (attempts >= maxAttempts) {
                    clearInterval(checkInterval);
                    console.error('[ComfyUI] Service did not become ready within timeout');
                    reject(new Error('ComfyUI did not start within timeout'));
                } else {
                    console.log(`[ComfyUI] Waiting for service... (${attempts}/${maxAttempts})`);
                }
            }, 1000);
        });
    });
}

// Ensure ComfyUI is running before use
async function ensureComfyUIRunning() {
    const isHealthy = await checkComfyUIHealth();
    if (!isHealthy) {
        console.log('[ComfyUI] Service is not running, attempting to start...');
        try {
            await startComfyUI();
            return true;
        } catch (error) {
            console.error('[ComfyUI] Failed to start service:', error.message);
            return false;
        }
    }
    return true;
}

// Image generation keywords - if user message contains any of these, route to ComfyUI
// STRICT: Only route to ComfyUI when there's a CLEAR image context
// Words like "create", "generate", "make" alone should NOT trigger image generation
function isImageRequest(message, messageObj = null) {
    if (!message || typeof message !== 'string') return false;
    const lowerMessage = message.toLowerCase().trim();
    
    // CHECK FOR IMAGE-TO-IMAGE: Message starts with [Image-to-Image] or has imageData
    if (lowerMessage.startsWith('[image-to-image]') || (messageObj && messageObj.imageData)) {
        console.log('[Image Detection] Image-to-Image request detected');
        return true;
    }
    
    // STRICT PATTERN 1: Explicit image generation phrases (must contain image-related word)
    const explicitImagePhrases = [
        'generate image', 'create image', 'make image', 'draw image', 'paint image',
        'generate a image', 'create a image', 'make a image', 'draw a image',
        'generate an image', 'create an image', 'make an image', 'draw an image',
        'generate picture', 'create picture', 'make picture', 'draw picture',
        'generate a picture', 'create a picture', 'make a picture', 'draw a picture',
        'generate photo', 'create photo', 'make photo', 'draw photo',
        'generate a photo', 'create a photo', 'make a photo', 'draw a photo',
        'image of', 'picture of', 'photo of',
        'text to image', 'image generation', 'ai image',
        'stable diffusion', 'diffusion model',
        'portrait of', 'landscape of', 'scene of',
        'visual of', 'graphic of', 'illustration of', 'artwork of',
        'render an image', 'render a picture', 'render image', 'render picture'
    ];
    
    const hasExplicitPhrase = explicitImagePhrases.some(phrase => lowerMessage.includes(phrase));
    if (hasExplicitPhrase) return true;
    
    // STRICT PATTERN 2: Image word MUST appear near action word (within 5 words)
    // This ensures "create a script" doesn't match, but "create an image" does
    const imageWords = /\b(image|images|picture|pictures|photo|photos|img|imgs|pic|pics|visual|visuals|graphic|graphics|illustration|illustrations|artwork|artworks|portrait|portraits|landscape|landscapes|scene|scenes|sketch|sketches|drawing|drawings|painting|paintings)\b/gi;
    const actionWords = /\b(generate|generates|generated|generating|create|creates|created|creating|draw|draws|drew|drawing|make|makes|made|making|paint|paints|painted|painting|render|renders|rendered|rendering)\b/gi;
    
    const imageMatches = [...lowerMessage.matchAll(imageWords)];
    const actionMatches = [...lowerMessage.matchAll(actionWords)];
    
    // Check if any image word is within 5 words of any action word
    for (const imgMatch of imageMatches) {
        for (const actMatch of actionMatches) {
            const distance = Math.abs(imgMatch.index - actMatch.index);
            // Count words between them (rough estimate: ~5 chars per word)
            if (distance < 30) { // ~6 words apart
                return true;
            }
        }
    }
    
    // STRICT PATTERN 3: Check for image file extensions or formats (only if with action words)
    const hasImageFormat = /\b(png|jpg|jpeg|gif|webp|svg|bmp)\b/i.test(lowerMessage);
    if (hasImageFormat && actionMatches.length > 0) {
        // Check if format is near action word
        for (const actMatch of actionMatches) {
            const formatMatch = lowerMessage.match(/\b(png|jpg|jpeg|gif|webp|svg|bmp)\b/i);
            if (formatMatch && Math.abs(formatMatch.index - actMatch.index) < 30) {
                return true;
            }
        }
    }
    
    // If none of the strict patterns match, it's NOT an image request
    return false;
}

// Create a basic ComfyUI workflow for text-to-image
function createTextToImageWorkflow(prompt, width = 512, height = 512, steps = 20, cfg = 8, seed = -1) {
    // Generate random seed if not provided
    const finalSeed = seed === -1 ? Math.floor(Math.random() * 1000000000) : seed;
    
    return {
        "3": {
            "inputs": {
                "seed": finalSeed,
                "steps": steps,
                "cfg": cfg,
                "sampler_name": "euler",
                "scheduler": "normal",
                "denoise": 1,
                "model": ["4", 0],
                "positive": ["6", 0],
                "negative": ["7", 0],
                "latent_image": ["5", 0]
            },
            "class_type": "KSampler",
            "_meta": { "title": "KSampler" }
        },
        "4": {
            "inputs": { "ckpt_name": COMFYUI_MODEL },
            "class_type": "CheckpointLoaderSimple",
            "_meta": { "title": "Load Checkpoint" }
        },
        "5": {
            "inputs": {
                "width": width,
                "height": height,
                "batch_size": 1
            },
            "class_type": "EmptyLatentImage",
            "_meta": { "title": "Empty Latent Image" }
        },
        "6": {
            "inputs": {
                "text": prompt,
                "clip": ["4", 1]
            },
            "class_type": "CLIPTextEncode",
            "_meta": { "title": "CLIP Text Encode (Prompt)" }
        },
        "7": {
            "inputs": {
                "text": "text, watermark",
                "clip": ["4", 1]
            },
            "class_type": "CLIPTextEncode",
            "_meta": { "title": "CLIP Text Encode (Negative)" }
        },
        "8": {
            "inputs": {
                "samples": ["3", 0],
                "vae": ["4", 2]
            },
            "class_type": "VAEDecode",
            "_meta": { "title": "VAE Decode" }
        },
        "9": {
            "inputs": {
                "filename_prefix": "ComfyUI",
                "images": ["8", 0]
            },
            "class_type": "SaveImage",
            "_meta": { "title": "Save Image" }
        }
    };
}

// Upload image to ComfyUI and get filename
async function uploadImageToComfyUI(imageBase64, req = null) {
    try {
        // SECURITY: Validate image before processing
        const validation = validateImageUpload(imageBase64);
        if (!validation.valid) {
            const errorMsg = validation.error || 'Image validation failed';
            if (req) {
                logSecurityEvent('IMAGE_UPLOAD_VALIDATION_FAILED', req, { error: errorMsg });
            }
            throw new Error(errorMsg);
        }

        const imageBuffer = validation.buffer;
        const mimeType = validation.mimeType;

        // Ensure ComfyUI is running before attempting to upload
        const isRunning = await ensureComfyUIRunning();
        if (!isRunning) {
            throw new Error('ComfyUI service is not available and could not be started. Please check the server logs.');
        }

        // Use form-data package (needs to be installed on server: npm install form-data)
        let FormData;
        try {
            FormData = require('form-data');
        } catch (e) {
            throw new Error('form-data package is required. Please install it on the server: npm install form-data');
        }
        
        // Generate safe filename based on detected MIME type
        const safeFilename = sanitizeFilename(`input_${Date.now()}`, mimeType);
        
        const formData = new FormData();
        formData.append('image', imageBuffer, {
            filename: safeFilename,
            contentType: mimeType
        });
        
        const uploadResponse = await axios.post(`${COMFYUI_URL}/upload/image`, formData, {
            headers: formData.getHeaders(),
            timeout: 30000
        });
        
        // ComfyUI returns the filename and subfolder
        return {
            filename: uploadResponse.data.name || uploadResponse.data.filename || safeFilename,
            subfolder: uploadResponse.data.subfolder || '',
            type: uploadResponse.data.type || 'input'
        };
    } catch (error) {
        console.error('[SECURITY] Error uploading image to ComfyUI:', error);
        throw new Error(`Failed to upload image: ${error.message}`);
    }
}

// Create a basic ComfyUI workflow for image-to-image
function createImageToImageWorkflow(prompt, imageFilename, imageSubfolder = '', imageType = 'input', width = 512, height = 512, steps = 20, cfg = 8, denoise = 0.75, seed = -1) {
    const finalSeed = seed === -1 ? Math.floor(Math.random() * 1000000000) : seed;
    
    return {
        "3": {
            "inputs": {
                "seed": finalSeed,
                "steps": steps,
                "cfg": cfg,
                "sampler_name": "euler",
                "scheduler": "normal",
                "denoise": denoise,
                "model": ["4", 0],
                "positive": ["6", 0],
                "negative": ["7", 0],
                "latent_image": ["8", 0]
            },
            "class_type": "KSampler",
            "_meta": { "title": "KSampler" }
        },
        "4": {
            "inputs": { "ckpt_name": COMFYUI_MODEL },
            "class_type": "CheckpointLoaderSimple",
            "_meta": { "title": "Load Checkpoint" }
        },
        "5": {
            "inputs": { 
                "image": imageFilename,
                "upload": imageSubfolder ? `${imageSubfolder}/${imageFilename}` : imageFilename
            },
            "class_type": "LoadImage",
            "_meta": { "title": "Load Image" }
        },
        "6": {
            "inputs": {
                "text": prompt,
                "clip": ["4", 1]
            },
            "class_type": "CLIPTextEncode",
            "_meta": { "title": "CLIP Text Encode (Prompt)" }
        },
        "7": {
            "inputs": {
                "text": "text, watermark",
                "clip": ["4", 1]
            },
            "class_type": "CLIPTextEncode",
            "_meta": { "title": "CLIP Text Encode (Negative)" }
        },
        "8": {
            "inputs": {
                "pixels": ["5", 0],
                "vae": ["4", 2]
            },
            "class_type": "VAEEncode",
            "_meta": { "title": "VAE Encode" }
        },
        "9": {
            "inputs": {
                "samples": ["3", 0],
                "vae": ["4", 2]
            },
            "class_type": "VAEDecode",
            "_meta": { "title": "VAE Decode" }
        },
        "11": {
            "inputs": {
                "filename_prefix": "ComfyUI",
                "images": ["9", 0]
            },
            "class_type": "SaveImage",
            "_meta": { "title": "Save Image" }
        }
    };
}

// Submit workflow to ComfyUI and get image with progress updates using WebSocket
async function generateImageWithComfyUI(workflow, isImageToImage = false, progressCallback = null) {
    return new Promise(async (resolve, reject) => {
        // Ensure ComfyUI is running before attempting to use it
        const isRunning = await ensureComfyUIRunning();
        if (!isRunning) {
            reject(new Error('ComfyUI service is not available and could not be started. Please check the server logs.'));
            return;
        }

        let ws = null;
        let promptId = null;
        let lastProgress = 0;
        const maxWaitTime = 1800000; // 30 minutes max (image generation can take a while)
        let timeoutId = null;
        let pollInterval = null;
        let executionCompleted = false;
        let wsClosedUnexpectedly = false;
        let nodeProgress = {}; // Track progress by node ID
        let lastWebSocketProgress = 0; // Track last progress from WebSocket
        let lastWebSocketProgressTime = Date.now(); // Track when we last got WebSocket progress

        // Helper to check if job is complete and trigger fallback if needed
        const checkCompletionAndFallback = async () => {
            if (executionCompleted) return;
            try {
                const historyResponse = await axios.get(`${COMFYUI_URL}/history`, { timeout: 5000 });
                const history = historyResponse.data;
                if (history && history[promptId] && history[promptId].outputs) {
                    executionCompleted = true;
                    if (progressCallback) progressCallback(100);
                    const result = await getImageFromHistory(promptId);
                    resolve(result);
                    return true;
                }
            } catch (err) {
                console.error('[ComfyUI] Error checking completion:', err.message);
            }
            return false;
        };

        try {
            // Submit the prompt - ComfyUI API requires explicit output node
            // The workflow must have at least one output node (usually SaveImage node 9)
            const promptResponse = await axios.post(`${COMFYUI_URL}/prompt`, {
                prompt: workflow,
                client_id: `infinet_${Date.now()}`
            }, {
                timeout: 300000 // 5 minutes timeout
            });

            promptId = promptResponse.data.prompt_id;
            if (!promptId) {
                // Check for validation errors
                if (promptResponse.data.node_errors && Object.keys(promptResponse.data.node_errors).length > 0) {
                    const errors = JSON.stringify(promptResponse.data.node_errors);
                    console.error('[ComfyUI] Validation errors:', errors);
                    throw new Error(`ComfyUI validation failed: ${errors}`);
                }
                throw new Error('Failed to get prompt ID from ComfyUI. Response: ' + JSON.stringify(promptResponse.data));
            }

            // Check for node errors even if we got a prompt_id
            if (promptResponse.data.node_errors && Object.keys(promptResponse.data.node_errors).length > 0) {
                console.warn('[ComfyUI] Node errors detected:', JSON.stringify(promptResponse.data.node_errors));
            }

            console.log('[ComfyUI] Prompt submitted, ID:', promptId);

            // Connect to ComfyUI WebSocket for real-time progress
            const wsUrl = COMFYUI_URL.replace('http://', 'ws://').replace('https://', 'wss://') + '/ws?clientId=' + Date.now();
            ws = new WebSocket(wsUrl);

            ws.on('open', () => {
                console.log('[ComfyUI] WebSocket connected for prompt:', promptId);
                wsClosedUnexpectedly = false;

                // Start a lightweight polling interval as a fallback for progress updates (helps on CPU runs)
                pollInterval = setInterval(async () => {
                    if (executionCompleted) return;
                    try {
                        const queueResponse = await axios.get(`${COMFYUI_URL}/queue`, { timeout: 5000 });
                        const queue = queueResponse.data;
                        const queueRunning = queue.queue_running?.find(item => item && item[1] === promptId);
                        const queuePending = queue.queue_pending?.find(item => item && item[1] === promptId);

                        if (queuePending && progressCallback && lastProgress < 5) {
                            lastProgress = 5;
                            progressCallback(lastProgress);
                        } else if (queueRunning && progressCallback) {
                            // Only use polling fallback if WebSocket hasn't provided updates in last 5 seconds
                            // This ensures WebSocket progress takes priority
                            const timeSinceLastWebSocketProgress = Date.now() - lastWebSocketProgressTime;
                            const usePollingFallback = timeSinceLastWebSocketProgress > 5000; // 5 seconds
                            
                            if (usePollingFallback) {
                                // Gradually increase progress up to 95% (leave 5% for final completion)
                                // This is a fallback - WebSocket progress should take priority
                                const bumped = Math.min(lastProgress + 1, 95);
                                if (bumped > lastProgress) {
                                    lastProgress = bumped;
                                    progressCallback(lastProgress);
                                }
                            } else {
                                // WebSocket is active, use its progress value
                                if (lastWebSocketProgress > lastProgress) {
                                    lastProgress = lastWebSocketProgress;
                                    progressCallback(lastProgress);
                                }
                            }
                        }

                        // Also check history for completion
                        const historyResponse = await axios.get(`${COMFYUI_URL}/history`, { timeout: 5000 });
                        const history = historyResponse.data;
                        if (history && history[promptId] && history[promptId].outputs && !executionCompleted) {
                            executionCompleted = true;
                            if (progressCallback) progressCallback(100);

                            if (ws) {
                                ws.close();
                                ws = null;
                            }
                            if (pollInterval) clearInterval(pollInterval);
                            if (timeoutId) clearTimeout(timeoutId);

                            const result = await getImageFromHistory(promptId);
                            resolve(result);
                        }
                    } catch (pollErr) {
                        // Ignore transient polling errors
                    }
                }, 3000);
            });

            ws.on('message', (data) => {
                try {
                    const message = JSON.parse(data.toString());
                    
                    // Log all message types for debugging (can be removed in production)
                    if (message.type && message.type !== 'status') {
                        console.log(`[ComfyUI] WebSocket message type: ${message.type}`);
                    }
                    
                    // Handle progress updates - ComfyUI sends progress as value 0-1
                    if (message.type === 'progress' && message.data) {
                        const progressData = message.data;
                        if (progressData.value !== undefined) {
                            const progress = Math.floor(progressData.value * 100);
                            // Update if progress increased OR if it's 100% (final completion)
                            if ((progress > lastProgress || progress === 100) && progressCallback) {
                                lastProgress = progress;
                                lastWebSocketProgress = progress;
                                lastWebSocketProgressTime = Date.now();
                                progressCallback(progress);
                                console.log(`[ComfyUI] Real progress: ${progress}%`);
                            }
                        }
                    }
                    
                    // Handle execution start
                    if (message.type === 'execution_start' && message.data && message.data.prompt_id === promptId) {
                        console.log('[ComfyUI] Execution started for prompt:', promptId);
                        if (progressCallback && lastProgress < 5) {
                            lastProgress = 5;
                            progressCallback(5);
                        }
                    }
                    
                    // Handle execution cached (nodes already processed)
                    if (message.type === 'execution_cached' && message.data && message.data.prompt_id === promptId) {
                        console.log('[ComfyUI] Some nodes cached, prompt:', promptId);
                        const cachedNodes = message.data.nodes || [];
                        if (cachedNodes.length > 0 && progressCallback && lastProgress < 10) {
                            lastProgress = 10;
                            progressCallback(10);
                        }
                    }
                    
                    // Handle node execution (both specific nodes and completion)
                    if (message.type === 'executing' && message.data) {
                        const nodeId = message.data.node;
                        
                        // Node completion (node === null means done)
                        if (nodeId === null) {
                            console.log('[ComfyUI] Execution completed for prompt:', promptId);
                            executionCompleted = true;
                        if (progressCallback) progressCallback(100);
                            
                        // Close WebSocket and cleanup
                        if (ws) {
                            ws.close();
                            ws = null;
                        }
                        if (pollInterval) clearInterval(pollInterval);
                        if (timeoutId) clearTimeout(timeoutId);
                            
                            // Get image from history - wait longer for ComfyUI to save it
                        setTimeout(async () => {
                            try {
                                const result = await getImageFromHistory(promptId);
                                resolve(result);
                            } catch (err) {
                                    console.error('[ComfyUI] Error retrieving image, retrying...', err.message);
                                    // If not found, retry with exponential backoff
                                let retries = 0;
                                    const maxRetries = 8;
                                const retryInterval = setInterval(async () => {
                                    retries++;
                                    try {
                                        const result = await getImageFromHistory(promptId);
                                        clearInterval(retryInterval);
                                        resolve(result);
                                    } catch (retryErr) {
                                            console.error(`[ComfyUI] Retry ${retries}/${maxRetries} failed:`, retryErr.message);
                                        if (retries >= maxRetries) {
                                            clearInterval(retryInterval);
                                                reject(new Error(`Failed to retrieve image after ${maxRetries} retries: ${retryErr.message}`));
                                            }
                                        }
                                    }, Math.min(1000 * Math.pow(2, retries), 5000)); // Exponential backoff, max 5s
                                }
                            }, 2000); // Wait 2 seconds for ComfyUI to save the image
                        } else {
                            // Specific node is executing
                            nodeProgress[nodeId] = true;
                            console.log(`[ComfyUI] Node ${nodeId} executing`);
                            
                            // Node 4 is CheckpointLoaderSimple - this can take a while
                            if (nodeId === '4' || nodeId === 4) {
                                if (progressCallback && lastProgress < 15) {
                                    lastProgress = 15;
                                    progressCallback(15);
                                    console.log('[ComfyUI] Checkpoint loader (node 4) started - loading model...');
                                }
                            }
                            // Node 5 is EmptyLatentImage
                            else if (nodeId === '5' || nodeId === 5) {
                                if (progressCallback && lastProgress < 20) {
                                    lastProgress = 20;
                                    progressCallback(20);
                                }
                            }
                            // Node 6/7 are CLIPTextEncode (positive/negative prompts)
                            else if (nodeId === '6' || nodeId === 6 || nodeId === '7' || nodeId === 7) {
                                if (progressCallback && lastProgress < 25) {
                                    lastProgress = 25;
                                    progressCallback(25);
                                }
                            }
                            // Node 3 is KSampler (actual generation)
                            else if (nodeId === '3' || nodeId === 3) {
                                if (progressCallback && lastProgress < 30) {
                                    lastProgress = 30;
                                    progressCallback(30);
                                    console.log('[ComfyUI] KSampler (node 3) started - generating image...');
                                }
                            }
                            // Node 8 is VAEDecode
                            else if (nodeId === '8' || nodeId === 8) {
                                if (progressCallback && lastProgress < 85) {
                                    lastProgress = 85;
                                    progressCallback(85);
                                }
                            }
                            // Node 9 is SaveImage
                            else if (nodeId === '9' || nodeId === 9) {
                                if (progressCallback && lastProgress < 95) {
                                    lastProgress = 95;
                                    progressCallback(95);
                                }
                            }
                        }
                    }
                } catch (error) {
                    console.error('[ComfyUI] WebSocket message parse error:', error.message, error.stack);
                }
            });

            ws.on('error', (error) => {
                console.error('[ComfyUI] WebSocket error:', error.message);
                wsClosedUnexpectedly = true;
                // Fallback to polling if WebSocket fails
                if (ws) {
                    ws.close();
                    ws = null;
                }
                console.log('[ComfyUI] Falling back to polling due to WebSocket error');
                pollForCompletion(promptId, progressCallback).then(resolve).catch(reject);
            });

            ws.on('close', (code, reason) => {
                console.log(`[ComfyUI] WebSocket closed (code: ${code}, reason: ${reason?.toString() || 'none'})`);
                
                // If WebSocket closed unexpectedly and execution not completed, fallback to polling
                if (!executionCompleted && wsClosedUnexpectedly) {
                    console.log('[ComfyUI] WebSocket closed unexpectedly, checking completion and falling back to polling');
                    // Check if job is already complete
                    checkCompletionAndFallback().then((completed) => {
                        if (!completed) {
                            console.log('[ComfyUI] Job not complete, starting polling fallback');
                            pollForCompletion(promptId, progressCallback).then(resolve).catch(reject);
                        }
                    }).catch(() => {
                        console.log('[ComfyUI] Error checking completion, starting polling fallback');
                        pollForCompletion(promptId, progressCallback).then(resolve).catch(reject);
                    });
                } else if (!executionCompleted) {
                    // WebSocket closed but we're not sure why - check completion first
                    console.log('[ComfyUI] WebSocket closed, checking if job completed');
                    checkCompletionAndFallback().then((completed) => {
                        if (!completed) {
                            console.log('[ComfyUI] Job not complete, starting polling fallback');
                            pollForCompletion(promptId, progressCallback).then(resolve).catch(reject);
                        }
                    }).catch(() => {
                        console.log('[ComfyUI] Error checking completion, starting polling fallback');
                        pollForCompletion(promptId, progressCallback).then(resolve).catch(reject);
                    });
                }
            });

            // Hard timeout: abort after maxWaitTime
            timeoutId = setTimeout(() => {
                if (executionCompleted) return;
                console.error('[ComfyUI] Timeout reached, aborting prompt:', promptId);
                executionCompleted = true;
                if (pollInterval) clearInterval(pollInterval);
                if (ws) {
                    try { ws.close(); } catch (err) {}
                    ws = null;
                }
                reject(new Error('Image generation timed out. Please try again.'));
            }, maxWaitTime);

        } catch (error) {
            console.error('[ComfyUI] Error in generateImageWithComfyUI:', error.message);
            if (ws) ws.close();
            if (pollInterval) clearInterval(pollInterval);
            if (timeoutId) clearTimeout(timeoutId);
            reject(error);
        }
    });
}

// Helper function to get image from history
async function getImageFromHistory(promptId) {
    try {
    // ComfyUI history endpoint returns all history, we filter by promptId
        const historyResponse = await axios.get(`${COMFYUI_URL}/history`, { timeout: 10000 });
    const history = historyResponse.data;
        
        if (!history) {
            throw new Error('History response is empty');
        }
    
    // Find the specific prompt in history
    const promptData = history && history[promptId] ? history[promptId] : null;
    
        if (!promptData) {
            throw new Error(`Prompt ${promptId} not found in history`);
        }
        
        if (!promptData.outputs || Object.keys(promptData.outputs).length === 0) {
            throw new Error(`Prompt ${promptId} has no outputs`);
        }
        
        const outputs = promptData.outputs;
        for (const nodeId in outputs) {
            if (outputs[nodeId].images && outputs[nodeId].images.length > 0) {
                const imageInfo = outputs[nodeId].images[0];
                const subfolder = imageInfo.subfolder ? `${imageInfo.subfolder}/` : '';
                
                // Build image URL - handle subfolder properly
                let imageUrl;
                if (subfolder) {
                    imageUrl = `${COMFYUI_URL}/view?filename=${encodeURIComponent(imageInfo.filename)}&subfolder=${encodeURIComponent(imageInfo.subfolder)}&type=${imageInfo.type || 'output'}`;
                } else {
                    imageUrl = `${COMFYUI_URL}/view?filename=${encodeURIComponent(imageInfo.filename)}&type=${imageInfo.type || 'output'}`;
                }
                
                console.log(`[ComfyUI] Retrieving image from: ${imageUrl}`);
                
                // Download the image and convert to base64
                const imageResponse = await axios.get(imageUrl, {
                    responseType: 'arraybuffer',
                    timeout: 60000 // Increased timeout for large images
                });
                
                if (!imageResponse.data || imageResponse.data.length === 0) {
                    throw new Error('Image data is empty');
                }
                
                const imageBuffer = Buffer.from(imageResponse.data);
                const imageBase64 = `data:image/png;base64,${imageBuffer.toString('base64')}`;
                
                console.log(`[ComfyUI] Successfully retrieved image (${imageBuffer.length} bytes) from node ${nodeId}`);
                
                return {
                    success: true,
                    image: imageBase64,
                    imageUrl: imageUrl
                };
            }
        }
        
        throw new Error(`No images found in outputs for prompt ${promptId}`);
    } catch (error) {
        console.error(`[ComfyUI] Error in getImageFromHistory for prompt ${promptId}:`, error.message);
        throw error;
    }
}

// Fallback polling function
async function pollForCompletion(promptId, progressCallback) {
    let attempts = 0;
    const maxAttempts = 300; // 10 minutes max (300 * 2 seconds)
    let lastProgress = 0;
    let wasPending = false;
    let wasRunning = false;

    console.log(`[ComfyUI] Starting polling fallback for prompt: ${promptId}`);

    while (attempts < maxAttempts) {
        await new Promise(resolve => setTimeout(resolve, 2000));
        attempts++;

        try {
            // Check queue status
            const queueResponse = await axios.get(`${COMFYUI_URL}/queue`, { timeout: 10000 });
            const queue = queueResponse.data;
            const queueRunning = queue.queue_running?.find(item => item && item[1] === promptId);
            const queuePending = queue.queue_pending?.find(item => item && item[1] === promptId);
            
            // Update progress based on queue status
            if (queueRunning && !wasRunning) {
                wasRunning = true;
                console.log(`[ComfyUI] Job ${promptId} is running (polling)`);
                if (lastProgress < 30 && progressCallback) {
                    lastProgress = 30;
                    progressCallback(30);
                }
            } else if (queuePending && !wasPending) {
                wasPending = true;
                console.log(`[ComfyUI] Job ${promptId} is pending (polling)`);
                if (lastProgress < 10 && progressCallback) {
                    lastProgress = 10;
                    progressCallback(10);
                }
            } else if (queueRunning && lastProgress < 60 && progressCallback) {
                // Gradually increase progress while running
                lastProgress = Math.min(lastProgress + 2, 60);
                progressCallback(lastProgress);
            }

            // Check history for completion
            const historyResponse = await axios.get(`${COMFYUI_URL}/history`, { timeout: 10000 });
            const history = historyResponse.data;
            
            if (history && history[promptId] && history[promptId].outputs) {
                console.log(`[ComfyUI] Job ${promptId} completed (found in history)`);
                if (progressCallback) progressCallback(100);
                return await getImageFromHistory(promptId);
            }
            
            // Log progress every 30 attempts (1 minute)
            if (attempts % 30 === 0) {
                console.log(`[ComfyUI] Polling attempt ${attempts}/${maxAttempts} for prompt ${promptId}`);
            }
        } catch (error) {
            // Continue polling on 404 or network errors
            if (error.response && error.response.status === 404) {
                continue;
            }
            // Log other errors but continue
            if (attempts % 30 === 0) {
                console.error(`[ComfyUI] Polling error (attempt ${attempts}):`, error.message);
            }
        }
    }
    
    console.error(`[ComfyUI] Polling timeout after ${maxAttempts} attempts for prompt ${promptId}`);
    throw new Error(`Image generation timed out after ${maxAttempts * 2} seconds`);
}

// ============================================
// OLLAMA API ENDPOINT
// ============================================
app.post('/api/ollama/chat', async (req, res) => {
    try {
        // Get API key from header or body
        const apiKey = req.headers['x-api-key'] || 
                      req.headers['authorization']?.replace('Bearer ', '') || 
                      req.body.apiKey;
        
        if (!apiKey) {
            return res.status(401).json({ error: 'API key is required. Provide it in X-API-Key header, Authorization: Bearer <key>, or in request body as apiKey' });
        }

        // Validate API key
        const validation = validateApiKey(apiKey);
        if (!validation.valid) {
            return res.status(401).json({ error: '⚠️ Oops! Our AI is out for a nap 😴. Please check back soon!' });
        }

        // Check if user is authenticated (required for token tracking)
        const userId = req.session?.userId || null;
        
        // Refresh session to keep it alive during long operations (like image generation)
        if (req.session && userId) {
            req.session.touch(); // Reset session expiration
            req.session.save((err) => {
                if (err) console.error('Session save error during request:', err);
            });
        }
        
        // Get request parameters
        const { type, message, prompt, messages, stream = false, image, ...otherParams } = req.body;
        
        // Determine the task type
        let taskType = type || 'conversation'; // Default to conversation
        
        // Check if this should be routed to ComfyUI (image generation)
        const hasImageUpload = image && (typeof image === 'string' || image.data);
        
        // Extract message text from various possible formats
        let messageText = prompt || message;
        let lastUserMessageObj = null;
        if (!messageText && messages && Array.isArray(messages) && messages.length > 0) {
            // Get the last user message (filter for user role first)
            const userMessages = messages.filter(m => m.role === 'user');
            if (userMessages.length > 0) {
                lastUserMessageObj = userMessages[userMessages.length - 1];
                messageText = lastUserMessageObj?.content || lastUserMessageObj?.text || lastUserMessageObj?.message || '';
            } else {
                // Fallback to last message if no user role found
                const lastMessage = messages[messages.length - 1];
                lastUserMessageObj = lastMessage;
                messageText = lastMessage?.content || lastMessage?.text || lastMessage?.message || '';
            }
        }
        
        const shouldUseComfyUI = hasImageUpload || isImageRequest(messageText, lastUserMessageObj);
        
        // Debug logging
        console.log('[ComfyUI Detection]', {
            messageText: messageText?.substring(0, 100),
            hasImageUpload,
            shouldUseComfyUI,
            taskType: type,
            messagesLength: messages?.length || 0,
            lastMessageHasImageData: lastUserMessageObj?.imageData ? 'YES' : 'NO',
            lastMessageContent: lastUserMessageObj?.content?.substring(0, 50)
        });
        
        // Check for image-to-image data in message
        let imageToImageData = null;
        if (lastUserMessageObj && lastUserMessageObj.imageData) {
            imageToImageData = lastUserMessageObj.imageData;
            console.log('[ComfyUI] Image-to-Image data found in message object');
        }
        
        // Override task type if ComfyUI should be used
        if (shouldUseComfyUI) {
            taskType = (hasImageUpload || imageToImageData) ? 'image-to-image' : 'text-to-image';
            console.log('[ComfyUI] Routing to ComfyUI, taskType:', taskType);
        }
        
        // Build prompt based on type and input
        // For image generation, extract the actual user prompt from messages
        let finalPrompt = prompt || message;
        let inputText = '';
        
        // For image generation, ALWAYS use the latest user message as the prompt
        if (shouldUseComfyUI) {
            // Get the most recent user message from the messages array
            if (messages && Array.isArray(messages)) {
                const userMessages = messages.filter(m => m.role === 'user');
                if (userMessages.length > 0) {
                    const lastUserMessage = userMessages[userMessages.length - 1];
                    finalPrompt = lastUserMessage?.content || lastUserMessage?.text || lastUserMessage?.message || '';
                    console.log('[ComfyUI] Using prompt from last user message:', finalPrompt?.substring(0, 100));
                } else {
                    // Fallback to last message if no user role
                    const lastMessage = messages[messages.length - 1];
                    finalPrompt = lastMessage?.content || lastMessage?.text || lastMessage?.message || '';
                }
            }
            
            // If still no prompt, use messageText (already extracted above)
            if (!finalPrompt || finalPrompt.trim() === '') {
                finalPrompt = messageText || 'a beautiful landscape';
                console.log('[ComfyUI] Using messageText as prompt:', finalPrompt?.substring(0, 100));
            }
            
            // Clean up the prompt - remove any markdown or formatting for image generation
            if (finalPrompt) {
                // Remove markdown code blocks, bold, etc. - just get the plain text
                finalPrompt = finalPrompt
                    .replace(/```[\s\S]*?```/g, '') // Remove code blocks
                    .replace(/`[^`]+`/g, '') // Remove inline code
                    .replace(/\*\*([^*]+)\*\*/g, '$1') // Remove bold
                    .replace(/\*([^*]+)\*/g, '$1') // Remove italic
                    .replace(/#{1,6}\s+/g, '') // Remove headers
                    .replace(/^\[Image-to-Image\]\s*/i, '') // Remove [Image-to-Image] prefix
                    .replace(/^generate\s+an?\s+/i, '') // Remove "generate an" prefix
                    .replace(/^create\s+an?\s+/i, '') // Remove "create an" prefix
                    .replace(/^make\s+an?\s+/i, '') // Remove "make an" prefix
                    .replace(/^draw\s+an?\s+/i, '') // Remove "draw an" prefix
                    .trim();
                
                console.log('[ComfyUI] Final cleaned prompt:', finalPrompt?.substring(0, 100));
            }
            
            // For token calculation
            inputText = finalPrompt;
        } else {
            // For non-image requests, use full conversation
            if (!finalPrompt && messages && Array.isArray(messages)) {
                const userMessages = messages.filter(m => m.role === 'user').map(m => m.content || m.text || m.message || '');
                inputText = userMessages.join('\n');
                finalPrompt = messages.map(m => {
                    if (typeof m === 'string') return m;
                    return (m.role || 'user') + ': ' + (m.content || m.text || m.message || '');
                }).join('\n');
            } else {
                inputText = finalPrompt;
            }
        }
        
        if (!finalPrompt && taskType !== 'text-to-image') {
            return res.status(400).json({ error: 'prompt, message, or messages is required' });
        }

        // Simplified: Require authentication (like uncensored.chat)
        if (!userId) {
            return res.status(401).json({ 
                error: '👋 Hey there! Please sign in to start chatting with our AI. It\'s free and only takes a moment!',
                message: 'Please sign in to use AI features.'
            });
        }
        
        // Get user tokens (server-side only)
        const tokenTracking = await new Promise((resolve, reject) => {
            db.get('SELECT plan FROM users WHERE id = ?', [userId], (err, user) => {
                if (err) return reject(err);
                if (!user) return reject(new Error('User not found'));
                
                // Calculate tokens from usage history
                getOrInitializeUserTokens(userId, user.plan || 'free', (tokenErr, tokensRemaining) => {
                    if (tokenErr) return reject(tokenErr);
                    const tokensAllocated = PLAN_TOKENS[user.plan] || PLAN_TOKENS.free;
                    resolve({ tokensRemaining, tokensAllocated, plan: user.plan || 'free' });
                });
            });
        });
        
        // Calculate estimated tokens needed
        let estimatedTokens = 0;
        if (taskType === 'text-to-image') {
            const tokenCalc = calculateImageTokens(inputText);
            estimatedTokens = tokenCalc.totalTokens;
        } else if (taskType === 'image-to-text') {
            const tokenCalc = calculateImageToTextTokens(inputText, '');
            estimatedTokens = tokenCalc.totalTokens;
        } else {
            estimatedTokens = Math.ceil(inputText.length / 4) + 100;
        }
        
        // Check token balance (skip for owner accounts with unlimited tokens)
        if (tokenTracking.tokensRemaining !== Infinity && tokenTracking.tokensRemaining < estimatedTokens) {
            return res.status(402).json({ 
                error: 'Insufficient tokens',
                message: 'You have reached your token limit. Please upgrade to a paid plan to continue.',
                tokensRemaining: tokenTracking.tokensRemaining,
                tokensRequired: estimatedTokens
            });
        }

        // Route to ComfyUI for image generation
        if (shouldUseComfyUI && (taskType === 'text-to-image' || taskType === 'image-to-image')) {
            // For streaming, send progress updates
            if (stream) {
                // Refresh and save session before starting stream to keep it alive
                if (req.session && userId) {
                    req.session.touch();
                    req.session.save((err) => {
                        if (err) console.error('Session save error at stream start:', err);
                    });
                }
                
                res.setHeader('Content-Type', 'text/event-stream');
                res.setHeader('Cache-Control', 'no-cache');
                res.setHeader('Connection', 'keep-alive');
                
                try {
                    let workflow;
                    let imageBase64 = null;

                    if (taskType === 'image-to-image' && (hasImageUpload || imageToImageData)) {
                        // Handle image-to-image
                        imageBase64 = imageToImageData || (typeof image === 'string' ? image : (image.data || image));
                        if (!imageBase64) {
                            res.write(`data: ${JSON.stringify({ error: 'Image data is required for image-to-image generation' })}\n\n`);
                            return res.end();
                        }
                        
                        console.log('[ComfyUI] Image-to-Image: Using image data, size:', imageBase64.length);
                        
                        // Upload image to ComfyUI first (with security validation)
                        const imageInfo = await uploadImageToComfyUI(imageBase64, req);
                        
                        workflow = createImageToImageWorkflow(
                            finalPrompt || 'enhance this image',
                            imageInfo.filename,
                            imageInfo.subfolder,
                            imageInfo.type,
                            512, // width
                            512, // height
                            15,  // steps (reduced for image-to-image to speed up)
                            8,   // cfg
                            0.75 // denoise
                        );
                    } else {
                        // Handle text-to-image
                        workflow = createTextToImageWorkflow(
                            finalPrompt || 'a beautiful landscape',
                            512, // width
                            512, // height
                            20,  // steps
                            8    // cfg
                        );
                    }

                    // Progress callback for streaming - also refresh session to keep it alive
                    const progressCallback = (progress) => {
                        // Refresh session on every progress update to prevent expiration during long operations
                        if (req.session && req.session.userId) {
                            req.session.touch(); // Reset session expiration
                            // Save session periodically (every 10% progress) to avoid too many saves
                            if (progress % 10 === 0 || progress === 100) {
                                req.session.save((err) => {
                                    if (err) console.error('Session save error during progress:', err);
                                });
                            }
                        }
                        res.write(`data: ${JSON.stringify({ 
                            type: 'progress',
                            progress: progress,
                            message: 'Generating image...'
                        })}\n\n`);
                    };

                    // Generate image with ComfyUI
                    const result = await generateImageWithComfyUI(workflow, taskType === 'image-to-image', progressCallback);

                    // Send 100% progress before sending image (ensure UI shows completion)
                    res.write(`data: ${JSON.stringify({ 
                        type: 'progress',
                        progress: 100,
                        message: 'Image ready!'
                    })}\n\n`);

                    // Deduct tokens
                    if (estimatedTokens > 0 && userId) {
                        db.get('SELECT plan FROM users WHERE id = ?', [userId], (userErr, user) => {
                            if (!userErr && user) {
                                deductTokens(userId, estimatedTokens, (deductErr) => {
                                    if (deductErr) {
                                        console.error('Error deducting tokens:', deductErr);
                                    }
                                });
                            }
                        });
                    }

                    // Send final image response
                    res.write(`data: ${JSON.stringify({ 
                        response: result.image,
                        image: result.image,
                        done: true
                    })}\n\n`);
                    res.end();
                } catch (error) {
                    console.error('ComfyUI error:', error);
                    res.write(`data: ${JSON.stringify({ 
                        error: 'Image generation failed',
                        message: error.message || 'Failed to generate image',
                        done: true
                    })}\n\n`);
                    res.end();
                }
                return;
            } else {
                // Non-streaming response
                try {
                    let workflow;
                    let imageBase64 = null;

                    if (taskType === 'image-to-image' && hasImageUpload) {
                        // Handle image-to-image
                        imageBase64 = typeof image === 'string' ? image : (image.data || image);
                        if (!imageBase64) {
                            return res.status(400).json({ error: 'Image data is required for image-to-image generation' });
                        }
                        
                        // Upload image to ComfyUI first (with security validation)
                        const imageInfo = await uploadImageToComfyUI(imageBase64, req);
                        
                        workflow = createImageToImageWorkflow(
                            finalPrompt || 'enhance this image',
                            imageInfo.filename,
                            imageInfo.subfolder,
                            imageInfo.type,
                            512, // width
                            512, // height
                            15,  // steps (reduced for image-to-image to speed up)
                            8,   // cfg
                            0.75 // denoise
                        );
                    } else {
                        // Handle text-to-image
                        workflow = createTextToImageWorkflow(
                            finalPrompt || 'a beautiful landscape',
                            512, // width
                            512, // height
                            20,  // steps
                            8    // cfg
                        );
                    }

                    // Generate image with ComfyUI
                    const result = await generateImageWithComfyUI(workflow, taskType === 'image-to-image');

                    // Deduct tokens
                    if (estimatedTokens > 0 && userId) {
                        db.get('SELECT plan FROM users WHERE id = ?', [userId], (userErr, user) => {
                            if (!userErr && user) {
                                deductTokens(userId, estimatedTokens, (deductErr) => {
                                    if (deductErr) {
                                        console.error('Error deducting tokens:', deductErr);
                                    }
                                });
                            }
                        });
                    }

                    // Return image response
                    return res.json({
                        response: result.image,
                        image: result.image,
                        imageUrl: result.imageUrl,
                        success: true
                    });
                } catch (error) {
                    console.error('ComfyUI error:', error);
                    return res.status(500).json({ 
                        error: 'Image generation failed',
                        message: error.message || 'Failed to generate image'
                    });
                }
            }
        }

        // Prepare Ollama request based on task type
        let ollamaUrl = 'http://127.0.0.1:11434/api/generate';
        let ollamaPayload = {
            model: validation.modelName,
            stream: stream,
            ...otherParams
        };

        // Handle different task types
        if (taskType === 'text-to-image') {
            ollamaPayload.prompt = finalPrompt || 'generate image';
            ollamaPayload.options = {
                ...ollamaPayload.options,
                num_predict: 1
            };
        } else if (taskType === 'image-to-text') {
            if (!image) {
                return res.status(400).json({ error: 'image is required for image-to-text task' });
            }
            ollamaUrl = 'http://127.0.0.1:11434/api/generate';
            ollamaPayload.prompt = finalPrompt || 'Describe this image';
        } else {
            ollamaPayload.prompt = finalPrompt;
        }

        // Forward request to Ollama
        // For streaming, use a much longer timeout or no timeout (0 = no timeout)
        // For non-streaming, keep reasonable timeout
        const response = await axios.post(ollamaUrl, ollamaPayload, {
            timeout: stream ? 0 : 300000, // No timeout for streaming, 5min for non-streaming
            responseType: stream ? 'stream' : 'json'
        });

        if (stream) {
            res.setHeader('Content-Type', 'text/event-stream');
            res.setHeader('Cache-Control', 'no-cache');
            res.setHeader('Connection', 'keep-alive');
            
            let fullResponse = '';
            let streamEnded = false;
            
            let chunkCount = 0;
            response.data.on('data', (chunk) => {
                if (streamEnded) return; // Don't process data after stream ended
                
                const chunkStr = chunk.toString();
                fullResponse += chunkStr;
                chunkCount++;
                
                // Debug: log all chunks for troubleshooting this specific model issue
                const lines = chunkStr.split('\n').filter(l => l.trim());
                console.log(`Ollama chunk #${chunkCount} received (${chunkStr.length} bytes, ${lines.length} lines):`);
                
                // Check if this chunk contains the done flag
                try {
                    for (const line of lines) {
                        if (line.trim()) {
                            try {
                                const jsonData = JSON.parse(line);
                                console.log(`  Line data: done=${jsonData.done}, response length=${jsonData.response?.length || 0}, eval_count=${jsonData.eval_count || 'N/A'}`);
                                
                                if (jsonData.done === true || jsonData.done === 'true') {
                                    console.log('Ollama stream done flag received');
                                    console.log('Final chunk data:', JSON.stringify(jsonData, null, 2));
                                    streamEnded = true;
                                }
                            } catch (e) {
                                console.log(`  Line is not JSON: ${line.substring(0, 100)}`);
                            }
                        }
                    }
                } catch (e) {
                    console.error('Error parsing chunk:', e);
                }
                
                res.write(chunkStr);
            });
            
            response.data.on('end', () => {
                streamEnded = true;
                // Calculate and deduct tokens after streaming completes
                let tokenCalc;
                let tokensUsed = 0;
                let responseText = '';
                
                // Extract response from stream
                responseText = fullResponse.split('\n').filter(line => line.trim()).map(line => {
                    try {
                        const data = JSON.parse(line.replace('data: ', ''));
                        return data.response || '';
                    } catch { return ''; }
                }).join('');
                
                if (taskType === 'text-to-image') {
                    tokenCalc = calculateImageTokens(inputText);
                    tokensUsed = tokenCalc.totalTokens;
                } else if (taskType === 'image-to-text') {
                    tokenCalc = calculateImageToTextTokens(inputText, responseText);
                    tokensUsed = tokenCalc.totalTokens;
                } else {
                    tokenCalc = calculateTextTokens(inputText, responseText);
                    tokensUsed = tokenCalc.totalTokens;
                }
                
                // Deduct tokens from authenticated user account (skip for owner accounts)
                if (tokensUsed > 0 && userId) {
                    db.get('SELECT plan FROM users WHERE id = ?', [userId], (userErr, user) => {
                        if (!userErr && user && user.plan === 'owner') {
                            // Owner account - skip deduction, just log usage
                            db.run(
                                'INSERT INTO token_usage (user_id, operation_type, tokens_used, input_tokens, output_tokens) VALUES (?, ?, ?, ?, ?)',
                                [userId, taskType, tokensUsed, tokenCalc.inputTokens || 0, tokenCalc.outputTokens || 0],
                                (logErr) => {
                                    if (logErr) console.error('Error logging token usage:', logErr);
                                }
                            );
                        } else {
                            // Normal user - deduct tokens
                            deductTokens(userId, tokensUsed, taskType, tokenCalc.inputTokens || 0, tokenCalc.outputTokens || 0, (err) => {
                                if (err) console.error('Error deducting user tokens:', err);
                            });
                            // Log token usage
                            db.run(
                                'INSERT INTO token_usage (user_id, operation_type, tokens_used, input_tokens, output_tokens) VALUES (?, ?, ?, ?, ?)',
                                [userId, taskType, tokensUsed, tokenCalc.inputTokens || 0, tokenCalc.outputTokens || 0],
                                (logErr) => {
                                    if (logErr) console.error('Error logging token usage:', logErr);
                                }
                            );
                        }
                    });
                }
                res.end();
            });
            
            response.data.on('error', (error) => {
                console.error('Ollama stream error:', error);
                res.status(500).json({ error: '🌊 The response stream got interrupted. No worries, just try sending your message again!' });
            });
        } else {
            // Non-streaming response
            const responseData = response.data;
            let responseText = '';
            
            // Extract response text from Ollama response
            if (responseData.response) {
                responseText = responseData.response;
            } else if (typeof responseData === 'string') {
                responseText = responseData;
            }
            
            // Calculate and deduct tokens (authenticated or IP-based)
            let tokenCalc;
            let tokensUsed = 0;
            
            if (taskType === 'text-to-image') {
                tokenCalc = calculateImageTokens(inputText);
                tokensUsed = tokenCalc.totalTokens;
            } else if (taskType === 'image-to-text') {
                tokenCalc = calculateImageToTextTokens(inputText, responseText);
                tokensUsed = tokenCalc.totalTokens;
            } else {
                tokenCalc = calculateTextTokens(inputText, responseText);
                tokensUsed = tokenCalc.totalTokens;
            }
            
            // Check token balance (skip for owner accounts with unlimited tokens)
            if (tokenTracking.tokensRemaining !== Infinity && tokenTracking.tokensRemaining < tokensUsed) {
                return res.status(402).json({ 
                    error: 'Insufficient tokens',
                    message: 'You have reached your token limit. Please upgrade to a paid plan to continue.',
                    tokensRemaining: tokenTracking.tokensRemaining,
                    tokensRequired: tokensUsed
                });
            }
            
            // Deduct tokens from user account (skip for owner accounts)
            db.get('SELECT plan FROM users WHERE id = ?', [userId], (userErr, user) => {
                if (!userErr && user && user.plan === 'owner') {
                    // Owner account - skip deduction, just log usage
                    db.run(
                        'INSERT INTO token_usage (user_id, operation_type, tokens_used, input_tokens, output_tokens) VALUES (?, ?, ?, ?, ?)',
                        [userId, taskType, tokensUsed, tokenCalc.inputTokens || 0, tokenCalc.outputTokens || 0],
                        (logErr) => {
                            if (logErr) console.error('Error logging token usage:', logErr);
                        }
                    );
                } else {
                    // Normal user - deduct tokens
                    deductTokens(userId, tokensUsed, taskType, tokenCalc.inputTokens || 0, tokenCalc.outputTokens || 0, (err) => {
                        if (err) console.error('Error deducting user tokens:', err);
                    });
                }
            });
            
            // Log token usage
            db.run(
                'INSERT INTO token_usage (user_id, operation_type, tokens_used, input_tokens, output_tokens) VALUES (?, ?, ?, ?, ?)',
                [userId, taskType, tokensUsed, tokenCalc.inputTokens || 0, tokenCalc.outputTokens || 0],
                (logErr) => {
                    if (logErr) console.error('Error logging token usage:', logErr);
                }
            );
            
            // Get updated user token balance
            getOrInitializeUserTokens(userId, tokenTracking.plan, (err, updatedTokens) => {
                if (!err) {
                    responseData.tokensUsed = tokensUsed;
                    responseData.tokensRemaining = updatedTokens || 0;
                    responseData.remainingToken = updatedTokens || 0; // Match uncensored.chat
                }
                res.json(responseData);
            });
        }

    } catch (error) {
        console.error('Ollama API error:', error.response?.data || error.message);
        if (error.response) {
            // Safely extract error data without circular references
            const errorData = error.response.data;
            const safeErrorData = errorData && typeof errorData === 'object' 
                ? { error: errorData.error || '🤖 Our AI engine had a hiccup! Please try again in a moment.', message: errorData.message || null }
                : { error: '🤖 Our AI engine had a hiccup! Please try again in a moment.' };
            
            res.status(error.response.status || 500).json(safeErrorData);
        } else if (error.code === 'ECONNREFUSED') {
            res.status(503).json({ error: '😴 Our AI service is taking a quick break! It should be back shortly. Please try again in a moment.' });
        } else {
            res.status(500).json({ error: error.message || '😅 Oops! Something unexpected happened on our end. Please give it another try!' });
        }
    }
});

// ============================================
// ADMIN ENDPOINTS
// ============================================

// List all models (with masked API keys for security)
app.get('/api/admin/models', requireAdmin, (req, res) => {
    try {
        const apiKeys = loadApiKeys();
        const assignments = loadModelAssignments();
        const models = Object.entries(apiKeys).map(([id, data]) => ({
            id,
            displayName: data.displayName,
            modelName: data.modelName,
            active: data.active,
            createdAt: data.createdAt,
            apiKey: maskApiKey(data.apiKey), // Masked for security
            apiKeyMasked: true, // Flag to indicate key is masked
            assignedTo: assignments.model1 === id ? 'model1' : assignments.model2 === id ? 'model2' : null
        }));
        res.json({ models, assignments });
    } catch (error) {
        res.status(500).json({ error: 'Failed to load models' });
    }
});

// Reveal full API key for a specific model (requires admin auth)
app.get('/api/admin/models/:modelId/reveal-key', requireAdmin, (req, res) => {
    try {
        const { modelId } = req.params;
        const apiKeys = loadApiKeys();
        
        if (!apiKeys[modelId]) {
            return res.status(404).json({ error: 'Model not found' });
        }

        // Log the key reveal for security auditing
        logSecurityEvent('API_KEY_REVEALED', req, { modelId });
        
        res.json({ 
            success: true, 
            modelId, 
            apiKey: apiKeys[modelId].apiKey 
        });
    } catch (error) {
        res.status(500).json({ error: 'Failed to reveal API key' });
    }
});

// Add new model with input validation
app.post('/api/admin/models', requireAdmin, (req, res) => {
    try {
        let { modelName, displayName } = req.body;
        
        if (!modelName) {
            return res.status(400).json({ error: 'modelName is required' });
        }

        // Security: Sanitize and validate input
        modelName = sanitizeInput(modelName);
        displayName = displayName ? sanitizeInput(displayName) : modelName;
        
        // Additional validation: Check for malicious patterns
        const maliciousPatterns = [
            /\.\./,           // Path traversal
            /[<>\"']/,        // HTML/script injection
            /[;&|`$(){}[\]]/, // Command injection
            /etc\/passwd/i,   // File access attempts
            /proc\/version/i, // System info attempts
            /windows\/win\.ini/i, // Windows file access
            /sleep|waitfor|delay/i, // Time-based attacks
            /union|select|insert|delete|update|drop/i, // SQL injection
            /script|javascript|onerror|onload/i, // XSS attempts
        ];
        
        for (const pattern of maliciousPatterns) {
            if (pattern.test(modelName) || pattern.test(displayName)) {
                logSecurityEvent('MALICIOUS_INPUT_DETECTED', req, { 
                    modelName, 
                    displayName, 
                    pattern: pattern.toString() 
                });
                return res.status(400).json({ error: 'Invalid model name: contains prohibited characters or patterns' });
            }
        }
        
        // Length validation
        if (modelName.length < 3 || modelName.length > 100) {
            return res.status(400).json({ error: 'Model name must be between 3 and 100 characters' });
        }

        const apiKeys = loadApiKeys();
        const modelId = modelName.toLowerCase().replace(/[^a-z0-9]/g, '-').replace(/-+/g, '-');
        
        if (apiKeys[modelId]) {
            return res.status(400).json({ error: 'Model with this name already exists' });
        }

        const newApiKey = generateApiKey();
        apiKeys[modelId] = {
            apiKey: newApiKey,
            modelName: modelName,
            displayName: displayName || modelName,
            createdAt: new Date().toISOString(),
            active: true
        };

        if (saveApiKeys(apiKeys)) {
            logSecurityEvent('MODEL_CREATED', req, { modelId, modelName, displayName });
            res.json({ 
                success: true, 
                modelId, 
                apiKey: newApiKey,
                model: apiKeys[modelId]
            });
        } else {
            res.status(500).json({ error: 'Failed to save model' });
        }
    } catch (error) {
        logSecurityEvent('MODEL_CREATION_ERROR', req, { error: error.message });
        res.status(500).json({ error: 'Failed to add model' });
    }
});

// Update model (activate/deactivate or update info) with validation
app.put('/api/admin/models/:modelId', requireAdmin, (req, res) => {
    try {
        const { modelId } = req.params;
        let { active, displayName, modelName } = req.body;
        
        // Security: Sanitize input
        if (displayName) {
            displayName = sanitizeInput(displayName);
        }
        if (modelName) {
            modelName = sanitizeInput(modelName);
        }
        
        const apiKeys = loadApiKeys();
        
        if (!apiKeys[modelId]) {
            return res.status(404).json({ error: 'Model not found' });
        }

        if (active !== undefined) {
            const wasActive = apiKeys[modelId].active;
            apiKeys[modelId].active = Boolean(active);
            
            // If deactivating a model that's assigned to a slot, unassign it
            if (wasActive && !active) {
                const assignments = loadModelAssignments();
                if (assignments.model1 === modelId) {
                    assignments.model1 = null;
                    saveModelAssignments(assignments);
                    logSecurityEvent('MODEL_AUTO_UNASSIGNED', req, { modelId, reason: 'deactivated', slot: 'model1' });
                }
                if (assignments.model2 === modelId) {
                    assignments.model2 = null;
                    saveModelAssignments(assignments);
                    logSecurityEvent('MODEL_AUTO_UNASSIGNED', req, { modelId, reason: 'deactivated', slot: 'model2' });
                }
            }
        }
        if (displayName) {
            // Validate displayName
            if (displayName.length < 3 || displayName.length > 100) {
                return res.status(400).json({ error: 'Display name must be between 3 and 100 characters' });
            }
            apiKeys[modelId].displayName = displayName;
        }
        if (modelName) {
            // Validate modelName
            if (modelName.length < 3 || modelName.length > 200) {
                return res.status(400).json({ error: 'Model name must be between 3 and 200 characters' });
            }
            apiKeys[modelId].modelName = modelName;
        }

        if (saveApiKeys(apiKeys)) {
            logSecurityEvent('MODEL_UPDATED', req, { modelId, changes: { active, displayName, modelName } });
            res.json({ success: true, model: apiKeys[modelId] });
        } else {
            res.status(500).json({ error: 'Failed to update model' });
        }
    } catch (error) {
        logSecurityEvent('MODEL_UPDATE_ERROR', req, { error: error.message });
        res.status(500).json({ error: 'Failed to update model' });
    }
});

// Regenerate API key for a model
app.post('/api/admin/models/:modelId/regenerate-key', requireAdmin, (req, res) => {
    try {
        const { modelId } = req.params;
        const apiKeys = loadApiKeys();
        
        if (!apiKeys[modelId]) {
            return res.status(404).json({ error: 'Model not found' });
        }

        const newApiKey = generateApiKey();
        apiKeys[modelId].apiKey = newApiKey;

        if (saveApiKeys(apiKeys)) {
            res.json({ success: true, modelId, apiKey: newApiKey });
        } else {
            res.status(500).json({ error: 'Failed to regenerate API key' });
        }
    } catch (error) {
        res.status(500).json({ error: 'Failed to regenerate API key' });
    }
});

// Delete model (mark as inactive)
app.delete('/api/admin/models/:modelId', requireAdmin, (req, res) => {
    try {
        const { modelId } = req.params;
        const apiKeys = loadApiKeys();
        
        if (!apiKeys[modelId]) {
            return res.status(404).json({ error: 'Model not found' });
        }

        // Check if model is assigned to model1 or model2, and unassign it
        const modelAssignments = loadModelAssignments();
        if (modelAssignments.model1 === modelId) {
            modelAssignments.model1 = null;
            saveModelAssignments(modelAssignments);
        }
        if (modelAssignments.model2 === modelId) {
            modelAssignments.model2 = null;
            saveModelAssignments(modelAssignments);
        }

        // Actually delete the model from the system
        delete apiKeys[modelId];

        if (saveApiKeys(apiKeys)) {
            logSecurityEvent('MODEL_DELETED', req, { modelId });
            res.json({ success: true, message: 'Model deleted permanently' });
        } else {
            res.status(500).json({ error: 'Failed to delete model' });
        }
    } catch (error) {
        logSecurityEvent('MODEL_DELETE_ERROR', req, { error: error.message, modelId: req.params.modelId });
        res.status(500).json({ error: 'Failed to delete model' });
    }
});

// Assign a model to model1 (Coder) or model2 (Thinker) slot
app.post('/api/admin/models/:modelId/assign/:slot', requireAdmin, (req, res) => {
    try {
        const { modelId, slot } = req.params;
        
        if (slot !== 'model1' && slot !== 'model2') {
            return res.status(400).json({ error: 'Invalid slot. Must be model1 or model2' });
        }
        
        const apiKeys = loadApiKeys();
        if (!apiKeys[modelId]) {
            return res.status(404).json({ error: 'Model not found' });
        }
        
        if (!apiKeys[modelId].active) {
            return res.status(400).json({ error: 'Cannot assign inactive model' });
        }
        
        const assignments = loadModelAssignments();
        assignments[slot] = modelId;
        
        if (saveModelAssignments(assignments)) {
            logSecurityEvent('MODEL_ASSIGNED', req, { modelId, slot });
            res.json({ success: true, message: `Model assigned to ${slot === 'model1' ? 'Coder' : 'Thinker'} slot` });
        } else {
            res.status(500).json({ error: 'Failed to assign model' });
        }
    } catch (error) {
        logSecurityEvent('MODEL_ASSIGN_ERROR', req, { error: error.message });
        res.status(500).json({ error: 'Failed to assign model' });
    }
});

// Unassign a model from model1 or model2 slot
app.post('/api/admin/models/:modelId/unassign', requireAdmin, (req, res) => {
    try {
        const { modelId } = req.params;
        const assignments = loadModelAssignments();
        
        let unassigned = false;
        if (assignments.model1 === modelId) {
            assignments.model1 = null;
            unassigned = true;
        }
        if (assignments.model2 === modelId) {
            assignments.model2 = null;
            unassigned = true;
        }
        
        if (!unassigned) {
            return res.status(400).json({ error: 'Model is not assigned to any slot' });
        }
        
        if (saveModelAssignments(assignments)) {
            logSecurityEvent('MODEL_UNASSIGNED', req, { modelId });
            res.json({ success: true, message: 'Model unassigned from slot' });
        } else {
            res.status(500).json({ error: 'Failed to unassign model' });
        }
    } catch (error) {
        logSecurityEvent('MODEL_UNASSIGN_ERROR', req, { error: error.message });
        res.status(500).json({ error: 'Failed to unassign model' });
    }
});

// Get model configuration for index.html
app.get('/api/models/config', (req, res) => {
    try {
        const assignments = loadModelAssignments();
        const apiKeys = loadApiKeys();
        
        // Clean up assignments - remove any that point to inactive or deleted models
        let assignmentsChanged = false;
        if (assignments.model1) {
            const assignedModel = apiKeys[assignments.model1];
            if (!assignedModel || !assignedModel.active) {
                assignments.model1 = null;
                assignmentsChanged = true;
            }
        }
        if (assignments.model2) {
            const assignedModel = apiKeys[assignments.model2];
            if (!assignedModel || !assignedModel.active) {
                assignments.model2 = null;
                assignmentsChanged = true;
            }
        }
        if (assignmentsChanged) {
            saveModelAssignments(assignments);
        }
        
        const config = {
            models: {
                model1: {
                    name: getDisplayName('model1'),
                    apiKey: getApiKey('model1'),
                    endpoint: '/api/ollama/chat',
                    modelName: getModelName('model1'),
                    assignedModelId: assignments.model1 || null
                },
                model2: (() => {
                    const apiKey = getApiKey('model2');
                    const modelName = getModelName('model2');
                    const displayName = getDisplayName('model2');
                    
                    // Only return model2 config if we have valid values (not null from deactivated check)
                    if (apiKey && modelName && displayName) {
                        return {
                            name: displayName,
                            apiKey: apiKey,
                            endpoint: '/api/ollama/chat',
                            modelName: modelName,
                            assignedModelId: assignments.model2 || null
                        };
                    }
                    return null;
                })()
            }
        };
        
        res.json(config);
    } catch (error) {
        res.status(500).json({ error: 'Failed to get model configuration' });
    }
});

// Save ComfyUI workflow to file with proper structure for UI display (ComfyUI UI format with positions)
app.post('/api/admin/save-comfyui-workflow', requireAdmin, async (req, res) => {
    try {
        logSecurityEvent('COMFYUI_WORKFLOW_SAVE', req, {});
        
        // Create workflow in ComfyUI UI format (not API format) with node positions
        // This format includes visual layout so nodes appear correctly in the UI
        const uiWorkflow = {
            "last_node_id": 9,
            "last_link_id": 7,
            "nodes": [
                {
                    "id": 4,
                    "type": "CheckpointLoaderSimple",
                    "pos": [50, 50],
                    "size": { "0": 315, "1": 98 },
                    "flags": {},
                    "order": 1,
                    "mode": 0,
                    "inputs": [],
                    "outputs": [
                        { "name": "MODEL", "type": "MODEL", "links": [1], "slot_index": 0 },
                        { "name": "CLIP", "type": "CLIP", "links": [2, 3], "slot_index": 1 },
                        { "name": "VAE", "type": "VAE", "links": [6], "slot_index": 2 }
                    ],
                    "properties": { "Node name for S&R": "CheckpointLoaderSimple" },
                    "widgets_values": ["realisticVisionV60.safetensors"]
                },
                {
                    "id": 6,
                    "type": "CLIPTextEncode",
                    "pos": [400, 50],
                    "size": { "0": 400, "1": 200 },
                    "flags": {},
                    "order": 3,
                    "mode": 0,
                    "inputs": [
                        { "name": "clip", "type": "CLIP", "link": 2 }
                    ],
                    "outputs": [
                        { "name": "CONDITIONING", "type": "CONDITIONING", "links": [4], "slot_index": 0 }
                    ],
                    "properties": { "Node name for S&R": "CLIPTextEncode" },
                    "widgets_values": ["a beautiful landscape, mountains, sunset"]
                },
                {
                    "id": 7,
                    "type": "CLIPTextEncode",
                    "pos": [400, 280],
                    "size": { "0": 400, "1": 200 },
                    "flags": {},
                    "order": 4,
                    "mode": 0,
                    "inputs": [
                        { "name": "clip", "type": "CLIP", "link": 3 }
                    ],
                    "outputs": [
                        { "name": "CONDITIONING", "type": "CONDITIONING", "links": [5], "slot_index": 0 }
                    ],
                    "properties": { "Node name for S&R": "CLIPTextEncode" },
                    "widgets_values": ["text, watermark"]
                },
                {
                    "id": 5,
                    "type": "EmptyLatentImage",
                    "pos": [50, 200],
                    "size": { "0": 315, "1": 106 },
                    "flags": {},
                    "order": 0,
                    "mode": 0,
                    "inputs": [],
                    "outputs": [
                        { "name": "LATENT", "type": "LATENT", "links": [7], "slot_index": 0 }
                    ],
                    "properties": { "Node name for S&R": "EmptyLatentImage" },
                    "widgets_values": [512, 512, 1]
                },
                {
                    "id": 3,
                    "type": "KSampler",
                    "pos": [850, 150],
                    "size": { "0": 315, "1": 262 },
                    "flags": {},
                    "order": 5,
                    "mode": 0,
                    "inputs": [
                        { "name": "model", "type": "MODEL", "link": 1 },
                        { "name": "positive", "type": "CONDITIONING", "link": 4 },
                        { "name": "negative", "type": "CONDITIONING", "link": 5 },
                        { "name": "latent_image", "type": "LATENT", "link": 7 }
                    ],
                    "outputs": [
                        { "name": "LATENT", "type": "LATENT", "links": [8], "slot_index": 0 }
                    ],
                    "properties": { "Node name for S&R": "KSampler" },
                    "widgets_values": [123456, "randomize", 20, 8.0, "euler", "normal", 1.0]
                },
                {
                    "id": 8,
                    "type": "VAEDecode",
                    "pos": [1200, 150],
                    "size": { "0": 210, "1": 46 },
                    "flags": {},
                    "order": 6,
                    "mode": 0,
                    "inputs": [
                        { "name": "samples", "type": "LATENT", "link": 8 },
                        { "name": "vae", "type": "VAE", "link": 6 }
                    ],
                    "outputs": [
                        { "name": "IMAGE", "type": "IMAGE", "links": [9], "slot_index": 0 }
                    ],
                    "properties": { "Node name for S&R": "VAEDecode" },
                    "widgets_values": []
                },
                {
                    "id": 9,
                    "type": "SaveImage",
                    "pos": [1450, 150],
                    "size": { "0": 210, "1": 270 },
                    "flags": {},
                    "order": 7,
                    "mode": 0,
                    "inputs": [
                        { "name": "images", "type": "IMAGE", "link": 9 }
                    ],
                    "outputs": [],
                    "properties": {},
                    "widgets_values": ["ComfyUI"]
                }
            ],
            "links": [
                [1, 4, 0, 3, 0, "MODEL"],
                [2, 4, 1, 6, 0, "CLIP"],
                [3, 4, 1, 7, 0, "CLIP"],
                [4, 6, 0, 3, 1, "CONDITIONING"],
                [5, 7, 0, 3, 2, "CONDITIONING"],
                [6, 4, 2, 8, 1, "VAE"],
                [7, 5, 0, 3, 3, "LATENT"],
                [8, 3, 0, 8, 0, "LATENT"],
                [9, 8, 0, 9, 0, "IMAGE"]
            ],
            "groups": [],
            "config": {},
            "extra": {},
            "version": 0.4
        };
        
        // Save to ComfyUI root directory
        const workflowPath = '/opt/ComfyUI/infinet_text_to_image_workflow.json';
        const workflowJson = JSON.stringify(uiWorkflow, null, 2);
        fs.writeFileSync(workflowPath, workflowJson, 'utf8');
        
        console.log('[ComfyUI] UI workflow saved to:', workflowPath);
        console.log('[ComfyUI] Prompt node (6) is visible at position [400, 50]');
        logSecurityEvent('COMFYUI_WORKFLOW_SAVED', req, { path: workflowPath });
        
        res.json({
            success: true,
            message: 'ComfyUI workflow saved in UI format. Prompt node (CLIPTextEncode) is now visible and properly connected.',
            path: workflowPath,
            instructions: 'In ComfyUI, press Ctrl+O (Cmd+O on Mac) and load "infinet_text_to_image_workflow.json". The prompt node will be visible at the top center with all connections shown.'
        });
    } catch (error) {
        logSecurityEvent('COMFYUI_WORKFLOW_SAVE_ERROR', req, { error: error.message });
        console.error('Error saving ComfyUI workflow:', error);
        res.status(500).json({ error: 'Failed to save workflow: ' + error.message });
    }
});

// Restart AI server and all AI services (Ollama, Open WebUI, and Node.js server)
app.post('/api/admin/restart-server', requireAdmin, async (req, res) => {
    try {
        logSecurityEvent('SERVER_RESTART_INITIATED', req, {});
        
        // Send response immediately before restarting to avoid connection drop
        res.json({ 
            success: true, 
            message: 'AI services restart initiated. Ollama, Open WebUI, Node.js server, and ComfyUI will restart in a moment.',
            output: 'Restart commands queued'
        });
        
        // Use setTimeout to delay restart slightly, allowing response to be sent
        setTimeout(() => {
            const { exec } = require('child_process');
            const env = {
                ...process.env,
                PATH: process.env.PATH || '/usr/local/sbin:/usr/local/bin:/usr/sbin:/usr/bin:/sbin:/bin',
                HOME: process.env.HOME || '/root'
            };

            // Step 1: Restart Ollama service (this will reload all AI models)
            exec('systemctl restart ollama', { env: env }, (error1, stdout1, stderr1) => {
                if (error1) {
                    console.error('Ollama restart error:', error1);
                    logSecurityEvent('OLLAMA_RESTART_ERROR', req, { error: error1.message });
                } else {
                    console.log('Ollama restarted successfully:', stdout1 || stderr1);
                    logSecurityEvent('OLLAMA_RESTART_SUCCESS', req, {});
                }

                // Step 2: Restart Open WebUI (kill and let systemd/process manager restart it)
                exec('systemctl restart open-webui 2>/dev/null || pkill -f "open_webui.main:app"', { env: env }, (error2, stdout2, stderr2) => {
                    if (error2 && !error2.message.includes('No such file')) {
                        console.error('Open WebUI restart error:', error2);
                        logSecurityEvent('WEBUI_RESTART_ERROR', req, { error: error2.message });
                    } else {
                        console.log('Open WebUI restart initiated:', stdout2 || stderr2);
                        logSecurityEvent('WEBUI_RESTART_SUCCESS', req, {});
                    }

                    // Step 3: Restart ComfyUI (image generation service) BEFORE restarting PM2
                    exec('pkill -f \"python.*main.py.*8188\" || pkill -f \"ComfyUI\" || true', { env: env }, (killError) => {
                        if (killError && !killError.message.includes('No such process')) {
                            console.error('ComfyUI kill error:', killError);
                        } else {
                            console.log('ComfyUI process killed (if running)');
                        }

                        setTimeout(async () => {
                            try {
                                await startComfyUI();
                                logSecurityEvent('COMFYUI_RESTART_SUCCESS', req, {});
                                console.log('ComfyUI restarted successfully and verified');
                            } catch (error4) {
                                logSecurityEvent('COMFYUI_RESTART_ERROR', req, { error: error4.message });
                                console.error('ComfyUI restart error:', error4);
                            }
                        }, 2000); // Increased delay to ensure process is fully killed
                    });

                    // Step 4: Restart Node.js server (PM2) last, so earlier steps complete
                    const pm2Path = '/usr/bin/pm2';
                    const command = `${pm2Path} restart ai --update-env`;

                    exec(command, { cwd: __dirname, env: env }, (error3, stdout3, stderr3) => {
                        if (error3) {
                            logSecurityEvent('SERVER_RESTART_ERROR', req, { error: error3.message, stderr: stderr3 });
                            console.error('Server restart error:', error3);
                        } else {
                            logSecurityEvent('SERVER_RESTART_SUCCESS', req, { output: stdout3 || stderr3 });
                            console.log('Node.js server restarted:', stdout3 || stderr3);
                        }
                    });
                });
            });
        }, 500); // Small delay to ensure response is sent
        
    } catch (error) {
        logSecurityEvent('SERVER_RESTART_ERROR', req, { error: error.message });
        console.error('Server restart error:', error);
        res.status(500).json({ error: 'Failed to restart server: ' + error.message });
    }
});

// Transcribe audio (simple endpoint - can be enhanced with actual transcription service)
app.post('/api/transcribe', async (req, res) => {
    try {
        // For now, return a placeholder response
        // In production, you would use a transcription service like:
        // - OpenAI Whisper API
        // - Google Speech-to-Text
        // - Azure Speech Services
        // - Or a local transcription model
        
        // Check if audio file was uploaded
        if (!req.files || !req.files.audio) {
            return res.status(400).json({ error: 'No audio file provided' });
        }
        
        // For now, return a message that transcription needs to be implemented
        // The client-side Web Speech API should handle most cases
        res.status(501).json({ 
            error: 'Server-side transcription not yet implemented. Please use a browser that supports Web Speech API.',
            text: '' 
        });
    } catch (error) {
        console.error('Transcription error:', error);
        res.status(500).json({ error: 'Failed to transcribe audio' });
    }
});

// Get API key info (for users to check their key)
app.get('/api/ollama/key-info', (req, res) => {
    try {
        const apiKey = req.headers['x-api-key'] || 
                      req.headers['authorization']?.replace('Bearer ', '') || 
                      req.query.apiKey;
        
        if (!apiKey) {
            return res.status(401).json({ error: 'API key is required' });
        }

        const validation = validateApiKey(apiKey);
        if (!validation.valid) {
            return res.status(401).json({ error: 'Invalid API key' });
        }

        res.json({
            valid: true,
            modelId: validation.modelId,
            modelName: validation.modelName,
            displayName: validation.displayName
        });
    } catch (error) {
        res.status(500).json({ error: 'Internal server error' });
    }
});

// ============================================
// CRYPTOMUS PAYMENT INTEGRATION
// ============================================

// Helper function to generate Cryptomus signature for payment creation
// For payment creation: MD5(base64(JSON.stringify(data)) + apiKey)
// Note: For payment creation, we DON'T escape slashes (different from webhook verification)
function generateCryptomusSignature(data, apiKey) {
    const payload = JSON.stringify(data);
    const base64Payload = Buffer.from(payload).toString('base64');
    const signature = crypto.createHash('md5').update(base64Payload + apiKey).digest('hex');
    return signature;
}

// Helper function to generate signature for webhook verification (with slash escaping)
// For webhooks: PHP escapes slashes, so we need to match that
function generateCryptomusWebhookSignature(data, apiKey) {
    let payload = JSON.stringify(data);
    // Escape forward slashes to match PHP's json_encode behavior for webhooks
    payload = payload.replace(/\//g, '\\/');
    const base64Payload = Buffer.from(payload).toString('base64');
    const signature = crypto.createHash('md5').update(base64Payload + apiKey).digest('hex');
    return signature;
}

// Helper function to verify Cryptomus webhook signature
function verifyCryptomusWebhookSignature(webhookData, apiKey) {
    // Extract sign from body
    const receivedSign = webhookData.sign;
    if (!receivedSign) {
        return false;
    }
    
    // Create a copy without the sign field
    const dataWithoutSign = { ...webhookData };
    delete dataWithoutSign.sign;
    
    // Generate expected signature (for webhooks, use webhook signature function)
    const expectedSign = generateCryptomusWebhookSignature(dataWithoutSign, apiKey);
    
    return receivedSign === expectedSign;
}

// Create payment table if it doesn't exist
db.run(`CREATE TABLE IF NOT EXISTS payments (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    user_id INTEGER NOT NULL,
    plan TEXT NOT NULL,
    amount REAL NOT NULL,
    currency TEXT DEFAULT 'USD',
    payment_id TEXT UNIQUE,
    invoice_id TEXT,
    status TEXT DEFAULT 'pending',
    created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
    updated_at DATETIME DEFAULT CURRENT_TIMESTAMP,
    FOREIGN KEY (user_id) REFERENCES users(id)
)`, (err) => {
    if (err) console.error('Error creating payments table:', err);
});

// Create payment endpoint
app.post('/api/payment/create', requireAuth, async (req, res) => {
    try {
        const userId = req.session.userId;
        const { plan } = req.body;

        if (!plan || !PLAN_PRICING[plan]) {
            return res.status(400).json({ error: 'Invalid plan selected' });
        }

        const planInfo = PLAN_PRICING[plan];
        const orderId = `order_${userId}_${Date.now()}_${crypto.randomBytes(8).toString('hex')}`;
        
        // Get the actual domain (handle both localhost and production)
        const host = req.get('host');
        const protocol = req.protocol || (req.get('x-forwarded-proto') || 'https');
        const baseUrl = process.env.BASE_URL || `${protocol}://${host}`;
        
        const returnUrl = `${baseUrl}/profile?payment=success`;
        const callbackUrl = `${baseUrl}/api/payment/webhook`;

        // Prepare payment data for Cryptomus
        const paymentData = {
            amount: planInfo.price.toString(),
            currency: 'USD',
            order_id: orderId,
            url_return: returnUrl,
            url_callback: callbackUrl,
            is_payment_multiple: false,
            lifetime: 7200, // 2 hours in seconds
            additional_data: JSON.stringify({ userId, plan })
        };

        // Generate signature for payment creation
        const signature = generateCryptomusSignature(paymentData, CRYPTOMUS_CONFIG.apiKey);

        // Create payment via Cryptomus API
        const response = await axios.post(
            `${CRYPTOMUS_CONFIG.apiUrl}/payment`,
            paymentData,
            {
                headers: {
                    'merchant': CRYPTOMUS_CONFIG.merchantId,
                    'sign': signature,
                    'Content-Type': 'application/json'
                },
                timeout: 30000 // 30 second timeout
            }
        );

        if (response.data && response.data.result) {
            const payment = response.data.result;

            // Save payment to database
            db.run(
                `INSERT INTO payments (user_id, plan, amount, currency, payment_id, invoice_id, status) 
                 VALUES (?, ?, ?, ?, ?, ?, ?)`,
                [userId, plan, planInfo.price, 'USD', payment.uuid, payment.invoice_id || orderId, 'pending'],
                function(err) {
                    if (err) {
                        console.error('Error saving payment:', err);
                        return res.status(500).json({ error: 'Failed to save payment record' });
                    }

                    res.json({
                        success: true,
                        paymentUrl: payment.url,
                        invoiceId: payment.invoice_id || orderId,
                        paymentId: payment.uuid,
                        orderId: orderId
                    });
                }
            );
        } else {
            console.error('[PAYMENT] Cryptomus API error:', response.data);
            res.status(500).json({ 
                error: 'Failed to create payment', 
                message: response.data?.message || 'Unknown error from Cryptomus API'
            });
        }
    } catch (error) {
        console.error('[PAYMENT] Payment creation error:', error.message);
        if (error.response?.data) {
            console.error('[PAYMENT] API response:', error.response.data);
        }
        res.status(500).json({ 
            error: 'Failed to create payment', 
            message: error.response?.data?.message || error.message || 'Unknown error'
        });
    }
});

// Payment webhook handler
// According to Cryptomus docs: https://doc.cryptomus.com/merchant-api/payments/webhook
// Webhooks come from IP: 91.227.144.54
app.post('/api/payment/webhook', express.json(), async (req, res) => {
    try {
        const webhookData = req.body;

        // Verify signature according to Cryptomus documentation
        if (!verifyCryptomusWebhookSignature(webhookData, CRYPTOMUS_CONFIG.apiKey)) {
            console.error('[WEBHOOK] Invalid signature');
            return res.status(401).json({ error: 'Invalid signature' });
        }

        // Extract data according to Cryptomus webhook structure
        const paymentId = webhookData.uuid;
        const status = webhookData.status;
        const orderId = webhookData.order_id;

        if (!paymentId) {
            console.error('[WEBHOOK] Missing payment UUID');
            return res.status(400).json({ error: 'Missing payment UUID' });
        }

        // Find payment in database by payment_id (which we stored as uuid from Cryptomus)
        db.get('SELECT * FROM payments WHERE payment_id = ?', [paymentId], async (err, payment) => {
            if (err) {
                console.error('[WEBHOOK] Error finding payment:', err);
                return res.status(500).json({ error: 'Database error' });
            }

            if (!payment) {
                console.error('[WEBHOOK] Payment not found:', paymentId);
                // Try to find by order_id as fallback
                db.get('SELECT * FROM payments WHERE invoice_id = ?', [orderId], (err2, paymentByOrder) => {
                    if (err2 || !paymentByOrder) {
                        return res.status(404).json({ error: 'Payment not found' });
                    }
                    processPaymentUpdate(paymentByOrder, status, paymentId, res);
                });
                return;
            }

            processPaymentUpdate(payment, status, paymentId, res);
        });

        function processPaymentUpdate(payment, status, paymentId, res) {
            // Update payment status
            db.run(
                'UPDATE payments SET status = ?, updated_at = CURRENT_TIMESTAMP WHERE id = ?',
                [status, payment.id],
                (updateErr) => {
                    if (updateErr) {
                        console.error('[WEBHOOK] Error updating payment:', updateErr);
                        return res.status(500).json({ error: 'Failed to update payment' });
                    }

                    console.log(`[WEBHOOK] Payment ${paymentId} updated to status: ${status}`);

                    // If payment is confirmed/paid, upgrade user plan and credit tokens
                    if (status === 'paid' || status === 'paid_over') {
                        // Upgrade user plan
                        db.run(
                            'UPDATE users SET plan = ? WHERE id = ?',
                            [payment.plan, payment.user_id],
                            (userErr) => {
                                if (userErr) {
                                    console.error('[WEBHOOK] Error upgrading user plan:', userErr);
                                } else {
                                    // Get the allocated tokens for the new plan
                                    const allocatedTokens = PLAN_TOKENS[payment.plan] || PLAN_TOKENS.free;
                                    
                                    // Clear token usage history so user gets full allocation
                                    db.run(
                                        'DELETE FROM token_usage WHERE user_id = ?',
                                        [payment.user_id],
                                        (clearErr) => {
                                            if (clearErr) {
                                                console.error('[WEBHOOK] Error clearing token usage history:', clearErr);
                                            }
                                            
                                            // Update user tokens to new plan allocation
                                            db.run(
                                                'UPDATE users SET tokens = ? WHERE id = ?',
                                                [allocatedTokens, payment.user_id],
                                                (tokenErr) => {
                                                    if (tokenErr) {
                                                        console.error('[WEBHOOK] Error resetting user tokens:', tokenErr);
                                                    } else {
                                                        console.log(`[WEBHOOK] ✅ User ${payment.user_id} upgraded to ${payment.plan} plan with ${allocatedTokens.toLocaleString()} tokens credited`);
                                                    }
                                                }
                                            );
                                        }
                                    );
                                }
                            }
                        );
                    }

                    res.json({ success: true, status: status });
                }
            );
        }
    } catch (error) {
        console.error('[WEBHOOK] Webhook processing error:', error);
        res.status(500).json({ error: 'Webhook processing failed' });
    }
});

// Check payment status
app.get('/api/payment/status/:paymentId', requireAuth, (req, res) => {
    const { paymentId } = req.params;
    const userId = req.session.userId;

    db.get(
        'SELECT * FROM payments WHERE payment_id = ? AND user_id = ?',
        [paymentId, userId],
        (err, payment) => {
            if (err) {
                return res.status(500).json({ error: 'Database error' });
            }

            if (!payment) {
                return res.status(404).json({ error: 'Payment not found' });
            }

            res.json({
                status: payment.status,
                plan: payment.plan,
                amount: payment.amount,
                createdAt: payment.created_at
            });
        }
    );
});

