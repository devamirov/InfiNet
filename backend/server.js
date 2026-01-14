const express = require('express');
const cors = require('cors');
const bodyParser = require('body-parser');
const nodemailer = require('nodemailer');
const TelegramBot = require('node-telegram-bot-api');
const sqlite3 = require('sqlite3').verbose();
const path = require('path');
const dns = require('dns').promises;
const whois = require('whois');
const { promisify } = require('util');
const { GoogleGenerativeAI } = require('@google/generative-ai');
const Groq = require('groq-sdk');
const bcrypt = require('bcrypt');
const jwt = require('jsonwebtoken');
require('dotenv').config();

const whoisLookup = promisify(whois.lookup);
const net = require('net');
const fs = require('fs');

// Helper function to query WHOIS server directly via TCP
async function queryWhoisDirectly(domain, whoisServer = null) {
    return new Promise((resolve, reject) => {
        // Get WHOIS server from servers.json if not provided
        if (!whoisServer) {
            try {
                const serversPath = require.resolve('whois/servers.json');
                const servers = JSON.parse(fs.readFileSync(serversPath, 'utf8'));
                const tld = domain.split('.').pop();
                if (servers[tld]) {
                    if (typeof servers[tld] === 'string') {
                        whoisServer = servers[tld];
                    } else if (servers[tld].host) {
                        whoisServer = servers[tld].host;
                    }
                } else {
                    // Default WHOIS server
                    whoisServer = 'whois.iana.org';
                }
            } catch (error) {
                whoisServer = 'whois.iana.org';
            }
        }
        
        const client = net.createConnection(43, whoisServer, () => {
            client.write(domain + '\r\n');
        });
        
        let data = '';
        client.on('data', (chunk) => {
            data += chunk.toString();
        });
        
        client.on('end', () => {
            resolve(data);
        });
        
        client.on('error', (error) => {
            reject(error);
        });
        
        // Timeout after 10 seconds
        setTimeout(() => {
            client.destroy();
            reject(new Error('WHOIS query timeout'));
        }, 10000);
    });
}

const app = express();
const PORT = process.env.PORT || 3000;

// Middleware
// Configure CORS to allow requests from infinet.services and other domains
app.use(cors({
    origin: [
        'https://infinet.services',
        'http://infinet.services',
        'https://infi.live',
        'http://infi.live',
        'http://localhost',
        'http://127.0.0.1',
        /^https?:\/\/.*infinet\.services/,
        /^https?:\/\/.*infi\.live/
    ],
    credentials: true,
    methods: ['GET', 'POST', 'PUT', 'DELETE', 'OPTIONS'],
    allowedHeaders: ['Content-Type', 'Authorization']
}));
// Increase body size limit for file uploads (base64 can be large)
app.use(bodyParser.json({ limit: '50mb' }));
app.use(bodyParser.urlencoded({ extended: true, limit: '50mb' }));

// Security: Serve uploaded files with authentication logging
// Note: Files are served statically, but authentication is enforced at upload time
// Frontend already sends auth headers when downloading files
app.use('/uploads', (req, res, next) => {
    // Log file access for security audit
    const authHeader = req.headers.authorization;
    if (authHeader && authHeader.startsWith('Bearer ')) {
        console.log(`[File Download] Authenticated request for: ${req.path}`);
    } else {
        console.log(`[File Download] Unauthenticated request for: ${req.path} (IP: ${req.ip || 'unknown'})`);
    }
    next();
}, express.static(path.join(__dirname, 'uploads')));

// Initialize database
const db = new sqlite3.Database('./bookings.db');

// Create uploads directories if they don't exist
const uploadsDir = path.join(__dirname, 'uploads');
const filesDir = path.join(uploadsDir, 'files');
const invoicesDir = path.join(uploadsDir, 'invoices');

[uploadsDir, filesDir, invoicesDir].forEach(dir => {
    if (!fs.existsSync(dir)) {
        fs.mkdirSync(dir, { recursive: true });
        console.log(`Created upload directory: ${dir}`);
    }
});

// ==================== SECURITY: File Upload Validation ====================

// Allowed file extensions
const ALLOWED_FILE_EXTENSIONS = ['.jpg', '.jpeg', '.png', '.pdf', '.doc', '.docx', '.html', '.txt'];
const ALLOWED_INVOICE_EXTENSIONS = ['.pdf', '.jpg', '.jpeg', '.png', '.doc', '.docx', '.html'];
const ALLOWED_IMAGE_EXTENSIONS = ['.jpg', '.jpeg', '.png', '.webp'];

// File size limits (in bytes)
const MAX_IMAGE_SIZE = 10 * 1024 * 1024; // 10MB
const MAX_DOCUMENT_SIZE = 50 * 1024 * 1024; // 50MB
const MAX_INVOICE_SIZE = 50 * 1024 * 1024; // 50MB

// MIME type mapping
const MIME_TYPES = {
    '.jpg': 'image/jpeg',
    '.jpeg': 'image/jpeg',
    '.png': 'image/png',
    '.webp': 'image/webp',
    '.pdf': 'application/pdf',
    '.doc': 'application/msword',
    '.docx': 'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
    '.html': 'text/html',
    '.txt': 'text/plain'
};

// File signature (magic bytes) for validation
const FILE_SIGNATURES = {
    'image/jpeg': [0xFF, 0xD8, 0xFF],
    'image/png': [0x89, 0x50, 0x4E, 0x47, 0x0D, 0x0A, 0x1A, 0x0A],
    'image/webp': [0x52, 0x49, 0x46, 0x46], // RIFF header
    'application/pdf': [0x25, 0x50, 0x44, 0x46], // %PDF
    'application/msword': [0xD0, 0xCF, 0x11, 0xE0, 0xA1, 0xB1, 0x1A, 0xE1], // OLE2
    'application/vnd.openxmlformats-officedocument.wordprocessingml.document': [0x50, 0x4B, 0x03, 0x04], // ZIP (DOCX is a ZIP)
    'text/html': [], // HTML can start with < or whitespace
    'text/plain': [] // Text files have no signature
};

// Helper functions
function getFileExtension(fileName) {
    const lastDot = fileName.lastIndexOf('.');
    if (lastDot === -1) return '';
    return fileName.substring(lastDot).toLowerCase();
}

function isImageFile(fileName) {
    const ext = getFileExtension(fileName);
    return ['.jpg', '.jpeg', '.png', '.webp', '.gif', '.bmp'].includes(ext);
}

function validateFileExtension(fileName, allowedExtensions) {
    const ext = getFileExtension(fileName);
    return allowedExtensions.includes(ext);
}

function sanitizeFileName(fileName) {
    // Remove path traversal attempts
    let sanitized = fileName.replace(/\.\./g, '').replace(/[\/\\]/g, '');
    // Remove dangerous characters
    sanitized = sanitized.replace(/[<>:"|?*\x00-\x1f]/g, '');
    // Limit filename length
    if (sanitized.length > 255) {
        const ext = getFileExtension(sanitized);
        sanitized = sanitized.substring(0, 255 - ext.length) + ext;
    }
    return sanitized;
}

function validateFileContent(buffer, expectedMimeType) {
    const signature = FILE_SIGNATURES[expectedMimeType];
    if (!signature || signature.length === 0) {
        // No signature for text files - basic validation only
        return true;
    }
    
    if (buffer.length < signature.length) {
        return false;
    }
    
    // Check magic bytes
    for (let i = 0; i < signature.length; i++) {
        if (buffer[i] !== signature[i]) {
            // Special case for DOCX (ZIP files) - check for PK header
            if (expectedMimeType === 'application/vnd.openxmlformats-officedocument.wordprocessingml.document') {
                // DOCX is a ZIP file, check for ZIP signature
                const zipSignature = [0x50, 0x4B, 0x03, 0x04];
                let matchesZip = true;
                for (let j = 0; j < zipSignature.length; j++) {
                    if (buffer[j] !== zipSignature[j]) {
                        matchesZip = false;
                        break;
                    }
                }
                if (matchesZip) return true;
            }
            return false;
        }
    }
    return true;
}

// Rate limiting: Store upload counts per user
const uploadRateLimit = new Map(); // userId -> { count: number, resetTime: number }
const RATE_LIMIT_WINDOW = 60 * 60 * 1000; // 1 hour in milliseconds
const MAX_UPLOADS_PER_HOUR = 10;

function checkRateLimit(userId) {
    const now = Date.now();
    const userLimit = uploadRateLimit.get(userId);
    
    if (!userLimit || now > userLimit.resetTime) {
        // Reset or initialize
        uploadRateLimit.set(userId, { count: 1, resetTime: now + RATE_LIMIT_WINDOW });
        return true;
    }
    
    if (userLimit.count >= MAX_UPLOADS_PER_HOUR) {
        return false;
    }
    
    userLimit.count++;
    return true;
}

// ==================== END SECURITY VALIDATION ====================

// Create bookings table
db.serialize(() => {
    db.run(`CREATE TABLE IF NOT EXISTS bookings (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        name TEXT NOT NULL,
        email TEXT NOT NULL,
        phone TEXT,
        company TEXT,
        date TEXT NOT NULL,
        time TEXT NOT NULL,
        message TEXT,
        status TEXT DEFAULT 'upcoming',
        created_at DATETIME DEFAULT CURRENT_TIMESTAMP
    )`);
    
    // Create AI conversations table
    db.run(`CREATE TABLE IF NOT EXISTS ai_conversations (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        session_id TEXT NOT NULL,
        user_message TEXT NOT NULL,
        ai_response TEXT NOT NULL,
        created_at DATETIME DEFAULT CURRENT_TIMESTAMP
    )`);
    
    // Create AI leads table
    db.run(`CREATE TABLE IF NOT EXISTS ai_leads (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        session_id TEXT NOT NULL,
        name TEXT,
        email TEXT,
        phone TEXT,
        company TEXT,
        project_type TEXT,
        budget_range TEXT,
        requirements TEXT,
        design_preferences TEXT,
        booking_confirmed INTEGER DEFAULT 0,
        booking_id INTEGER,
        created_at DATETIME DEFAULT CURRENT_TIMESTAMP
    )`);
    
    // Create short URLs table
    db.run(`CREATE TABLE IF NOT EXISTS short_urls (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        slug TEXT NOT NULL UNIQUE,
        original_url TEXT NOT NULL,
        custom_slug INTEGER DEFAULT 0,
        click_count INTEGER DEFAULT 0,
        created_at DATETIME DEFAULT CURRENT_TIMESTAMP
    )`);
    
    // Create index on slug for faster lookups
    db.run(`CREATE INDEX IF NOT EXISTS idx_slug ON short_urls(slug)`);
    
    // Create users table for authentication
    db.run(`CREATE TABLE IF NOT EXISTS users (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        email TEXT NOT NULL UNIQUE,
        password_hash TEXT NOT NULL,
        name TEXT NOT NULL,
        company TEXT,
        role TEXT DEFAULT 'Member',
        emailVerified INTEGER DEFAULT 0,
        verificationToken TEXT,
        verificationExpiry DATETIME,
        passwordResetToken TEXT,
        passwordResetExpiry DATETIME,
        avatar TEXT,
        createdAt DATETIME DEFAULT CURRENT_TIMESTAMP,
        updatedAt DATETIME DEFAULT CURRENT_TIMESTAMP
    )`);
    
    // Add role column if it doesn't exist (migration for existing databases)
    db.run(`ALTER TABLE users ADD COLUMN role TEXT DEFAULT 'Member'`, (err) => {
        // Ignore error if column already exists
        if (err && !err.message.includes('duplicate column')) {
            console.error('Error adding role column:', err);
        }
    });
    
    // Set admin role for the admin user
    db.run(
        `UPDATE users SET role = 'Administrator' WHERE email = ?`,
        [process.env.ADMIN_EMAIL || 'YOUR_ADMIN_EMAIL'],
        (err) => {
            if (err) {
                console.error('Error setting admin role:', err);
            } else {
                console.log(`✅ Admin role set for ${adminEmail}`);
            }
        }
    );
    
    // Create index on email for faster lookups
    db.run(`CREATE INDEX IF NOT EXISTS idx_users_email ON users(email)`);
    
    // Create projects table
    db.run(`CREATE TABLE IF NOT EXISTS projects (
        id TEXT PRIMARY KEY,
        name TEXT NOT NULL,
        status TEXT NOT NULL DEFAULT 'Planning',
        progress INTEGER DEFAULT 0,
        dueDate TEXT,
        description TEXT,
        userId INTEGER,
        createdAt DATETIME DEFAULT CURRENT_TIMESTAMP,
        updatedAt DATETIME DEFAULT CURRENT_TIMESTAMP,
        FOREIGN KEY (userId) REFERENCES users(id)
    )`);
    
    // Create project_files table
    db.run(`CREATE TABLE IF NOT EXISTS project_files (
        id TEXT PRIMARY KEY,
        projectId TEXT NOT NULL,
        name TEXT NOT NULL,
        url TEXT NOT NULL,
        uploadedAt DATETIME DEFAULT CURRENT_TIMESTAMP,
        FOREIGN KEY (projectId) REFERENCES projects(id) ON DELETE CASCADE
    )`);
    
    // Create tickets table
    db.run(`CREATE TABLE IF NOT EXISTS tickets (
        id TEXT PRIMARY KEY,
        projectId TEXT,
        subject TEXT NOT NULL,
        message TEXT NOT NULL,
        status TEXT NOT NULL DEFAULT 'Open',
        userId INTEGER,
        userName TEXT,
        createdAt DATETIME DEFAULT CURRENT_TIMESTAMP,
        updatedAt DATETIME DEFAULT CURRENT_TIMESTAMP,
        FOREIGN KEY (projectId) REFERENCES projects(id) ON DELETE CASCADE,
        FOREIGN KEY (userId) REFERENCES users(id)
    )`);
    
    // Create ticket_replies table
    db.run(`CREATE TABLE IF NOT EXISTS ticket_replies (
        id TEXT PRIMARY KEY,
        ticketId TEXT NOT NULL,
        message TEXT NOT NULL,
        senderId INTEGER NOT NULL,
        senderName TEXT NOT NULL,
        senderRole TEXT NOT NULL DEFAULT 'client',
        timestamp DATETIME DEFAULT CURRENT_TIMESTAMP,
        FOREIGN KEY (ticketId) REFERENCES tickets(id) ON DELETE CASCADE,
        FOREIGN KEY (senderId) REFERENCES users(id)
    )`);
    
    // Create invoices table
    db.run(`CREATE TABLE IF NOT EXISTS invoices (
        id TEXT PRIMARY KEY,
        projectId TEXT NOT NULL,
        title TEXT NOT NULL,
        amount REAL NOT NULL,
        currency TEXT DEFAULT 'USD',
        issuedOn TEXT NOT NULL,
        dueOn TEXT NOT NULL,
        status TEXT NOT NULL DEFAULT 'Draft',
        paymentMethod TEXT,
        receiptUrl TEXT,
        createdAt DATETIME DEFAULT CURRENT_TIMESTAMP,
        updatedAt DATETIME DEFAULT CURRENT_TIMESTAMP,
        FOREIGN KEY (projectId) REFERENCES projects(id) ON DELETE CASCADE
    )`);
    
    // Create activities/notifications table
    db.run(`CREATE TABLE IF NOT EXISTS activities (
        id TEXT PRIMARY KEY,
        type TEXT NOT NULL,
        title TEXT NOT NULL,
        description TEXT,
        userId INTEGER,
        projectId TEXT,
        invoiceId TEXT,
        ticketId TEXT,
        source TEXT,
        userEmail TEXT,
        read INTEGER DEFAULT 0,
        timestamp DATETIME DEFAULT CURRENT_TIMESTAMP,
        FOREIGN KEY (userId) REFERENCES users(id),
        FOREIGN KEY (projectId) REFERENCES projects(id) ON DELETE CASCADE,
        FOREIGN KEY (invoiceId) REFERENCES invoices(id) ON DELETE CASCADE,
        FOREIGN KEY (ticketId) REFERENCES tickets(id) ON DELETE CASCADE
    )`);
    
    // Create push_tokens table
    db.run(`CREATE TABLE IF NOT EXISTS push_tokens (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        userId INTEGER NOT NULL,
        pushToken TEXT NOT NULL UNIQUE,
        createdAt DATETIME DEFAULT CURRENT_TIMESTAMP,
        updatedAt DATETIME DEFAULT CURRENT_TIMESTAMP,
        FOREIGN KEY (userId) REFERENCES users(id) ON DELETE CASCADE
    )`);
    
    // Create index on userId for faster lookups
    db.run(`CREATE INDEX IF NOT EXISTS idx_push_tokens_userId ON push_tokens(userId)`);
    
    // Create project_history table
    db.run(`CREATE TABLE IF NOT EXISTS project_history (
        id TEXT PRIMARY KEY,
        userId INTEGER,
        projectId TEXT,
        action TEXT NOT NULL,
        input_json TEXT,
        output_json TEXT,
        summary TEXT,
        timestamp TEXT NOT NULL,
        hiddenFromHistory INTEGER DEFAULT 0,
        FOREIGN KEY (userId) REFERENCES users(id),
        FOREIGN KEY (projectId) REFERENCES projects(id) ON DELETE CASCADE
    )`);
    
    // Create ai_chat_messages table
    db.run(`CREATE TABLE IF NOT EXISTS ai_chat_messages (
        id TEXT PRIMARY KEY,
        userId INTEGER,
        sender TEXT NOT NULL,
        content TEXT NOT NULL,
        timestamp TEXT NOT NULL,
        FOREIGN KEY (userId) REFERENCES users(id)
    )`);
    
    // Create project_requests table for cross-device sync
    db.run(`CREATE TABLE IF NOT EXISTS project_requests (
        id TEXT PRIMARY KEY,
        serviceType TEXT NOT NULL,
        projectName TEXT NOT NULL,
        projectDescription TEXT NOT NULL,
        projectGoals TEXT,
        targetAudience TEXT,
        budgetRange TEXT,
        timeline TEXT,
        contactName TEXT NOT NULL,
        contactEmail TEXT NOT NULL,
        contactPhone TEXT,
        company TEXT,
        additionalNotes TEXT,
        status TEXT NOT NULL DEFAULT 'pending',
        submittedAt TEXT NOT NULL,
        userId INTEGER,
        userEmail TEXT,
        projectId TEXT,
        confirmedAt TEXT,
        declinedAt TEXT,
        createdAt DATETIME DEFAULT CURRENT_TIMESTAMP,
        updatedAt DATETIME DEFAULT CURRENT_TIMESTAMP,
        FOREIGN KEY (userId) REFERENCES users(id)
    )`);
    
    // Create agent_requests table for cross-device sync
    db.run(`CREATE TABLE IF NOT EXISTS agent_requests (
        id TEXT PRIMARY KEY,
        summary TEXT NOT NULL,
        idealOutcome TEXT,
        contactEmail TEXT NOT NULL,
        userId INTEGER,
        userEmail TEXT,
        status TEXT NOT NULL DEFAULT 'pending',
        submittedAt TEXT NOT NULL,
        projectId TEXT,
        confirmedAt TEXT,
        declinedAt TEXT,
        createdAt DATETIME DEFAULT CURRENT_TIMESTAMP,
        updatedAt DATETIME DEFAULT CURRENT_TIMESTAMP,
        FOREIGN KEY (userId) REFERENCES users(id)
    )`);
    
    // Create tool_history table for cross-device sync
    db.run(`CREATE TABLE IF NOT EXISTS tool_history (
        id TEXT PRIMARY KEY,
        userId INTEGER NOT NULL,
        userEmail TEXT,
        toolType TEXT NOT NULL,
        input TEXT,
        output TEXT,
        result TEXT,
        timestamp TEXT NOT NULL,
        createdAt DATETIME DEFAULT CURRENT_TIMESTAMP,
        FOREIGN KEY (userId) REFERENCES users(id)
    )`);
    
    // Create creator_history table for cross-device sync
    db.run(`CREATE TABLE IF NOT EXISTS creator_history (
        id TEXT PRIMARY KEY,
        userId INTEGER NOT NULL,
        userEmail TEXT,
        contentType TEXT NOT NULL,
        topic TEXT,
        tone TEXT,
        style TEXT,
        prompt TEXT,
        generatedContent TEXT,
        imageUrls TEXT,
        timestamp TEXT NOT NULL,
        createdAt DATETIME DEFAULT CURRENT_TIMESTAMP,
        FOREIGN KEY (userId) REFERENCES users(id)
    )`);
    
    // Create user_preferences table for user settings
    db.run(`CREATE TABLE IF NOT EXISTS user_preferences (
        userId INTEGER PRIMARY KEY,
        shortcuts TEXT,
        avatar TEXT,
        createdAt DATETIME DEFAULT CURRENT_TIMESTAMP,
        updatedAt DATETIME DEFAULT CURRENT_TIMESTAMP,
        FOREIGN KEY (userId) REFERENCES users(id)
    )`);
    
    // Create user_service_assignments table for admin service assignments
    // Allow multiple assignments per user per serviceType (users can have multiple projects of same type)
    // Migration: Check if table has old UNIQUE(userEmail, serviceType) constraint and migrate it
    db.get(`SELECT sql FROM sqlite_master WHERE type='table' AND name='user_service_assignments'`, [], (err, schema) => {
        if (err) {
            console.error('Error checking table schema:', err);
            // Continue to create table if it doesn't exist
        }
        
        if (schema && schema.sql && schema.sql.includes('UNIQUE(userEmail, serviceType)') && !schema.sql.includes('UNIQUE(userEmail, projectId)')) {
            console.log('[Migration] Detected old UNIQUE(userEmail, serviceType) constraint. Migrating table...');
            
            // Create new table with correct schema
            db.run(`CREATE TABLE user_service_assignments_new (
                id INTEGER PRIMARY KEY AUTOINCREMENT,
                userEmail TEXT NOT NULL,
                serviceType TEXT NOT NULL,
                projectId TEXT,
                progress INTEGER DEFAULT 0,
                dueDate TEXT,
                assignedAt DATETIME DEFAULT CURRENT_TIMESTAMP,
                createdAt DATETIME DEFAULT CURRENT_TIMESTAMP,
                UNIQUE(userEmail, projectId)
            )`, (err2) => {
                if (err2) {
                    console.error('[Migration] Error creating new table:', err2);
                    return;
                }
                
                // Copy all data from old table to new table
                db.run(`INSERT INTO user_service_assignments_new 
                    SELECT * FROM user_service_assignments`, (err3) => {
                    if (err3) {
                        console.error('[Migration] Error copying data:', err3);
                        return;
                    }
                    
                    // Drop old table
                    db.run(`DROP TABLE user_service_assignments`, (err4) => {
                        if (err4) {
                            console.error('[Migration] Error dropping old table:', err4);
                            return;
                        }
                        
                        // Rename new table to original name
                        db.run(`ALTER TABLE user_service_assignments_new RENAME TO user_service_assignments`, (err5) => {
                            if (err5) {
                                console.error('[Migration] Error renaming table:', err5);
                                return;
                            }
                            
                            console.log('[Migration] ✅ Successfully migrated user_service_assignments table to allow multiple projects per serviceType');
                        });
                    });
                });
            });
        } else {
            // Table doesn't exist or already has correct schema - create/ensure it exists
            db.run(`CREATE TABLE IF NOT EXISTS user_service_assignments (
                id INTEGER PRIMARY KEY AUTOINCREMENT,
                userEmail TEXT NOT NULL,
                serviceType TEXT NOT NULL,
                projectId TEXT,
                progress INTEGER DEFAULT 0,
                dueDate TEXT,
                assignedAt DATETIME DEFAULT CURRENT_TIMESTAMP,
                createdAt DATETIME DEFAULT CURRENT_TIMESTAMP,
                UNIQUE(userEmail, projectId)
            )`, (err6) => {
                if (err6) {
                    console.error('Error creating table:', err6);
                }
            });
        }
    });
    
    // Add new columns if they don't exist (for existing databases)
    db.run(`ALTER TABLE user_service_assignments ADD COLUMN projectId TEXT`, () => {});
    db.run(`ALTER TABLE user_service_assignments ADD COLUMN progress INTEGER DEFAULT 0`, () => {});
    db.run(`ALTER TABLE user_service_assignments ADD COLUMN dueDate TEXT`, () => {});
    db.run(`ALTER TABLE user_service_assignments ADD COLUMN assignedAt DATETIME DEFAULT CURRENT_TIMESTAMP`, () => {});
    
    // Create indexes for better query performance
    db.run(`CREATE INDEX IF NOT EXISTS idx_projects_userId ON projects(userId)`);
    db.run(`CREATE INDEX IF NOT EXISTS idx_tickets_projectId ON tickets(projectId)`);
    db.run(`CREATE INDEX IF NOT EXISTS idx_tickets_userId ON tickets(userId)`);
    db.run(`CREATE INDEX IF NOT EXISTS idx_invoices_projectId ON invoices(projectId)`);
    db.run(`CREATE INDEX IF NOT EXISTS idx_project_history_userId ON project_history(userId)`);
    db.run(`CREATE INDEX IF NOT EXISTS idx_project_history_projectId ON project_history(projectId)`);
    db.run(`CREATE INDEX IF NOT EXISTS idx_project_history_timestamp ON project_history(timestamp DESC)`);
    db.run(`CREATE INDEX IF NOT EXISTS idx_project_requests_userId ON project_requests(userId)`);
    db.run(`CREATE INDEX IF NOT EXISTS idx_project_requests_status ON project_requests(status)`);
    db.run(`CREATE INDEX IF NOT EXISTS idx_project_requests_submittedAt ON project_requests(submittedAt DESC)`);
    db.run(`CREATE INDEX IF NOT EXISTS idx_agent_requests_userId ON agent_requests(userId)`);
    db.run(`CREATE INDEX IF NOT EXISTS idx_agent_requests_status ON agent_requests(status)`);
    db.run(`CREATE INDEX IF NOT EXISTS idx_agent_requests_submittedAt ON agent_requests(submittedAt DESC)`);
    db.run(`CREATE INDEX IF NOT EXISTS idx_tool_history_userId ON tool_history(userId)`);
    db.run(`CREATE INDEX IF NOT EXISTS idx_tool_history_timestamp ON tool_history(timestamp DESC)`);
    db.run(`CREATE INDEX IF NOT EXISTS idx_creator_history_userId ON creator_history(userId)`);
    db.run(`CREATE INDEX IF NOT EXISTS idx_creator_history_timestamp ON creator_history(timestamp DESC)`);
    db.run(`CREATE INDEX IF NOT EXISTS idx_user_service_assignments_email ON user_service_assignments(userEmail)`);
    db.run(`CREATE INDEX IF NOT EXISTS idx_ai_chat_messages_userId ON ai_chat_messages(userId)`);
    db.run(`CREATE INDEX IF NOT EXISTS idx_ai_chat_messages_timestamp ON ai_chat_messages(timestamp DESC)`);
    db.run(`CREATE INDEX IF NOT EXISTS idx_activities_userId ON activities(userId)`);
    db.run(`CREATE INDEX IF NOT EXISTS idx_activities_timestamp ON activities(timestamp DESC)`);
});

// JWT Configuration
// Require JWT_SECRET from environment variables (no default fallback for security)
if (!process.env.JWT_SECRET) {
    console.error('❌ CRITICAL: JWT_SECRET is not set in environment variables!');
    console.error('Please set JWT_SECRET in your .env file before starting the server.');
    process.exit(1);
}
const JWT_SECRET = process.env.JWT_SECRET;

// JWT Middleware to verify tokens
const authenticateToken = (req, res, next) => {
    const authHeader = req.headers['authorization'];
    const token = authHeader && authHeader.split(' ')[1]; // Bearer TOKEN
    
    if (!token) {
        return res.status(401).json({ error: 'Access token required' });
    }
    
    jwt.verify(token, JWT_SECRET, (err, user) => {
        if (err) {
            return res.status(403).json({ error: 'Invalid or expired token' });
        }
        req.user = user;
        next();
    });
};

// Helper function to generate JWT token
function generateToken(user) {
    return jwt.sign(
        { 
            id: user.id, 
            email: user.email,
            role: user.role || 'Member' // Include role in token for admin checks
        },
        JWT_SECRET,
        { expiresIn: '30d' } // Token expires in 30 days
    );
}

// Helper function to generate verification code
function generateVerificationCode() {
    return Math.floor(100000 + Math.random() * 900000).toString();
}

// Helper function to get user by email
function getUserByEmail(email) {
    return new Promise((resolve, reject) => {
        db.get('SELECT * FROM users WHERE email = ?', [email.toLowerCase().trim()], (err, row) => {
            if (err) reject(err);
            else resolve(row);
        });
    });
}

// Helper function to get user by ID
function getUserById(id) {
    return new Promise((resolve, reject) => {
        db.get('SELECT id, email, name, company, role, emailVerified, avatar, createdAt, updatedAt FROM users WHERE id = ?', [id], (err, row) => {
            if (err) reject(err);
            else resolve(row);
        });
    });
}

// Initialize email transporter
// Supports Zoho Mail (recommended), SendGrid, and Yahoo Mail (fallback)
let emailTransporter = null;

function getEmailTransporter() {
    if (emailTransporter) {
        return emailTransporter;
    }
    
    // Use Zoho Mail if configured (recommended - professional, no blocking)
    if (process.env.ZOHO_EMAIL && process.env.ZOHO_PASSWORD) {
        emailTransporter = nodemailer.createTransport({
            host: 'smtp.zoho.com',
            port: 587,
            secure: false, // true for 465, false for other ports
            auth: {
                user: process.env.ZOHO_EMAIL,
                pass: process.env.ZOHO_PASSWORD
            },
            connectionTimeout: 5000,
            greetingTimeout: 5000,
            socketTimeout: 5000
        });
        console.log('✅ Using Zoho Mail for email delivery (professional, no blocking)');
        return emailTransporter;
    }
    
    // Use SendGrid if API key is provided
    if (process.env.SENDGRID_API_KEY) {
        emailTransporter = nodemailer.createTransport({
            host: 'smtp.sendgrid.net',
            port: 587,
            secure: false,
            auth: {
                user: 'apikey',
                pass: process.env.SENDGRID_API_KEY
            },
            connectionTimeout: 5000,
            greetingTimeout: 5000,
            socketTimeout: 5000
        });
        console.log('✅ Using SendGrid for email delivery');
        return emailTransporter;
    }
    
    // Fallback to Yahoo Mail (not recommended - may block)
    if (process.env.EMAIL_USER && process.env.EMAIL_PASS) {
        emailTransporter = nodemailer.createTransport({
            host: 'smtp.mail.yahoo.com',
            port: 587,
            secure: false,
            auth: {
                user: process.env.EMAIL_USER,
                pass: process.env.EMAIL_PASS
            },
            connectionTimeout: 3000,
            greetingTimeout: 3000,
            socketTimeout: 3000
        });
        console.log('⚠️  Using Yahoo Mail (may have blocking issues)');
        return emailTransporter;
    }
    
    throw new Error('Email configuration missing. Set ZOHO_EMAIL/ZOHO_PASSWORD (recommended), SENDGRID_API_KEY, or EMAIL_USER/EMAIL_PASS');
}

// Initialize Telegram bot
const telegramBot = new TelegramBot(process.env.TELEGRAM_BOT_TOKEN || 'YOUR_BOT_TOKEN', { polling: false });
const telegramChatId = process.env.TELEGRAM_CHAT_ID || 'YOUR_CHAT_ID';

// Initialize Google Gemini AI
const genAI = process.env.GEMINI_API_KEY ? new GoogleGenerativeAI(process.env.GEMINI_API_KEY) : null;

// Initialize Groq API for fallback (Main and Fallback keys)
// NOTE: For production, set these in .env file as GROQ_API_KEY_MAIN and GROQ_API_KEY_FALLBACK
// API keys should be set via environment variables for security
const groqApiKeys = [
  process.env.GROQ_API_KEY_MAIN || process.env.WEBSITE_CHATBOT_GROQ_MAIN || null,     // Main Groq key
  process.env.GROQ_API_KEY_FALLBACK || process.env.WEBSITE_CHATBOT_FALLBACK_GROQ || null  // Fallback Groq key
].filter(key => key !== null);

// Create array of Groq instances
const groqInstances = groqApiKeys.map(key => new Groq({ apiKey: key }));

// Routes

// Health check
app.get('/api/health', (req, res) => {
    res.json({ status: 'OK', message: 'Consultation Booking API is running' });
});

// Get all bookings
app.get('/api/bookings', (req, res) => {
    db.all('SELECT * FROM bookings ORDER BY created_at DESC', (err, rows) => {
        if (err) {
            res.status(500).json({ error: 'Failed to fetch bookings' });
            return;
        }
        res.json(rows);
    });
});

// Create new booking
app.post('/api/bookings', async (req, res) => {
    const { name, email, phone, company, date, time, message } = req.body;
    
    if (!name || !email || !date || !time) {
        return res.status(400).json({ error: 'Missing required fields' });
    }
    
    try {
        // Insert booking into database
        const bookingId = await new Promise((resolve, reject) => {
            db.run(
                'INSERT INTO bookings (name, email, phone, company, date, time, message) VALUES (?, ?, ?, ?, ?, ?, ?)',
                [name, email, phone || null, company || null, date, time, message || null],
                function(err) {
                    if (err) reject(err);
                    else resolve(this.lastID);
                }
            );
        });
        
        const booking = {
            id: bookingId,
            name,
            email,
            phone,
            company,
            date,
            time,
            message,
            status: 'upcoming',
            created_at: new Date().toISOString()
        };
        
        // Send notifications (don't fail booking if notifications fail)
        const notificationResults = {
            email: false,
            telegram: false
        };
        
        try {
            await sendEmailConfirmation(booking);
            notificationResults.email = true;
        } catch (emailError) {
            console.error('❌ Email notification failed (booking still saved):', emailError.message || emailError);
            console.error('Full email error details:', JSON.stringify(emailError, Object.getOwnPropertyNames(emailError)));
            if (emailError.response) {
                console.error('Email service response:', emailError.response);
            }
            if (emailError.code) {
                console.error('Error code:', emailError.code);
            }
        }
        
        try {
            await sendTelegramNotification(booking);
            notificationResults.telegram = true;
        } catch (telegramError) {
            console.error('❌ Telegram notification failed (booking still saved):', telegramError.message || telegramError);
            if (telegramError.response) {
                console.error('Telegram API response:', telegramError.response);
            }
        }
        
        console.log(`✅ Booking #${bookingId} created. Notifications - Email: ${notificationResults.email ? '✅' : '❌'}, Telegram: ${notificationResults.telegram ? '✅' : '❌'}`);
        
        res.status(201).json({ 
            message: 'Booking created successfully', 
            booking,
            notifications: notificationResults
        });
        
    } catch (error) {
        console.error('❌ Error creating booking:', error);
        res.status(500).json({ error: 'Failed to create booking: ' + error.message });
    }
});

// Update booking
app.put('/api/bookings/:id', (req, res) => {
    const { id } = req.params;
    const { name, email, phone, company, date, time, message, status } = req.body;
    
    db.run(
        'UPDATE bookings SET name = ?, email = ?, phone = ?, company = ?, date = ?, time = ?, message = ?, status = ? WHERE id = ?',
        [name, email, phone, company, date, time, message, status, id],
        function(err) {
            if (err) {
                res.status(500).json({ error: 'Failed to update booking' });
                return;
            }
            res.json({ message: 'Booking updated successfully' });
        }
    );
});

// Delete booking
app.delete('/api/bookings/:id', (req, res) => {
    const { id } = req.params;
    
    db.run('DELETE FROM bookings WHERE id = ?', [id], function(err) {
        if (err) {
            res.status(500).json({ error: 'Failed to delete booking' });
            return;
        }
        res.json({ message: 'Booking deleted successfully' });
    });
});

// Send Telegram notification
async function sendTelegramNotification(booking) {
    // Check if Telegram is configured
    if (!process.env.TELEGRAM_BOT_TOKEN || process.env.TELEGRAM_BOT_TOKEN === 'YOUR_BOT_TOKEN') {
        throw new Error('Telegram bot token not configured');
    }
    
    if (!process.env.TELEGRAM_CHAT_ID || process.env.TELEGRAM_CHAT_ID === 'YOUR_CHAT_ID') {
        throw new Error('Telegram chat ID not configured');
    }
    
    const formattedDate = new Date(booking.date).toLocaleDateString('en-US', {
        weekday: 'long',
        year: 'numeric',
        month: 'long',
        day: 'numeric'
    });
    
    const message = `
🎉 New Consultation Booking!

👤 Client: ${booking.name}
📧 Email: ${booking.email}
${booking.phone ? `📞 Phone: ${booking.phone}` : ''}
${booking.company ? `🏢 Company: ${booking.company}` : ''}
📅 Date: ${formattedDate}
🕐 Time: ${booking.time}
${booking.message ? `💬 Message: ${booking.message}` : ''}

Booked at: ${new Date(booking.created_at).toLocaleString()}
    `.trim();
    
    await telegramBot.sendMessage(telegramChatId, message);
    console.log('✅ Telegram notification sent successfully');
}

// Send email confirmation
async function sendEmailConfirmation(booking) {
    // Check if email is configured
    if (!process.env.ZOHO_EMAIL && !process.env.SENDGRID_API_KEY && (!process.env.EMAIL_USER || !process.env.EMAIL_PASS)) {
        throw new Error('Email configuration is missing. Please set ZOHO_EMAIL/ZOHO_PASSWORD, SENDGRID_API_KEY, or EMAIL_USER/EMAIL_PASS in .env file');
    }
    
    const formattedDate = new Date(booking.date).toLocaleDateString('en-US', {
        weekday: 'long',
        year: 'numeric',
        month: 'long',
        day: 'numeric'
    });
    
    const mailOptions = {
        from: `"InfiNet" <${process.env.ZOHO_EMAIL || process.env.SENDGRID_FROM_EMAIL || process.env.EMAIL_USER || 'admin@infinet.services'}>`,
        to: booking.email,
        subject: 'Consultation Booking Confirmed - InfiNet',
        html: `
            <!DOCTYPE html>
            <html lang="en">
            <head>
                <meta charset="UTF-8">
                <meta name="viewport" content="width=device-width, initial-scale=1.0">
                <title>Booking Confirmed - InfiNet</title>
            </head>
            <body style="margin: 0; padding: 0; font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, 'Helvetica Neue', Arial, sans-serif; background-color: #f5f5f5;">
                <table role="presentation" cellspacing="0" cellpadding="0" border="0" width="100%" style="background-color: #f5f5f5;">
                    <tr>
                        <td align="center" style="padding: 40px 20px;">
                            <table role="presentation" cellspacing="0" cellpadding="0" border="0" width="600" style="max-width: 600px; background-color: #ffffff; border-radius: 12px; box-shadow: 0 4px 6px rgba(0, 0, 0, 0.1); overflow: hidden;">
                                <tr>
                                    <td style="background: linear-gradient(135deg, #72FF13 0%, #72FF13 30%, #00F0FF 30%, #00F0FF 100%); padding: 40px 30px; text-align: center;">
                                        <h1 style="margin: 0; color: #000000; font-size: 32px; font-weight: 700; letter-spacing: -0.5px;">Booking Confirmed!</h1>
                                        <p style="margin: 12px 0 0 0; color: #000000; font-size: 16px; opacity: 0.95;">Your consultation with Mr. Amir Hteit has been successfully scheduled.</p>
                                    </td>
                                </tr>
                                <tr>
                                    <td style="padding: 40px 30px;">
                                        <h2 style="color: #000000; margin-top: 0; font-size: 20px; font-weight: 700;">📋 Booking Details</h2>
                                        
                                        <div style="background: linear-gradient(135deg, #E0F7FF 0%, #E0F7FF 100%); padding: 20px; border-radius: 8px; margin-bottom: 20px; border-left: 4px solid #060097;">
                                            <p style="margin: 8px 0; color: #000000; font-size: 14px; line-height: 1.6;"><strong>👤 Name:</strong> ${booking.name}</p>
                                            <p style="margin: 8px 0; color: #000000; font-size: 14px; line-height: 1.6;"><strong>📧 Email:</strong> ${booking.email}</p>
                                            ${booking.phone ? `<p style="margin: 8px 0; color: #000000; font-size: 14px; line-height: 1.6;"><strong>📞 Phone:</strong> ${booking.phone}</p>` : ''}
                                            ${booking.company ? `<p style="margin: 8px 0; color: #000000; font-size: 14px; line-height: 1.6;"><strong>🏢 Company:</strong> ${booking.company}</p>` : ''}
                                            <p style="margin: 8px 0; color: #000000; font-size: 14px; line-height: 1.6;"><strong>📅 Date:</strong> ${formattedDate}</p>
                                            <p style="margin: 8px 0; color: #000000; font-size: 14px; line-height: 1.6;"><strong>🕐 Time:</strong> ${booking.time}</p>
                                            <p style="margin: 8px 0; color: #000000; font-size: 14px; line-height: 1.6;"><strong>⏱️ Duration:</strong> 30 minutes</p>
                                            <p style="margin: 8px 0; color: #000000; font-size: 14px; line-height: 1.6;"><strong>👨‍💼 Meeting with:</strong> Mr. Amir Hteit</p>
                                        </div>
                                        
                                        ${booking.message ? `
                                        <div style="background: linear-gradient(135deg, #E6FFE6 0%, #E6FFE6 100%); padding: 20px; border-radius: 8px; margin-bottom: 20px;">
                                            <h3 style="color: #000000; margin-top: 0; font-size: 16px; font-weight: 600;">💬 Your Message</h3>
                                            <p style="margin: 0; color: #000000; font-size: 14px; line-height: 1.6;">${booking.message}</p>
                                        </div>
                                        ` : ''}
                                        
                                        <div style="background: linear-gradient(135deg, #E0F7FF 0%, #E0F7FF 100%); padding: 20px; border-radius: 8px; margin-bottom: 20px;">
                                            <h3 style="color: #ff0000; margin-top: 0; font-size: 16px; font-weight: 600;">📞 Important Notes</h3>
                                            <ul style="margin: 0; padding-left: 20px; color: #000000; font-size: 14px; line-height: 1.8;">
                                                <li>Please be ready 5 minutes before your scheduled time</li>
                                                <li>If you need to reschedule or cancel, please contact us at least 24 hours in advance</li>
                                                <li>Prepare any relevant documents or questions you'd like to discuss</li>
                                                <li>This is a free consultation to understand your project needs</li>
                                            </ul>
                                        </div>
                                        
                                        <div style="text-align: center; margin-top: 30px;">
                                            <p style="color: #666666; font-size: 14px; line-height: 1.6;">
                                                Questions? Contact us at <a href="mailto:admin@infinet.services" style="color: #060097; text-decoration: none;">admin@infinet.services</a>
                                            </p>
                                            <p style="color: #666666; font-size: 12px; margin-top: 20px;">
                                                This email was sent because you booked a consultation on our website.
                                            </p>
                                        </div>
                                    </td>
                                </tr>
                                <tr>
                                    <td style="padding: 30px; background: linear-gradient(135deg, #E6FFE6 0%, #E0F7FF 100%); border-top: 1px solid #B0E0FF; text-align: center;">
                                        <p style="margin: 0; color: #666666; font-size: 12px;">
                                            © ${new Date().getFullYear()} InfiNet. All rights reserved.
                                        </p>
                                    </td>
                                </tr>
                            </table>
                        </td>
                    </tr>
                </table>
            </body>
            </html>
        `
    };
    
    try {
        const transporter = getEmailTransporter();
        const info = await transporter.sendMail(mailOptions);
        console.log('✅ Email confirmation sent successfully to:', booking.email);
        console.log('Email message ID:', info.messageId);
        return info;
    } catch (sendError) {
        console.error('❌ Failed to send email:', sendError.message || sendError);
        console.error('Error code:', sendError.code);
        console.error('Error command:', sendError.command);
        if (sendError.response) {
            console.error('SMTP response:', sendError.response);
        }
        throw sendError;
    }
}

// Send email verification
async function sendEmailVerification(email, name, verificationCode, verificationExpiry, isResend = false) {
    // Check if email is configured
    if (!process.env.ZOHO_EMAIL && !process.env.SENDGRID_API_KEY && (!process.env.EMAIL_USER || !process.env.EMAIL_PASS)) {
        throw new Error('Email configuration is missing. Please set ZOHO_EMAIL/ZOHO_PASSWORD, SENDGRID_API_KEY, or EMAIL_USER/EMAIL_PASS in .env file');
    }
    
    // Create login URL with verification code - opens app's login page with verification field
    // For mobile app deep linking, use a custom URL scheme or web redirect
    const appLoginUrl = `infinethub://login?email=${encodeURIComponent(email)}&code=${verificationCode}`;
    // Fallback web URL that shows instructions
    const webLoginUrl = `https://infinet.services/api/verify-email-redirect?email=${encodeURIComponent(email)}&code=${verificationCode}`;
    
    // Determine which email service to use based on recipient
    // Use Yahoo SMTP for Yahoo recipients to avoid spam filtering
    const isYahooRecipient = email.toLowerCase().includes('@yahoo.com') || email.toLowerCase().includes('@ymail.com');
    let fromEmail;
    let transporter;
    
    if (isYahooRecipient && process.env.EMAIL_USER && process.env.EMAIL_PASS) {
        // Use Yahoo SMTP for Yahoo recipients
        transporter = nodemailer.createTransport({
            host: 'smtp.mail.yahoo.com',
            port: 587,
            secure: false,
            auth: {
                user: process.env.EMAIL_USER,
                pass: process.env.EMAIL_PASS
            },
            connectionTimeout: 5000,
            greetingTimeout: 5000,
            socketTimeout: 5000
        });
        fromEmail = process.env.EMAIL_USER;
        console.log('📧 Using Yahoo SMTP for Yahoo recipient:', email);
    } else {
        // Use default transporter (Zoho or SendGrid)
        transporter = getEmailTransporter();
        fromEmail = process.env.ZOHO_EMAIL || process.env.SENDGRID_FROM_EMAIL || process.env.EMAIL_USER || 'contact.infinet@yahoo.com';
    }
    
    // Create plain text version
    const plainText = `
Hi ${name},

${isResend ? 'You requested a new verification code. Use the code below to verify your email address.' : 'Thank you for creating your InfiNet Hub account! Use the 6-digit code below to verify your email address and complete your registration.'}

Your Verification Code: ${verificationCode}

Instructions:
- Copy the 6-digit code above
- Open the InfiNet Hub app and go to Login page
- Paste the code in the verification field
- Click "Verify Email" to complete registration
- This code will expire in 24 hours

Or visit: ${webLoginUrl}

Need help? Contact us at contact.infinet@yahoo.com

© ${new Date().getFullYear()} InfiNet. All rights reserved.
    `.trim();

    const mailOptions = {
        from: `"InfiNet Hub" <${fromEmail}>`,
        to: email,
        replyTo: fromEmail,
        subject: isResend ? 'New Verification Code - InfiNet Hub' : 'Verify Your InfiNet Hub Account',
        text: plainText,
        html: `
            <!DOCTYPE html>
            <html lang="en">
            <head>
                <meta charset="UTF-8">
                <meta name="viewport" content="width=device-width, initial-scale=1.0">
                <title>Verify Your Email - InfiNet Hub</title>
            </head>
            <body style="margin: 0; padding: 0; font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, 'Helvetica Neue', Arial, sans-serif; background-color: #f5f5f5;">
                <table role="presentation" cellspacing="0" cellpadding="0" border="0" width="100%" style="background-color: #f5f5f5;">
                    <tr>
                        <td align="center" style="padding: 40px 20px;">
                            <table role="presentation" cellspacing="0" cellpadding="0" border="0" width="600" style="max-width: 600px; background-color: #ffffff; border-radius: 12px; box-shadow: 0 4px 6px rgba(0, 0, 0, 0.1); overflow: hidden;">
                                <!-- Header with Light Gradient -->
                                <tr>
                                    <td style="background: linear-gradient(135deg, #72FF13 0%, #72FF13 30%, #00F0FF 30%, #00F0FF 100%); padding: 40px 30px; text-align: center;">
                                        <h1 style="margin: 0; color: #000000; font-size: 32px; font-weight: 700; letter-spacing: -0.5px;">Welcome to InfiNet Hub! 🚀</h1>
                                        <p style="margin: 12px 0 0 0; color: #000000; font-size: 16px; opacity: 0.95;">Your verification code is below</p>
                                    </td>
                                </tr>
                                
                                <!-- Main Content -->
                                <tr>
                                    <td style="padding: 40px 30px;">
                                        <p style="margin: 0 0 20px 0; color: #333333; font-size: 16px; line-height: 1.6;">
                                            Hi <strong>${name}</strong>,
                                        </p>
                                        ${isResend ? `
                                        <div style="margin: 0 0 20px 0; padding: 15px; background: #fff3cd; border-left: 4px solid #ffc107; border-radius: 4px;">
                                            <p style="margin: 0; color: #856404; font-size: 14px; font-weight: 600;">📧 New Verification Code Requested</p>
                                            <p style="margin: 5px 0 0 0; color: #856404; font-size: 14px;">You requested a new verification code. Use the code below to verify your email address.</p>
                                        </div>
                                        ` : `
                                        <p style="margin: 0 0 30px 0; color: #666666; font-size: 16px; line-height: 1.6;">
                                            Thank you for creating your InfiNet Hub account! Use the 6-digit code below to verify your email address and complete your registration.
                                        </p>
                                        `}
                                        
                                        <!-- 6-Digit Code Display -->
                                        <table role="presentation" cellspacing="0" cellpadding="0" border="0" width="100%">
                                            <tr>
                                                <td align="center" style="padding: 20px 0;">
                                                    <div style="background: linear-gradient(135deg, #72FF13 0%, #72FF13 30%, #00F0FF 30%, #00F0FF 100%); padding: 30px; border-radius: 12px; display: inline-block;">
                                                        <p style="margin: 0 0 10px 0; color: #000000; font-size: 14px; font-weight: 600; text-transform: uppercase; letter-spacing: 1px;">Your Verification Code</p>
                                                        <p style="margin: 0; color: #000000; font-size: 48px; font-weight: 700; letter-spacing: 8px; font-family: 'Courier New', monospace;">${verificationCode}</p>
                                                    </div>
                                                </td>
                                            </tr>
                                        </table>
                                        
                                        <!-- Login Link Button -->
                                        <table role="presentation" cellspacing="0" cellpadding="0" border="0" width="100%">
                                            <tr>
                                                <td align="center" style="padding: 30px 0 20px 0;">
                                                    <a href="${webLoginUrl}" style="display: inline-block; padding: 16px 40px; background: linear-gradient(135deg, #72FF13 0%, #72FF13 30%, #00F0FF 30%, #00F0FF 100%); color: #000000; text-decoration: none; border-radius: 8px; font-weight: 600; font-size: 16px; box-shadow: 0 4px 12px rgba(114, 255, 19, 0.3); transition: all 0.3s ease;">
                                                        ✨ Open Login Page
                                                    </a>
                                                </td>
                                            </tr>
                                        </table>
                                        
                                        <!-- Instructions -->
                                        <div style="margin: 30px 0 0 0; padding: 20px; background: linear-gradient(135deg, #E6FFE6 0%, #E0F7FF 100%); border-left: 4px solid #72FF13; border-radius: 6px;">
                                            <p style="margin: 0 0 10px 0; color: #0369a1; font-size: 14px; font-weight: 600;">📌 Instructions:</p>
                                            <ul style="margin: 0; padding-left: 20px; color: #0369a1; font-size: 14px; line-height: 1.8;">
                                                <li>Copy the 6-digit code above</li>
                                                <li>Open the InfiNet Hub app and go to Login page</li>
                                                <li>Paste the code in the verification field</li>
                                                <li>Click "Verify Email" to complete registration</li>
                                                <li>This code will expire in 24 hours</li>
                                            </ul>
                                        </div>
                                        
                                        <!-- Alternative: Click Link -->
                                        <p style="margin: 20px 0 0 0; color: #666666; font-size: 14px; line-height: 1.6; text-align: center;">
                                            Or click the button above to open the login page directly
                                        </p>
                                    </td>
                                </tr>
                                
                                <!-- Footer -->
                                <tr>
                                    <td style="padding: 30px; background: linear-gradient(135deg, #E6FFE6 0%, #E0F7FF 100%); border-top: 1px solid #B0E0FF; text-align: center;">
                                        <p style="margin: 0 0 10px 0; color: #0369a1; font-size: 14px;">
                                            Need help? Contact us at <a href="mailto:contact.infinet@yahoo.com" style="color: #00F0FF; text-decoration: none; font-weight: 600;">contact.infinet@yahoo.com</a>
                                        </p>
                                        <p style="margin: 0; color: #666666; font-size: 12px;">
                                            © ${new Date().getFullYear()} InfiNet. All rights reserved.
                                        </p>
                                    </td>
                                </tr>
                            </table>
                        </td>
                    </tr>
                </table>
            </body>
            </html>
        `,
        headers: {
            'X-Mailer': 'InfiNet Hub Email Service',
            'X-Priority': '1',
            'Importance': 'high',
            'Precedence': 'bulk',
            'List-Unsubscribe': `<mailto:${fromEmail}?subject=unsubscribe>`,
            'List-Unsubscribe-Post': 'List-Unsubscribe=One-Click'
        },
        // Add priority for better delivery
        priority: 'high'
    };
    
    try {
        const info = await transporter.sendMail(mailOptions);
        console.log('✅ Verification email sent successfully to:', email);
        console.log('Email message ID:', info.messageId);
        return info;
    } catch (sendError) {
        console.error('❌ Failed to send verification email:', sendError.message || sendError);
        console.error('Error code:', sendError.code);
        if (sendError.response) {
            console.error('SMTP response:', sendError.response);
        }
        throw sendError;
    }
}

// Send project confirmation email
async function sendProjectConfirmationEmail(email, name, projectName, serviceType) {
    // Check if email is configured
    if (!process.env.ZOHO_EMAIL && !process.env.SENDGRID_API_KEY && (!process.env.EMAIL_USER || !process.env.EMAIL_PASS)) {
        throw new Error('Email configuration is missing. Please set ZOHO_EMAIL/ZOHO_PASSWORD, SENDGRID_API_KEY, or EMAIL_USER/EMAIL_PASS in .env file');
    }
    
    // Determine which email service to use based on recipient
    // Use Yahoo SMTP for Yahoo recipients to avoid spam filtering
    const isYahooRecipient = email.toLowerCase().includes('@yahoo.com') || email.toLowerCase().includes('@ymail.com');
    let fromEmail;
    let transporter;
    
    if (isYahooRecipient && process.env.EMAIL_USER && process.env.EMAIL_PASS) {
        // Use Yahoo SMTP for Yahoo recipients
        transporter = nodemailer.createTransport({
            host: 'smtp.mail.yahoo.com',
            port: 587,
            secure: false,
            auth: {
                user: process.env.EMAIL_USER,
                pass: process.env.EMAIL_PASS
            },
            connectionTimeout: 5000,
            greetingTimeout: 5000,
            socketTimeout: 5000
        });
        fromEmail = process.env.EMAIL_USER;
        console.log('📧 Using Yahoo SMTP for Yahoo recipient:', email);
    } else {
        // Use default transporter (Zoho or SendGrid)
        transporter = getEmailTransporter();
        fromEmail = process.env.ZOHO_EMAIL || process.env.SENDGRID_FROM_EMAIL || process.env.EMAIL_USER || 'admin@infinet.services';
    }
    
    const mailOptions = {
        from: `"InfiNet" <${fromEmail}>`,
        to: email,
        subject: 'Project Request Confirmation - InfiNet Hub',
        html: `
            <!DOCTYPE html>
            <html lang="en">
            <head>
                <meta charset="UTF-8">
                <meta name="viewport" content="width=device-width, initial-scale=1.0">
                <title>Project Request Confirmation - InfiNet Hub</title>
            </head>
            <body style="margin: 0; padding: 0; font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, 'Helvetica Neue', Arial, sans-serif; background-color: #f5f5f5;">
                <table role="presentation" cellspacing="0" cellpadding="0" border="0" width="100%" style="background-color: #f5f5f5;">
                    <tr>
                        <td align="center" style="padding: 40px 20px;">
                            <table role="presentation" cellspacing="0" cellpadding="0" border="0" width="600" style="max-width: 600px; background-color: #ffffff; border-radius: 12px; box-shadow: 0 4px 6px rgba(0, 0, 0, 0.1); overflow: hidden;">
                                <!-- Header with Light Gradient -->
                                <tr>
                                    <td style="background: linear-gradient(135deg, #72FF13 0%, #72FF13 30%, #00F0FF 30%, #00F0FF 100%); padding: 40px 30px; text-align: center;">
                                        <h1 style="margin: 0; color: #000000; font-size: 32px; font-weight: 700; letter-spacing: -0.5px;">Project Request Received! 🎉</h1>
                                        <p style="margin: 12px 0 0 0; color: #000000; font-size: 16px; opacity: 0.95;">We've received your project request</p>
                                    </td>
                                </tr>
                                
                                <!-- Main Content -->
                                <tr>
                                    <td style="padding: 40px 30px;">
                                        <p style="margin: 0 0 20px 0; color: #333333; font-size: 16px; line-height: 1.6;">
                                            Hi <strong>${name}</strong>,
                                        </p>
                                        <p style="margin: 0 0 30px 0; color: #666666; font-size: 16px; line-height: 1.6;">
                                            Thank you for submitting your project request! We've received your <strong>${serviceType}</strong> project request for <strong>${projectName}</strong> and our team will review it shortly.
                                        </p>
                                        
                                        <!-- Project Details Box -->
                                        <div style="margin: 30px 0; padding: 20px; background: linear-gradient(135deg, #E6FFE6 0%, #E0F7FF 100%); border-left: 4px solid #72FF13; border-radius: 6px;">
                                            <p style="margin: 0 0 10px 0; color: #0369a1; font-size: 14px; font-weight: 600;">📋 Project Details:</p>
                                            <p style="margin: 5px 0; color: #0369a1; font-size: 14px; line-height: 1.8;">
                                                <strong>Service Type:</strong> ${serviceType}<br>
                                                <strong>Project Name:</strong> ${projectName}
                                            </p>
                                        </div>
                                        
                                        <!-- Next Steps -->
                                        <div style="margin: 30px 0 0 0; padding: 20px; background: linear-gradient(135deg, #E6FFE6 0%, #E0F7FF 100%); border-left: 4px solid #72FF13; border-radius: 6px;">
                                            <p style="margin: 0 0 10px 0; color: #0369a1; font-size: 14px; font-weight: 600;">📌 What's Next?</p>
                                            <ul style="margin: 0; padding-left: 20px; color: #0369a1; font-size: 14px; line-height: 1.8;">
                                                <li>Our team will review your project request</li>
                                                <li>We'll contact you ASAP to discuss further details</li>
                                                <li>We'll confirm your project and provide next steps</li>
                                                <li>You can track your project status in the InfiNet Hub app</li>
                                            </ul>
                                        </div>
                                        
                                        <p style="margin: 30px 0 0 0; color: #666666; font-size: 14px; line-height: 1.6; text-align: center;">
                                            We're excited to work with you on this project!
                                        </p>
                                    </td>
                                </tr>
                                
                                <!-- Footer -->
                                <tr>
                                    <td style="padding: 30px; background: linear-gradient(135deg, #E6FFE6 0%, #E0F7FF 100%); border-top: 1px solid #B0E0FF; text-align: center;">
                                        <p style="margin: 0 0 10px 0; color: #0369a1; font-size: 14px;">
                                            Questions? Contact us at <a href="mailto:admin@infinet.services" style="color: #00F0FF; text-decoration: none; font-weight: 600;">admin@infinet.services</a>
                                        </p>
                                        <p style="margin: 0; color: #666666; font-size: 12px;">
                                            © ${new Date().getFullYear()} InfiNet. All rights reserved.
                                        </p>
                                    </td>
                                </tr>
                            </table>
                        </td>
                    </tr>
                </table>
            </body>
            </html>
        `
    };
    
    try {
        const info = await transporter.sendMail(mailOptions);
        console.log('✅ Project confirmation email sent successfully to:', email);
        console.log('Email message ID:', info.messageId);
        return info;
    } catch (sendError) {
        console.error('❌ Failed to send project confirmation email:', sendError.message || sendError);
        console.error('Error code:', sendError.code);
        if (sendError.response) {
            console.error('SMTP response:', sendError.response);
        }
        throw sendError;
    }
}

// Send password reset email
async function sendPasswordResetEmail(email, name, verificationCode, verificationExpiry) {
    // Check if email is configured
    if (!process.env.ZOHO_EMAIL && !process.env.SENDGRID_API_KEY && (!process.env.EMAIL_USER || !process.env.EMAIL_PASS)) {
        throw new Error('Email configuration is missing. Please set ZOHO_EMAIL/ZOHO_PASSWORD, SENDGRID_API_KEY, or EMAIL_USER/EMAIL_PASS in .env file');
    }
    
    // Create login URL with verification code - opens app's login page with verification field
    const appLoginUrl = `infinethub://login?email=${encodeURIComponent(email)}&code=${verificationCode}`;
    // Fallback web URL that shows instructions
    const webLoginUrl = `https://infinet.services/api/verify-email-redirect?email=${encodeURIComponent(email)}&code=${verificationCode}`;
    
    // Determine which email service to use based on recipient
    // Use Yahoo SMTP for Yahoo recipients to avoid spam filtering
    const isYahooRecipient = email.toLowerCase().includes('@yahoo.com') || email.toLowerCase().includes('@ymail.com');
    let fromEmail;
    let transporter;
    
    if (isYahooRecipient && process.env.EMAIL_USER && process.env.EMAIL_PASS) {
        // Use Yahoo SMTP for Yahoo recipients
        transporter = nodemailer.createTransport({
            host: 'smtp.mail.yahoo.com',
            port: 587,
            secure: false,
            auth: {
                user: process.env.EMAIL_USER,
                pass: process.env.EMAIL_PASS
            },
            connectionTimeout: 5000,
            greetingTimeout: 5000,
            socketTimeout: 5000
        });
        fromEmail = process.env.EMAIL_USER;
        console.log('📧 Using Yahoo SMTP for Yahoo recipient:', email);
    } else {
        // Use default transporter (Zoho or SendGrid)
        transporter = getEmailTransporter();
        fromEmail = process.env.ZOHO_EMAIL || process.env.SENDGRID_FROM_EMAIL || process.env.EMAIL_USER || 'admin@infinet.services';
    }
    
    // Create plain text version
    const plainTextReset = `
Hi ${name},

You requested to reset your password for your InfiNet Hub account. Use the 6-digit code below to verify your identity and complete the password reset process.

Your Verification Code: ${verificationCode}

Instructions:
- Copy the 6-digit code above
- Open the InfiNet Hub app and go to Login page
- Click "Forget Your Password?"
- Enter your email and new password, then click "Send Code"
- Paste the code in the verification field
- Click "Confirm" to reset your password
- This code will expire in 24 hours

Or visit: ${webLoginUrl}

Security Notice: If you didn't request a password reset, please ignore this email. Your account remains secure.

Need help? Contact us at admin@infinet.services

© ${new Date().getFullYear()} InfiNet. All rights reserved.
    `.trim();

    const mailOptions = {
        from: `"InfiNet Hub" <${fromEmail}>`,
        to: email,
        replyTo: fromEmail,
        subject: 'Reset Your Password - InfiNet Hub',
        text: plainTextReset,
        html: `
            <!DOCTYPE html>
            <html lang="en">
            <head>
                <meta charset="UTF-8">
                <meta name="viewport" content="width=device-width, initial-scale=1.0">
                <title>Reset Your Password - InfiNet Hub</title>
            </head>
            <body style="margin: 0; padding: 0; font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, 'Helvetica Neue', Arial, sans-serif; background-color: #f5f5f5;">
                <table role="presentation" cellspacing="0" cellpadding="0" border="0" width="100%" style="background-color: #f5f5f5;">
                    <tr>
                        <td align="center" style="padding: 40px 20px;">
                            <table role="presentation" cellspacing="0" cellpadding="0" border="0" width="600" style="max-width: 600px; background-color: #ffffff; border-radius: 12px; box-shadow: 0 4px 6px rgba(0, 0, 0, 0.1); overflow: hidden;">
                                <!-- Header with Light Gradient -->
                                <tr>
                                    <td style="background: linear-gradient(135deg, #72FF13 0%, #72FF13 30%, #00F0FF 30%, #00F0FF 100%); padding: 40px 30px; text-align: center;">
                                        <h1 style="margin: 0; color: #000000; font-size: 32px; font-weight: 700; letter-spacing: -0.5px;">Password Reset Request 🔐</h1>
                                        <p style="margin: 12px 0 0 0; color: #000000; font-size: 16px; opacity: 0.95;">Your verification code is below</p>
                                    </td>
                                </tr>
                                
                                <!-- Main Content -->
                                <tr>
                                    <td style="padding: 40px 30px;">
                                        <p style="margin: 0 0 20px 0; color: #333333; font-size: 16px; line-height: 1.6;">
                                            Hi <strong>${name}</strong>,
                                        </p>
                                        <p style="margin: 0 0 30px 0; color: #666666; font-size: 16px; line-height: 1.6;">
                                            You requested to reset your password for your InfiNet Hub account. Use the 6-digit code below to verify your identity and complete the password reset process.
                                        </p>
                                        
                                        <!-- 6-Digit Code Display -->
                                        <table role="presentation" cellspacing="0" cellpadding="0" border="0" width="100%">
                                            <tr>
                                                <td align="center" style="padding: 20px 0;">
                                                    <div style="background: linear-gradient(135deg, #72FF13 0%, #72FF13 30%, #00F0FF 30%, #00F0FF 100%); padding: 30px; border-radius: 12px; display: inline-block;">
                                                        <p style="margin: 0 0 10px 0; color: #000000; font-size: 14px; font-weight: 600; text-transform: uppercase; letter-spacing: 1px;">Your Verification Code</p>
                                                        <p style="margin: 0; color: #000000; font-size: 48px; font-weight: 700; letter-spacing: 8px; font-family: 'Courier New', monospace;">${verificationCode}</p>
                                                    </div>
                                                </td>
                                            </tr>
                                        </table>
                                        
                                        <!-- Login Link Button -->
                                        <table role="presentation" cellspacing="0" cellpadding="0" border="0" width="100%">
                                            <tr>
                                                <td align="center" style="padding: 30px 0 20px 0;">
                                                    <a href="${webLoginUrl}" style="display: inline-block; padding: 16px 40px; background: linear-gradient(135deg, #72FF13 0%, #72FF13 30%, #00F0FF 30%, #00F0FF 100%); color: #000000; text-decoration: none; border-radius: 8px; font-weight: 600; font-size: 16px; box-shadow: 0 4px 12px rgba(114, 255, 19, 0.3); transition: all 0.3s ease;">
                                                        ✨ Open Reset Password Page
                                                    </a>
                                                </td>
                                            </tr>
                                        </table>
                                        
                                        <!-- Instructions -->
                                        <div style="margin: 30px 0 0 0; padding: 20px; background: linear-gradient(135deg, #E6FFE6 0%, #E0F7FF 100%); border-left: 4px solid #72FF13; border-radius: 6px;">
                                            <p style="margin: 0 0 10px 0; color: #0369a1; font-size: 14px; font-weight: 600;">📌 Instructions:</p>
                                            <ul style="margin: 0; padding-left: 20px; color: #0369a1; font-size: 14px; line-height: 1.8;">
                                                <li>Copy the 6-digit code above</li>
                                                <li>Open the InfiNet Hub app and go to Login page</li>
                                                <li>Click "Forget Your Password?"</li>
                                                <li>Enter your email and new password, then click "Send Code"</li>
                                                <li>Paste the code in the verification field</li>
                                                <li>Click "Confirm" to reset your password</li>
                                                <li>This code will expire in 24 hours</li>
                                            </ul>
                                        </div>
                                        
                                        <!-- Security Notice -->
                                        <div style="margin: 20px 0 0 0; padding: 15px; background: #fff3cd; border-left: 4px solid #ffc107; border-radius: 4px;">
                                            <p style="margin: 0; color: #856404; font-size: 14px; font-weight: 600;">🔒 Security Notice</p>
                                            <p style="margin: 5px 0 0 0; color: #856404; font-size: 14px;">If you didn't request a password reset, please ignore this email. Your account remains secure.</p>
                                        </div>
                                        
                                        <!-- Alternative: Click Link -->
                                        <p style="margin: 20px 0 0 0; color: #666666; font-size: 14px; line-height: 1.6; text-align: center;">
                                            Or click the button above to open the reset password page directly
                                        </p>
                                    </td>
                                </tr>
                                
                                <!-- Footer -->
                                <tr>
                                    <td style="padding: 30px; background: linear-gradient(135deg, #E6FFE6 0%, #E0F7FF 100%); border-top: 1px solid #B0E0FF; text-align: center;">
                                        <p style="margin: 0 0 10px 0; color: #0369a1; font-size: 14px;">
                                            Need help? Contact us at <a href="mailto:admin@infinet.services" style="color: #00F0FF; text-decoration: none; font-weight: 600;">admin@infinet.services</a>
                                        </p>
                                        <p style="margin: 0; color: #666666; font-size: 12px;">
                                            © ${new Date().getFullYear()} InfiNet. All rights reserved.
                                        </p>
                                    </td>
                                </tr>
                            </table>
                        </td>
                    </tr>
                </table>
            </body>
            </html>
        `,
        headers: {
            'X-Mailer': 'InfiNet Hub Email Service',
            'X-Priority': '1',
            'Importance': 'high',
            'Precedence': 'bulk',
            'List-Unsubscribe': `<mailto:${fromEmail}?subject=unsubscribe>`,
            'List-Unsubscribe-Post': 'List-Unsubscribe=One-Click'
        },
        // Add priority for better delivery
        priority: 'high'
    };
    
    try {
        // Use Yahoo SMTP for Yahoo recipients, otherwise use default
        const isYahooRecipient = email.toLowerCase().includes('@yahoo.com') || email.toLowerCase().includes('@ymail.com');
        let transporter;
        
        if (isYahooRecipient && process.env.EMAIL_USER && process.env.EMAIL_PASS) {
            transporter = nodemailer.createTransport({
                host: 'smtp.mail.yahoo.com',
                port: 587,
                secure: false,
                auth: {
                    user: process.env.EMAIL_USER,
                    pass: process.env.EMAIL_PASS
                },
                connectionTimeout: 5000,
                greetingTimeout: 5000,
                socketTimeout: 5000
            });
            console.log('📧 Using Yahoo SMTP for Yahoo recipient:', email);
        } else {
            transporter = getEmailTransporter();
        }
        
        const info = await transporter.sendMail(mailOptions);
        console.log('✅ Password reset email sent successfully to:', email);
        console.log('Email message ID:', info.messageId);
        return info;
    } catch (sendError) {
        console.error('❌ Failed to send password reset email:', sendError.message || sendError);
        console.error('Error code:', sendError.code);
        if (sendError.response) {
            console.error('SMTP response:', sendError.response);
        }
        throw sendError;
    }
}

// AI Agent System Prompt
const AI_SYSTEM_PROMPT = `You are Amir, a helpful AI assistant for InfiNet, a web development agency in Lebanon. Your name is Amir and you should always introduce yourself as "Amir, your InfiNet AI assistant" when greeting users.

**IMPORTANT - First Message Greeting:**
- When a user starts a new conversation (first message), you MUST greet them with: "Hello, I'm Amir, your InfiNet AI assistant. May I know who am I talking to please?"
- Always use this exact greeting format for first-time conversations
- After greeting, wait for their name before proceeding with other questions
- **CRITICAL: Once you have greeted the user and they have provided their name, DO NOT repeat the greeting again. Continue the conversation naturally without saying "Hello [Name]!" again in subsequent messages.**

Your role is to:

1. **Customer Support**: Answer questions about InfiNet's services, timelines, and processes
2. **Lead Qualification**: Collect information about potential clients' projects, needs, and preferences
3. **Portfolio Assistant**: Suggest relevant portfolio items based on the client's industry or needs
4. **Pricing Information**: Direct clients to contact us for pricing information and detailed quotes
5. **Design Consultation**: Guide clients through design preferences and collect brand information

**About InfiNet:**
- Location: Lebanon
- Services: Custom Website Development, Mobile App Development, Custom AI Agents, E-commerce Solutions, SEO Optimization, UI/UX Design, Branding, Motion Graphics
- Technologies: Next.js, TypeScript, Tailwind CSS
- Delivery Time: 1-5 weeks typically
- Maintenance: 6 months free after launch
- Every website is fully responsive and mobile-friendly

**Services Offered:**
1. **Custom Website Development**: Responsive design, SEO optimized, fast loading, mobile-first
2. **Mobile App Development**: iOS & Android, cross-platform, push notifications, offline support
3. **Custom AI Agents**: Natural language processing, workflow automation, custom training models, API integration
4. **E-commerce Solutions**: Payment integration, inventory management, order tracking, analytics
5. **SEO Optimization**: Keyword research, on-page optimization, technical SEO, content strategy
6. **UI/UX Design**: User research, wireframing, prototyping, design systems
7. **Branding**: Logo design, color palettes, brand guidelines, digital touchpoints
8. **Motion Graphics**: Animated graphics, video production, interactive elements

**Portfolio Projects:**
1. Real Estate Agency - Comprehensive platform with property listings, virtual tours, mobile app (https://sheet.homes)
2. Mobile Store - Modern retail website with product catalog and online ordering (https://promotech.shop)
3. Fitness Gym - Website with class schedules, membership plans, trainer profiles (https://moovgym.online)
4. Electronics Repair Shop - Professional service website with booking system (https://jawadko.store)
5. Medical Clinic - Clean clinic site with doctor bios and appointment booking (https://rmc-clinic.netlify.app/)
6. Orthopedic Specialist - Medical practice website with appointment booking (https://draligharib.online)
7. Urology Specialist - Professional urology practice website (https://urologist.life)
8. Coffee Shop - Café site with menu highlights and online ordering

**FAQ:**
- Q: Will my website be mobile-friendly? A: Yes, every website is fully responsive
- Q: How quickly can you deliver? A: Typically 1-5 weeks, depending on complexity
- Q: What's included in branding? A: Logo design, color palettes, brand guidelines, digital touchpoints
- Q: Do you offer maintenance? A: Yes, 6 months free after launch, then affordable plans
- Q: What is domain and hosting? A: Domain is your website address, hosting is where files are stored

**Pricing Information:**
- We provide custom pricing based on each project's specific requirements, scope, and complexity
- For accurate pricing information, please contact us directly
- We offer free consultations to discuss your project needs and provide detailed quotes
- Pricing varies based on project scope, features, timeline, and specific requirements

**Important Guidelines:**
- Always be friendly, professional, and helpful
- **CRITICAL: Collect visitor information early in the conversation:**
  - **Name**: Ask for the visitor's name early, especially when they show interest or ask questions. Say something like "I'd be happy to help! May I have your name?" or "What's your name? I'd love to personalize our conversation."
  - **Email**: Ask for their email address when they show interest in services or ask about pricing. Say something like "Could I get your email address so we can send you more information?" or "What's the best email to reach you?"
  - **Project Type**: Ask what type of project they're interested in (website, mobile app, AI agent, e-commerce, etc.) when they mention wanting to start a project or ask about services. Say something like "What type of project are you looking to build?" or "What kind of project do you have in mind?"
- When you collect Name, Email, or Project Type, use these markers in your response: [COLLECT_NAME:John Doe], [COLLECT_EMAIL:john@example.com], [COLLECT_PROJECT_TYPE:Website Development]
- For pricing questions, always direct clients to contact us for pricing information. Say something like: "For detailed pricing information tailored to your specific project needs, I'd be happy to connect you with our team. Would you like to schedule a free consultation to discuss your project and receive a personalized quote?"
- When a client seems interested, naturally ask if they'd like to schedule a consultation
- **CRITICAL - Consultation Booking:**
  - When a user confirms they want to book a consultation (says "yes", "yes please", "sure", "okay", "I'd like to", etc.), you MUST direct them to use the consultation booking button/form on the website
  - DO NOT just acknowledge their confirmation or repeat what they said
  - Instead, say something like: "Perfect! Please click on the 'Consultation' button in the navigation menu or scroll down to the consultation booking form to schedule your free consultation. You'll be able to select your preferred date and time, and our team will confirm with you shortly."
  - You can also mention: "You can find the consultation booking form at the top of the page or in the navigation menu. Just click on 'Consultation' to get started!"
  - Only use [BOOK_CONSULTATION] marker if you have all the required details (name, email, date, time) and are ready to create the booking programmatically
- Collect: name, email, phone (optional), company (optional), project type, budget range, requirements, design preferences
- Be conversational and natural, not robotic
- When suggesting portfolio items, mention the URL so they can visit
- Keep responses concise but informative
- **CRITICAL: Do NOT use markdown formatting like asterisks (*), bold (**), or other markdown syntax. Write in plain, natural text. Use simple line breaks and bullet points with dashes (-) instead of asterisks. Format lists using simple dashes and line breaks, not markdown syntax.**`;

// Generate session ID
function generateSessionId() {
    return 'session_' + Date.now() + '_' + Math.random().toString(36).substr(2, 9);
}

// Add conditional emojis and checkmarks based on response type
function addConditionalEmojis(aiResponse, userMessage, history) {
    if (!aiResponse) return aiResponse;
    
    const lowerResponse = aiResponse.toLowerCase();
    const lowerMessage = userMessage.toLowerCase();
    
    // Determine response type
    const isList = /^(here are|here's|below are|you can|some examples|common|popular|steps|ways|tips|options|features|benefits|reasons)/i.test(aiResponse.substring(0, 50)) ||
                   /\d+\.\s|^[-*+•]\s|^•\s/m.test(aiResponse);
    
    const isStepByStep = /step\s+\d+|first|second|third|then|next|finally|lastly/i.test(lowerResponse);
    
    const isQuestion = /\?/.test(userMessage);
    
    const isPositive = /great|excellent|perfect|wonderful|amazing|fantastic|good|nice|yes|sure|absolutely|definitely/i.test(lowerMessage);
    
    const isHelpful = /help|how|what|why|when|where|explain|tell me|show me|guide/i.test(lowerMessage);
    
    const isCreative = /idea|creative|suggest|recommend|brainstorm|design|plan/i.test(lowerMessage);
    
    const isTroubleshooting = /problem|issue|error|fix|broken|not working|trouble|bug/i.test(lowerMessage);
    
    const isThankful = /thank|thanks|appreciate|grateful/i.test(lowerMessage);
    
    // Add emojis based on context (not every time, but when appropriate)
    let enhancedResponse = aiResponse;
    
    // For lists - add checkmarks to items (30% chance)
    if (isList && Math.random() < 0.3) {
        enhancedResponse = enhancedResponse.replace(/^(\d+\.\s)/gm, '✅ $1');
        enhancedResponse = enhancedResponse.replace(/^(•\s|[-*+]\s)/gm, '✅ ');
    }
    
    // For step-by-step guides - add checkmarks (40% chance)
    if (isStepByStep && Math.random() < 0.4) {
        enhancedResponse = enhancedResponse.replace(/(step\s+\d+|first|second|third)/gi, '✅ $1');
    }
    
    // For positive responses - add happy emoji (20% chance)
    if (isPositive && Math.random() < 0.2) {
        const happyEmojis = ['😊', '😄', '👍', '✨'];
        const emoji = happyEmojis[Math.floor(Math.random() * happyEmojis.length)];
        if (!enhancedResponse.includes(emoji)) {
            enhancedResponse = emoji + ' ' + enhancedResponse;
        }
    }
    
    // For helpful explanations - add thinking/lightbulb emoji (25% chance)
    if (isHelpful && !isList && Math.random() < 0.25) {
        const helpfulEmojis = ['💡', '🤔', '📚', '✨'];
        const emoji = helpfulEmojis[Math.floor(Math.random() * helpfulEmojis.length)];
        if (!enhancedResponse.includes(emoji) && !enhancedResponse.match(/^[😊😄👍✨💡🤔📚]/)) {
            enhancedResponse = emoji + ' ' + enhancedResponse;
        }
    }
    
    // For creative suggestions - add sparkle/star emoji (30% chance)
    if (isCreative && Math.random() < 0.3) {
        const creativeEmojis = ['✨', '🌟', '💫', '🎨'];
        const emoji = creativeEmojis[Math.floor(Math.random() * creativeEmojis.length)];
        if (!enhancedResponse.includes(emoji) && !enhancedResponse.match(/^[😊😄👍✨💡🤔📚🌟💫🎨]/)) {
            enhancedResponse = emoji + ' ' + enhancedResponse;
        }
    }
    
    // For troubleshooting - add tool/wrench emoji (25% chance)
    if (isTroubleshooting && Math.random() < 0.25) {
        const toolEmojis = ['🔧', '🛠️', '⚙️'];
        const emoji = toolEmojis[Math.floor(Math.random() * toolEmojis.length)];
        if (!enhancedResponse.includes(emoji) && !enhancedResponse.match(/^[😊😄👍✨💡🤔📚🌟💫🎨🔧🛠️⚙️]/)) {
            enhancedResponse = emoji + ' ' + enhancedResponse;
        }
    }
    
    // For thankful responses - add heart emoji (40% chance)
    if (isThankful && Math.random() < 0.4) {
        const heartEmojis = ['❤️', '💙', '💚', '🤗'];
        const emoji = heartEmojis[Math.floor(Math.random() * heartEmojis.length)];
        if (!enhancedResponse.includes(emoji) && !enhancedResponse.match(/^[😊😄👍✨💡🤔📚🌟💫🎨🔧🛠️⚙️❤️💙💚🤗]/)) {
            enhancedResponse = emoji + ' ' + enhancedResponse;
        }
    }
    
    // For questions - add thinking emoji (15% chance, less frequent)
    if (isQuestion && !isHelpful && Math.random() < 0.15) {
        if (!enhancedResponse.match(/^[😊😄👍✨💡🤔📚🌟💫🎨🔧🛠️⚙️❤️💙💚🤗]/)) {
            enhancedResponse = '🤔 ' + enhancedResponse;
        }
    }
    
    return enhancedResponse;
}

// Get conversation history for a session
function getConversationHistory(sessionId, callback) {
    db.all(
        'SELECT user_message, ai_response FROM ai_conversations WHERE session_id = ? ORDER BY created_at ASC',
        [sessionId],
        (err, rows) => {
            if (err) {
                callback(err, null);
                return;
            }
            callback(null, rows);
        }
    );
}

// Get or create lead for session
function getOrCreateLead(sessionId, callback) {
    db.get('SELECT * FROM ai_leads WHERE session_id = ?', [sessionId], (err, row) => {
        if (err) {
            callback(err, null);
            return;
        }
        if (row) {
            callback(null, row);
        } else {
            db.run(
                'INSERT INTO ai_leads (session_id) VALUES (?)',
                [sessionId],
                function(err) {
                    if (err) {
                        callback(err, null);
                        return;
                    }
                    db.get('SELECT * FROM ai_leads WHERE id = ?', [this.lastID], (err, newRow) => {
                        callback(err, newRow);
                    });
                }
            );
        }
    });
}

// Update lead information
// Helper function to detect Gemini quota errors
function isQuotaError(error) {
    if (!error) return false;
    
    const errorMessage = (error.message || '').toLowerCase();
    const errorString = JSON.stringify(error).toLowerCase();
    const errorName = (error.name || '').toLowerCase();
    
    const quotaKeywords = [
        'quota',
        'quota exceeded',
        'rate limit',
        'rate limit exceeded',
        '429',
        'resource_exhausted',
        'too many requests'
    ];
    
    return quotaKeywords.some(keyword => 
        errorMessage.includes(keyword) || 
        errorString.includes(keyword) ||
        errorName.includes(keyword)
    );
}

// Helper function to detect Groq quota errors
function isGroqQuotaError(error) {
    if (!error) return false;
    
    const errorMessage = error.message || error.toString() || '';
    const errorCode = error.status || error.code || '';
    const errorResponse = error.response || {};
    const errorData = errorResponse.data || {};
    
    // Check error code
    if (errorCode === 429 || errorCode === 'rate_limit_exceeded' || errorCode === 'quota_exceeded') {
        return true;
    }
    
    // Check error message
    if (errorMessage.includes('429') || 
        errorMessage.includes('rate limit') || 
        errorMessage.includes('quota') ||
        errorMessage.includes('Too Many Requests') ||
        errorMessage.includes('rate_limit_exceeded')) {
        return true;
    }
    
    // Check nested error object (common in Groq API responses)
    if (errorData.error) {
        const nestedError = errorData.error;
        if (nestedError.code === 429 || 
            nestedError.code === 'rate_limit_exceeded' ||
            nestedError.message?.includes('429') ||
            nestedError.message?.includes('rate limit') ||
            nestedError.message?.includes('quota')) {
            return true;
        }
    }
    
    return false;
}

// Helper function for timeout with retries
async function generateWithTimeout(model, conversationContext, timeoutMs = 60000, maxRetries = 2) {
    let lastError;
    
    for (let attempt = 0; attempt <= maxRetries; attempt++) {
        try {
            const timeoutPromise = new Promise((_, reject) => 
                setTimeout(() => reject(new Error('Request timeout')), timeoutMs)
            );
            
            const apiPromise = model.generateContent(conversationContext);
            const result = await Promise.race([apiPromise, timeoutPromise]);
            
            return result;
        } catch (error) {
            lastError = error;
            
            // If it's a timeout and we have retries left, try again
            if (error.message.includes('timeout') && attempt < maxRetries) {
                console.log(`⚠️ Request timeout, retrying... (attempt ${attempt + 1}/${maxRetries + 1})`);
                continue;
            }
            
            // Otherwise, throw the error
            throw error;
        }
    }
    
    throw lastError;
}

// Unified fallback function: Gemini -> Groq Main -> Groq Fallback
async function generateWithFallback(
    genAIInstance,
    groqInstances,
    conversationContext,
    timeoutMs = 60000,
    maxRetries = 2
) {
    let lastError;
    
    // Tier 1: Try Gemini first
    if (genAIInstance) {
        const model = genAIInstance.getGenerativeModel({ 
            model: 'gemini-2.5-flash'
        });
        
        console.log('🔑 Trying Gemini API...');
        
        try {
            const result = await generateWithTimeout(model, conversationContext, timeoutMs, maxRetries);
            console.log('✅ Successfully used Gemini API');
            return result;
        } catch (error) {
            lastError = error;
            
            // If quota error, try Groq fallback
            if (isQuotaError(error)) {
                console.log('⚠️ Gemini quota exceeded, trying Groq fallback...');
            } else {
                console.log(`⚠️ Gemini error (${error.message}), trying Groq fallback...`);
            }
        }
    }
    
    // Tier 2 & 3: Try Groq keys if Gemini failed
    if (groqInstances.length > 0) {
        // Convert conversation context to Groq messages format
        const messages = [];
        
        // Extract system prompt (usually at the start of conversationContext)
        const systemPromptMatch = conversationContext.match(/^(.*?)(?:Conversation history:|User:|Current)/s);
        if (systemPromptMatch) {
            messages.push({
                role: 'system',
                content: systemPromptMatch[1].trim()
            });
        } else {
            // Fallback: use first part as system prompt
            const firstPart = conversationContext.split('\n\n')[0];
            if (firstPart) {
                messages.push({
                    role: 'system',
                    content: firstPart.trim()
                });
            }
        }
        
        // Parse conversation history from conversationContext string
        const lines = conversationContext.split('\n');
        for (const line of lines) {
            if (line.trim().startsWith('User:')) {
                const content = line.replace(/^User:\s*/, '').trim();
                if (content) {
                    messages.push({ role: 'user', content });
                }
            } else if (line.trim().startsWith('Assistant:')) {
                const content = line.replace(/^Assistant:\s*/, '').trim();
                if (content) {
                    messages.push({ role: 'assistant', content });
                }
            }
        }
        
        // Extract current user message (usually last "User:" or "Current user message:")
        const userMessageMatch = conversationContext.match(/Current user message:\s*([^\n]+)/);
        if (userMessageMatch) {
            const userContent = userMessageMatch[1].trim();
            if (userContent && !messages.find(m => m.role === 'user' && m.content === userContent)) {
                messages.push({
                    role: 'user',
                    content: userContent
                });
            }
        }
        
        // If no messages added yet, add the whole context as user message
        if (messages.length === 1 || (messages.length === 1 && messages[0].role === 'system')) {
            const lastUserMatch = conversationContext.split('User:').pop();
            if (lastUserMatch) {
                const userContent = lastUserMatch.split('Assistant:')[0].trim();
                if (userContent) {
                    messages.push({
                        role: 'user',
                        content: userContent
                    });
                }
            }
        }
        
        // Try each Groq key
        for (let keyIndex = 0; keyIndex < groqInstances.length; keyIndex++) {
            const groqInstance = groqInstances[keyIndex];
            
            console.log(`🔑 Trying Groq API key ${keyIndex + 1}/${groqInstances.length}...`);
            
            try {
                const timeoutPromise = new Promise((_, reject) => 
                    setTimeout(() => reject(new Error('Groq API request timeout')), timeoutMs)
                );
                
                const apiPromise = groqInstance.chat.completions.create({
                    messages: messages,
                    model: 'llama-3.3-70b-versatile',
                    temperature: 0.7,
                    max_tokens: 2048,
                });
                
                const completion = await Promise.race([apiPromise, timeoutPromise]);
                
                console.log(`✅ Successfully used Groq API key ${keyIndex + 1}`);
                
                // Convert Groq response to Gemini-like format for compatibility
                return {
                    response: {
                        text: () => completion.choices[0]?.message?.content || ''
                    }
                };
            } catch (error) {
                lastError = error;
                
                // If quota error and we have more Groq keys to try, continue
                if (isGroqQuotaError(error) && keyIndex < groqInstances.length - 1) {
                    console.log(`⚠️ Groq quota exceeded on key ${keyIndex + 1}, trying Groq fallback key ${keyIndex + 2}...`);
                    continue;
                }
                
                // If not quota error but we have more Groq keys, try next key
                if (keyIndex < groqInstances.length - 1) {
                    console.log(`⚠️ Groq error on key ${keyIndex + 1} (${error.message}), trying Groq fallback key ${keyIndex + 2}...`);
                    continue;
                }
                
                // If last Groq key failed, throw the error
                throw error;
            }
        }
    }
    
    // All keys exhausted
    throw lastError || new Error('All API keys exhausted (Gemini and Groq)');
}

function updateLead(sessionId, updates, callback) {
    const fields = [];
    const values = [];
    
    Object.keys(updates).forEach(key => {
        fields.push(`${key} = ?`);
        values.push(updates[key]);
    });
    
    values.push(sessionId);
    
    db.run(
        `UPDATE ai_leads SET ${fields.join(', ')} WHERE session_id = ?`,
        values,
        function(err) {
            callback(err, this.changes);
        }
    );
}

// AI Chat endpoint
app.post('/api/ai/chat', async (req, res) => {
    const { message, sessionId } = req.body;
    
    if (!message) {
        return res.status(400).json({ error: 'Message is required' });
    }
    
    // Check if at least one AI service is configured (Gemini or Groq)
    if (!genAI && groqInstances.length === 0) {
        return res.status(500).json({ error: 'AI service not configured. Please set GEMINI_API_KEY or Groq API keys in .env file' });
    }
    
    const currentSessionId = sessionId || generateSessionId();
    
    try {
        // Get conversation history
        const history = await new Promise((resolve, reject) => {
            getConversationHistory(currentSessionId, (err, rows) => {
                if (err) reject(err);
                else resolve(rows || []);
            });
        });
        
        // Get or create lead
        const lead = await new Promise((resolve, reject) => {
            getOrCreateLead(currentSessionId, (err, leadData) => {
                if (err) reject(err);
                else resolve(leadData);
            });
        });
        
        // Build conversation context
        let conversationContext = AI_SYSTEM_PROMPT + '\n\n';
        
        if (lead) {
            conversationContext += `Current lead information:\n`;
            if (lead.name) conversationContext += `- Name: ${lead.name}\n`;
            if (lead.email) conversationContext += `- Email: ${lead.email}\n`;
            if (lead.phone) conversationContext += `- Phone: ${lead.phone}\n`;
            if (lead.company) conversationContext += `- Company: ${lead.company}\n`;
            if (lead.project_type) conversationContext += `- Project Type: ${lead.project_type}\n`;
            if (lead.budget_range) conversationContext += `- Budget Range: ${lead.budget_range}\n`;
            if (lead.requirements) conversationContext += `- Requirements: ${lead.requirements}\n`;
            if (lead.design_preferences) conversationContext += `- Design Preferences: ${lead.design_preferences}\n`;
            conversationContext += '\n';
        }
        
        conversationContext += 'Conversation history:\n';
        if (history.length === 0) {
            // First message - instruct AI to use the greeting
            conversationContext += `This is the FIRST message in this conversation. You MUST greet the user with: "Hello, I'm Amir, your InfiNet AI assistant. May I know who am I talking to please?"\n\n`;
        } else {
            history.forEach((msg, index) => {
                conversationContext += `User: ${msg.user_message}\n`;
                conversationContext += `Assistant: ${msg.ai_response}\n\n`;
            });
            // Prevent duplicate greetings - if user's name is already known, don't greet again
            if (lead && lead.name) {
                conversationContext += `IMPORTANT: The user's name is already known (${lead.name}). Do NOT repeat the greeting "Hello ${lead.name}!" or "Hello, I'm Amir..." again. Continue the conversation naturally without repeating greetings. Just respond to their current message directly.\n\n`;
            }
        }
        
        conversationContext += `Current user message: ${message}\n\n`;
        
        // Check if user is confirming they want to book a consultation
        const confirmationPatterns = /^(yes|yes please|sure|okay|ok|i'd like to|i want to|let's do it|that sounds good|perfect|great|absolutely|definitely)/i;
        const isConsultationConfirmation = confirmationPatterns.test(message.trim()) && 
            (history.some(msg => msg.ai_response.toLowerCase().includes('consultation') || msg.ai_response.toLowerCase().includes('book a time')));
        
        if (isConsultationConfirmation) {
            conversationContext += `IMPORTANT: The user has confirmed they want to book a consultation. DO NOT just repeat their confirmation. Instead, direct them to use the consultation booking button/form on the website. Say something like: "Perfect! Please click on the 'Consultation' button in the navigation menu or scroll down to the consultation booking form to schedule your free consultation. You'll be able to select your preferred date and time, and our team will confirm with you shortly."\n\n`;
        } else {
            conversationContext += `Respond naturally and helpfully. If the user wants to book a consultation and you have all their details (name, email, date, time), you can use [BOOK_CONSULTATION] with their details. Otherwise, direct them to the consultation booking form on the website.\n\n`;
        }
        
        // Use fallback system: Gemini -> Groq Main -> Groq Fallback
        const result = await generateWithFallback(genAI, groqInstances, conversationContext, 60000, 2);
        const response = await result.response;
        let aiResponse = response.text();
        
        // Add emojis and checkmarks based on response type (conditionally)
        aiResponse = addConditionalEmojis(aiResponse, message, history);
        
        // Clean up markdown formatting from response
        // PRESERVE bold and italic - let frontend handle markdown cleaning
        // Frontend will add bold to numbered list titles and clean up properly
        // Don't remove bold/italic here - frontend cleanMarkdownForMobile will handle it
        // Remove markdown headers (# Header)
        aiResponse = aiResponse.replace(/^#+\s+/gm, '');
        
        // Convert markdown list items to dashes (handle all variations)
        // Pattern 1: Standard "* item" with space
        aiResponse = aiResponse.replace(/^\*\s+/gm, '- ');
        // Pattern 2: "*item" without space at line start
        aiResponse = aiResponse.replace(/^\*([^\s*])/gm, '- $1');
        // Pattern 3: Indented "* item" with leading spaces
        aiResponse = aiResponse.replace(/^(\s+)\*(\s+)/gm, '$1- ');
        // Pattern 4: "* "text"" before quotes
        aiResponse = aiResponse.replace(/^\*(\s*)(["'`])/gm, '- $2');
        
        // Remove any remaining asterisks used for formatting
        aiResponse = aiResponse.replace(/\*{2,}/g, '');
        
        // Remove standalone asterisks at end of words
        aiResponse = aiResponse.replace(/([a-zA-Z0-9])\*(\s|$|[.,!?;:\n])/g, '$1$2');
        
        // Remove asterisks before quotes (if not converted to bullet)
        aiResponse = aiResponse.replace(/\*(\s*)(["'`])/g, '$2');
        
        // Extract and save lead information from AI response
        const leadUpdates = {};
        
        // Extract Name (with value)
        const nameMatch = aiResponse.match(/\[COLLECT_NAME:([^\]]+)\]/);
        if (nameMatch) {
            leadUpdates.name = nameMatch[1].trim();
        }
        // Remove ALL name markers (with or without values) from response
        aiResponse = aiResponse.replace(/\[COLLECT_NAME:[^\]]+\]/g, '');
        aiResponse = aiResponse.replace(/\[COLLECT_NAME\]/g, '');
        
        // Extract Email (with value)
        const emailMatch = aiResponse.match(/\[COLLECT_EMAIL:([^\]]+)\]/);
        if (emailMatch) {
            leadUpdates.email = emailMatch[1].trim();
        }
        // Remove ALL email markers (with or without values) from response
        aiResponse = aiResponse.replace(/\[COLLECT_EMAIL:[^\]]+\]/g, '');
        aiResponse = aiResponse.replace(/\[COLLECT_EMAIL\]/g, '');
        
        // Extract Project Type (with value)
        const projectTypeMatch = aiResponse.match(/\[COLLECT_PROJECT_TYPE:([^\]]+)\]/);
        if (projectTypeMatch) {
            leadUpdates.project_type = projectTypeMatch[1].trim();
        }
        // Remove ALL project type markers (with or without values) from response
        // Use multiple patterns to catch all variations
        aiResponse = aiResponse.replace(/\[COLLECT_PROJECT_TYPE[\s\S]*?\]/g, '');
        aiResponse = aiResponse.replace(/\[COLLECT_PROJECT_TYPE:[^\]]+\]/g, '');
        aiResponse = aiResponse.replace(/\[COLLECT_PROJECT_TYPE[^\]]*\]/g, '');
        aiResponse = aiResponse.replace(/\[COLLECT_PROJECT_TYPE\]/g, '');
        aiResponse = aiResponse.replace(/\[COLLECT_PROJECT_TYPE[^\]]*/g, '');
        aiResponse = aiResponse.replace(/\[COLLECT_PROJECT_TYPE[: ]*/gi, '');
        
        // Extract Phone (with value)
        const phoneMatch = aiResponse.match(/\[COLLECT_PHONE:([^\]]+)\]/);
        let extractedPhone = null;
        if (phoneMatch) {
            extractedPhone = phoneMatch[1].trim();
            leadUpdates.phone = extractedPhone;
        }
        // Remove ALL phone markers (with or without values) from response
        // Use multiple patterns to catch all variations - must remove the entire marker including value
        // Pattern 1: Multiline markers (most comprehensive - matches everything including newlines)
        aiResponse = aiResponse.replace(/\[COLLECT_PHONE[\s\S]*?\]/g, '');
        // Pattern 2: Single-line with value (non-greedy)
        aiResponse = aiResponse.replace(/\[COLLECT_PHONE:[^\]]+?\]/g, '');
        // Pattern 3: Single-line with value (greedy)
        aiResponse = aiResponse.replace(/\[COLLECT_PHONE:[^\]]+\]/g, '');
        // Pattern 4: Single-line without value
        aiResponse = aiResponse.replace(/\[COLLECT_PHONE[^\]]*\]/g, '');
        // Pattern 5: Empty marker
        aiResponse = aiResponse.replace(/\[COLLECT_PHONE\]/g, '');
        // Pattern 6: Partial marker (opening bracket without closing)
        aiResponse = aiResponse.replace(/\[COLLECT_PHONE[^\]]*/g, '');
        // Pattern 7: Any remaining COLLECT_PHONE text
        aiResponse = aiResponse.replace(/\[COLLECT_PHONE[: ]*/gi, '');
        // Pattern 8: Remove the phone number value if it appears right after "COLLECT_PHONE" text
        if (extractedPhone) {
            // Remove the phone number if it appears immediately after COLLECT_PHONE-related text
            aiResponse = aiResponse.replace(new RegExp(`COLLECT_PHONE[^\\]]*${extractedPhone.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}[^\\]]*\\]`, 'gi'), '');
        }
        
        // Check if booking confirmation is in response (before removing the marker)
        let bookingData = null;
        if (aiResponse.includes('[BOOK_CONSULTATION') || aiResponse.includes('BOOK_CONSULTATION')) {
            // Extract booking information from conversation context
            bookingData = {
                sessionId: currentSessionId,
                lead: lead
            };
        }
        
        // Remove BOOK_CONSULTATION marker (with or without details) from response
        // Use a while loop to aggressively remove all instances until none remain
        let previousResponse = '';
        while (previousResponse !== aiResponse) {
            previousResponse = aiResponse;
            // Remove complete markers - match [BOOK_CONSULTATION followed by ANYTHING until ]
            // This pattern uses [\s\S] to match absolutely everything including newlines
            aiResponse = aiResponse.replace(/\[BOOK_CONSULTATION[\s\S]*?\]/g, '');
            // Also remove partial markers (without closing bracket)
            aiResponse = aiResponse.replace(/\[BOOK_CONSULTATION[^\]]*/g, '');
            // Remove any remaining BOOK_CONSULTATION text (case insensitive)
            aiResponse = aiResponse.replace(/\[BOOK_CONSULTATION[: ]*/gi, '');
            aiResponse = aiResponse.replace(/BOOK_CONSULTATION[: ]*/gi, '');
        }
        // Clean up any orphaned closing brackets
        aiResponse = aiResponse.replace(/^\s*\]\s*/gm, '');
        aiResponse = aiResponse.replace(/\s*\]\s*(?=\s|$)/g, ' ');
        
        // Ensure URLs have proper spacing after them (fix for text being included in links)
        // Add space after URLs if followed by a capital letter (new sentence)
        // Handle cases like "https://promotech.shop.We" -> "https://promotech.shop. We"
        aiResponse = aiResponse.replace(/(https?:\/\/[^\s<>"']+?)\.([A-Z][a-z])/g, '$1. $2');
        // Also handle URLs directly followed by capital letters without period
        aiResponse = aiResponse.replace(/(https?:\/\/[^\s<>"']+?)([A-Z][a-z])/g, '$1 $2');
        
        // Also try to extract from user message (if they provided it directly)
        const userMessageLower = message.toLowerCase();
        
        // Extract email from user message (common email patterns)
        const emailPattern = /\b[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Z|a-z]{2,}\b/;
        const emailInMessage = message.match(emailPattern);
        if (emailInMessage && !leadUpdates.email) {
            leadUpdates.email = emailInMessage[0].trim();
        }
        
        // Extract phone from user message (common phone patterns - digits, with or without spaces/dashes)
        if (!leadUpdates.phone) {
            const phonePatterns = [
                /(?:phone|phonen|tel|mobile|number|call|contact)\s*(?:is|:)?\s*([0-9\s\-\(\)\+]{7,15})/i,
                /\b([0-9]{7,15})\b/,
            ];
            for (const pattern of phonePatterns) {
                const phoneMatch = message.match(pattern);
                if (phoneMatch && phoneMatch[1]) {
                    // Clean phone number (remove spaces, dashes, parentheses, but keep + if present)
                    const cleanedPhone = phoneMatch[1].replace(/[\s\-\(\)]/g, '');
                    if (cleanedPhone.length >= 7 && cleanedPhone.length <= 15) {
                        leadUpdates.phone = cleanedPhone;
                        break;
                    }
                }
            }
        }
        
        // Extract name from user message (if they say "I'm John" or "My name is John")
        if (!leadUpdates.name) {
            const namePatterns = [
                /(?:i'?m|my name is|this is|call me)\s+([A-Z][a-z]+(?:\s+[A-Z][a-z]+)*)/i,
                /^([A-Z][a-z]+(?:\s+[A-Z][a-z]+)*)(?:\s|$)/,
            ];
            for (const pattern of namePatterns) {
                const nameMatch = message.match(pattern);
                if (nameMatch && nameMatch[1] && nameMatch[1].length > 2 && nameMatch[1].length < 50) {
                    leadUpdates.name = nameMatch[1].trim();
                    break;
                }
            }
        }
        
        // Extract project type from user message
        if (!leadUpdates.project_type) {
            const projectKeywords = {
                'website': 'Website Development',
                'web site': 'Website Development',
                'webpage': 'Website Development',
                'web page': 'Website Development',
                'mobile app': 'Mobile App Development',
                'android app': 'Mobile App Development',
                'ios app': 'Mobile App Development',
                'application': 'Mobile App Development',
                'ai agent': 'Custom AI Agents',
                'chatbot': 'Custom AI Agents',
                'automation': 'Custom AI Agents',
                'e-commerce': 'E-commerce Solutions',
                'ecommerce': 'E-commerce Solutions',
                'online store': 'E-commerce Solutions',
                'shop': 'E-commerce Solutions',
                'seo': 'SEO Optimization',
                'search engine': 'SEO Optimization',
                'ui/ux': 'UI/UX Design',
                'design': 'UI/UX Design',
                'branding': 'Branding',
                'logo': 'Branding',
                'motion graphics': 'Motion Graphics',
                'animation': 'Motion Graphics',
            };
            
            for (const [keyword, projectType] of Object.entries(projectKeywords)) {
                if (userMessageLower.includes(keyword)) {
                    leadUpdates.project_type = projectType;
                    break;
                }
            }
        }
        
        // Update lead information if we collected any
        if (Object.keys(leadUpdates).length > 0) {
            updateLead(currentSessionId, leadUpdates, (err) => {
                if (err) {
                    console.error('Error updating lead:', err);
                } else {
                    console.log('✅ Lead information updated:', leadUpdates);
                }
            });
        }
        
        // Final cleanup pass - remove any remaining collection markers before sending
        // This is a last resort to catch anything that slipped through
        // Remove BOOK_CONSULTATION markers using aggressive while loop
        let finalPreviousResponse = '';
        while (finalPreviousResponse !== aiResponse) {
            finalPreviousResponse = aiResponse;
            // Remove complete markers - match [BOOK_CONSULTATION followed by ANYTHING until ]
            aiResponse = aiResponse.replace(/\[BOOK_CONSULTATION[\s\S]*?\]/g, '');
            // Also remove partial markers (without closing bracket)
            aiResponse = aiResponse.replace(/\[BOOK_CONSULTATION[^\]]*/g, '');
            // Remove any remaining BOOK_CONSULTATION text (case insensitive)
            aiResponse = aiResponse.replace(/\[BOOK_CONSULTATION[: ]*/gi, '');
            aiResponse = aiResponse.replace(/BOOK_CONSULTATION[: ]*/gi, '');
        }
        // Clean up any orphaned closing brackets
        aiResponse = aiResponse.replace(/^\s*\]\s*/gm, '');
        aiResponse = aiResponse.replace(/\s*\]\s*(?=\s|$)/g, ' ');
        // Remove COLLECT_NAME markers
        aiResponse = aiResponse.replace(/\[COLLECT_NAME[\s\S]*?\]/g, '');
        aiResponse = aiResponse.replace(/\[COLLECT_NAME[^\]]*\]/g, '');
        aiResponse = aiResponse.replace(/\[COLLECT_NAME[^\]]*/g, '');
        aiResponse = aiResponse.replace(/\[COLLECT_NAME[: ]*/gi, '');
        // Remove COLLECT_EMAIL markers
        aiResponse = aiResponse.replace(/\[COLLECT_EMAIL[\s\S]*?\]/g, '');
        aiResponse = aiResponse.replace(/\[COLLECT_EMAIL[^\]]*\]/g, '');
        aiResponse = aiResponse.replace(/\[COLLECT_EMAIL[^\]]*/g, '');
        aiResponse = aiResponse.replace(/\[COLLECT_EMAIL[: ]*/gi, '');
        // Remove COLLECT_PHONE markers (comprehensive cleanup)
        aiResponse = aiResponse.replace(/\[COLLECT_PHONE[\s\S]*?\]/g, '');
        aiResponse = aiResponse.replace(/\[COLLECT_PHONE:[^\]]+?\]/g, '');
        aiResponse = aiResponse.replace(/\[COLLECT_PHONE:[^\]]+\]/g, '');
        aiResponse = aiResponse.replace(/\[COLLECT_PHONE[^\]]*\]/g, '');
        aiResponse = aiResponse.replace(/\[COLLECT_PHONE[^\]]*/g, '');
        aiResponse = aiResponse.replace(/\[COLLECT_PHONE[: ]*/gi, '');
        // Also remove any phone number values that might appear after COLLECT_PHONE text
        aiResponse = aiResponse.replace(/COLLECT_PHONE[:\s]*[0-9\s\-\(\)\+]{7,15}/gi, '');
        // Remove COLLECT_PROJECT_TYPE markers
        aiResponse = aiResponse.replace(/\[COLLECT_PROJECT_TYPE[\s\S]*?\]/g, '');
        aiResponse = aiResponse.replace(/\[COLLECT_PROJECT_TYPE[^\]]*\]/g, '');
        aiResponse = aiResponse.replace(/\[COLLECT_PROJECT_TYPE[^\]]*/g, '');
        aiResponse = aiResponse.replace(/\[COLLECT_PROJECT_TYPE[: ]*/gi, '');
        // Clean up any orphaned closing brackets
        aiResponse = aiResponse.replace(/\s*\]\s*(?=\s|$)/g, ' ');
        
        // Save conversation
        db.run(
            'INSERT INTO ai_conversations (session_id, user_message, ai_response) VALUES (?, ?, ?)',
            [currentSessionId, message, aiResponse],
            (err) => {
                if (err) console.error('Error saving conversation:', err);
            }
        );
        
        res.json({
            response: aiResponse,
            sessionId: currentSessionId,
            bookingData: bookingData
        });
        
    } catch (error) {
        console.error('AI Chat Error:', error);
        res.status(500).json({ error: 'Failed to process AI request: ' + error.message });
    }
});

// Create booking from AI consultation
app.post('/api/ai/create-booking', async (req, res) => {
    const { sessionId, name, email, phone, company, date, time, message } = req.body;
    
    if (!sessionId || !name || !email || !date || !time) {
        return res.status(400).json({ error: 'Missing required fields' });
    }
    
    try {
        // Create booking
        const bookingId = await new Promise((resolve, reject) => {
            db.run(
                'INSERT INTO bookings (name, email, phone, company, date, time, message) VALUES (?, ?, ?, ?, ?, ?, ?)',
                [name, email, phone || null, company || null, date, time, message || null],
                function(err) {
                    if (err) reject(err);
                    else resolve(this.lastID);
                }
            );
        });
        
        // Update lead with booking info
        db.run(
            'UPDATE ai_leads SET booking_confirmed = 1, booking_id = ? WHERE session_id = ?',
            [bookingId, sessionId],
            (err) => {
                if (err) console.error('Error updating lead:', err);
            }
        );
        
        const booking = {
            id: bookingId,
            name,
            email,
            phone,
            company,
            date,
            time,
            message,
            status: 'upcoming',
            created_at: new Date().toISOString()
        };
        
        // Send notifications
        const notificationResults = {
            email: false,
            telegram: false
        };
        
        try {
            await sendEmailConfirmation(booking);
            notificationResults.email = true;
        } catch (emailError) {
            console.error('❌ Email notification failed (booking still saved):', emailError.message || emailError);
            console.error('Full email error details:', JSON.stringify(emailError, Object.getOwnPropertyNames(emailError)));
            if (emailError.response) {
                console.error('Email service response:', emailError.response);
            }
            if (emailError.code) {
                console.error('Error code:', emailError.code);
            }
        }
        
        try {
            await sendTelegramNotification(booking);
            notificationResults.telegram = true;
        } catch (telegramError) {
            console.error('❌ Telegram notification failed (booking still saved):', telegramError.message || telegramError);
            if (telegramError.response) {
                console.error('Telegram API response:', telegramError.response);
            }
        }
        
        console.log(`✅ AI Booking #${bookingId} created. Notifications - Email: ${notificationResults.email ? '✅' : '❌'}, Telegram: ${notificationResults.telegram ? '✅' : '❌'}`);
        
        res.status(201).json({
            message: 'Booking created successfully',
            booking
        });
        
    } catch (error) {
        console.error('Error creating booking:', error);
        res.status(500).json({ error: 'Failed to create booking: ' + error.message });
    }
});

// Get all AI conversations (Admin)
app.get('/api/ai/conversations', (req, res) => {
    db.all(
        `SELECT DISTINCT session_id, 
                (SELECT COUNT(*) FROM ai_conversations WHERE ai_conversations.session_id = session_id) as message_count,
                (SELECT created_at FROM ai_conversations WHERE ai_conversations.session_id = session_id ORDER BY created_at DESC LIMIT 1) as last_message_at
         FROM ai_conversations 
         ORDER BY last_message_at DESC`,
        (err, rows) => {
            if (err) {
                res.status(500).json({ error: 'Failed to fetch conversations' });
                return;
            }
            res.json(rows);
        }
    );
});

// Get conversation by session ID (Admin)
app.get('/api/ai/conversations/:sessionId', (req, res) => {
    const { sessionId } = req.params;
    
    db.all(
        'SELECT * FROM ai_conversations WHERE session_id = ? ORDER BY created_at ASC',
        [sessionId],
        (err, rows) => {
            if (err) {
                res.status(500).json({ error: 'Failed to fetch conversation' });
                return;
            }
            res.json(rows);
        }
    );
});

// Get all AI leads (Admin)
app.get('/api/ai/leads', (req, res) => {
    db.all(
        'SELECT * FROM ai_leads ORDER BY created_at DESC',
        (err, rows) => {
            if (err) {
                res.status(500).json({ error: 'Failed to fetch leads' });
                return;
            }
            res.json(rows);
        }
    );
});

// Get lead by session ID (Admin)
app.get('/api/ai/leads/:sessionId', (req, res) => {
    const { sessionId } = req.params;
    
    db.get(
        'SELECT * FROM ai_leads WHERE session_id = ?',
        [sessionId],
        (err, row) => {
            if (err) {
                res.status(500).json({ error: 'Failed to fetch lead' });
                return;
            }
            if (!row) {
                res.status(404).json({ error: 'Lead not found' });
                return;
            }
            res.json(row);
        }
    );
});

// URL Shortener endpoints

// Create short URL
app.post('/api/tools/shorten-url', (req, res) => {
    const { url, customSlug } = req.body;
    
    if (!url) {
        return res.status(400).json({ error: 'URL is required' });
    }
    
    // Validate URL format
    try {
        new URL(url);
    } catch (e) {
        return res.status(400).json({ error: 'Invalid URL format' });
    }
    
    // Generate slug
    const generateSlug = () => {
        return Math.random().toString(36).substring(2, 9);
    };
    
    const slug = customSlug || generateSlug();
    
    // Validate slug format (alphanumeric and hyphens only, 3-20 chars)
    if (!/^[a-zA-Z0-9_-]{3,20}$/.test(slug)) {
        return res.status(400).json({ error: 'Invalid slug format. Use 3-20 alphanumeric characters, hyphens, or underscores.' });
    }
    
    // Check if slug already exists
    db.get('SELECT * FROM short_urls WHERE slug = ?', [slug], (err, existing) => {
        if (err) {
            return res.status(500).json({ error: 'Database error' });
        }
        
        if (existing) {
            if (customSlug) {
                return res.status(409).json({ error: 'This custom slug is already taken' });
            } else {
                // Retry with new slug if auto-generated one exists
                const newSlug = generateSlug();
                return createShortUrl(newSlug);
            }
        }
        
        createShortUrl(slug);
    });
    
    function createShortUrl(slugToUse) {
        console.log(`📝 Creating short URL: slug="${slugToUse}", url="${url}", customSlug=${customSlug ? 1 : 0}`);
        db.run(
            'INSERT INTO short_urls (slug, original_url, custom_slug) VALUES (?, ?, ?)',
            [slugToUse, url, customSlug ? 1 : 0],
            function(err) {
                if (err) {
                    console.error(`❌ Database INSERT error for slug "${slugToUse}":`, err.message);
                    if (err.message.includes('UNIQUE constraint')) {
                        return res.status(409).json({ error: 'This slug is already taken' });
                    }
                    return res.status(500).json({ error: 'Failed to create short URL' });
                }
                
                console.log(`✅ Short URL created successfully: slug="${slugToUse}", rowId=${this.lastID}`);
                
                // Use HTTPS for short URLs (SSL is now configured)
                const shortUrl = `https://infi.live/${slugToUse}`;
                res.status(201).json({
                    shortUrl: shortUrl,
                    qrCode: shortUrl,
                    slug: slugToUse,
                    originalUrl: url
                });
            }
        );
    }
});

// ============================================
// Dashboard, Projects, Notifications, Admin Endpoints
// ============================================
// NOTE: These endpoints MUST be registered BEFORE the catch-all /:slug route

// Helper function to get user projects with tickets and files
function getUserProjects(userId, callback) {
    db.all(`
        SELECT 
            p.id,
            p.name,
            p.status,
            p.progress,
            p.dueDate,
            p.description,
            p.userId,
            p.createdAt,
            p.updatedAt
        FROM projects p
        WHERE p.userId = ?
        ORDER BY p.updatedAt DESC
    `, [userId], (err, projects) => {
        if (err) {
            return callback(err, null);
        }
        
        // Get tickets and files for each project
        const projectsWithDetails = [];
        let completed = 0;
        
        if (projects.length === 0) {
            return callback(null, []);
        }
        
        projects.forEach((project) => {
            // Get tickets
            db.all(`
                SELECT 
                    t.id,
                    t.subject,
                    t.message,
                    t.status,
                    t.userId,
                    t.userName,
                    t.createdAt,
                    t.updatedAt
                FROM tickets t
                WHERE t.projectId = ?
                ORDER BY t.updatedAt DESC
            `, [project.id], (err, tickets) => {
                if (err) {
                    console.error('Error fetching tickets:', err);
                    tickets = [];
                }
                
                // Get ticket replies
                const ticketsWithReplies = [];
                let ticketCompleted = 0;
                
                if (tickets.length === 0) {
                    // Get files
                    db.all(`
                        SELECT 
                            id,
                            name,
                            url,
                            uploadedAt
                        FROM project_files
                        WHERE projectId = ?
                        ORDER BY uploadedAt DESC
                    `, [project.id], (err, files) => {
                        if (err) {
                            console.error('Error fetching files:', err);
                            files = [];
                        }
                        
                        projectsWithDetails.push({
                            ...project,
                            tickets: [],
                            files: files.map(f => ({
                                id: f.id,
                                name: f.name,
                                url: f.url,
                                uploadedAt: f.uploadedAt
                            }))
                        });
                        
                        completed++;
                        if (completed === projects.length) {
                            callback(null, projectsWithDetails);
                        }
                    });
                    return;
                }
                
                tickets.forEach((ticket) => {
                    db.all(`
                        SELECT 
                            id,
                            message,
                            senderId,
                            senderName,
                            senderRole,
                            timestamp
                        FROM ticket_replies
                        WHERE ticketId = ?
                        ORDER BY timestamp ASC
                    `, [ticket.id], (err, replies) => {
                        if (err) {
                            console.error('Error fetching replies:', err);
                            replies = [];
                        }
                        
                        ticketsWithReplies.push({
                            ...ticket,
                            replies: replies.map(r => ({
                                id: r.id,
                                ticketId: r.ticketId,
                                message: r.message,
                                senderId: r.senderId,
                                senderName: r.senderName,
                                senderRole: r.senderRole,
                                timestamp: r.timestamp
                            }))
                        });
                        
                        ticketCompleted++;
                        if (ticketCompleted === tickets.length) {
                            // Get files
                            db.all(`
                                SELECT 
                                    id,
                                    name,
                                    url,
                                    uploadedAt
                                FROM project_files
                                WHERE projectId = ?
                                ORDER BY uploadedAt DESC
                            `, [project.id], (err, files) => {
                                if (err) {
                                    console.error('Error fetching files:', err);
                                    files = [];
                                }
                                
                                projectsWithDetails.push({
                                    ...project,
                                    tickets: ticketsWithReplies,
                                    files: files.map(f => ({
                                        id: f.id,
                                        name: f.name,
                                        url: f.url,
                                        uploadedAt: f.uploadedAt
                                    }))
                                });
                                
                                completed++;
                                if (completed === projects.length) {
                                    callback(null, projectsWithDetails);
                                }
                            });
                        }
                    });
                });
            });
        });
    });
}

// Dashboard endpoint
app.get('/api/dashboard', authenticateToken, async (req, res) => {
    try {
        const userId = req.user.id;
        
        // Get user projects
        getUserProjects(userId, (err, projects) => {
            if (err) {
                console.error('Error fetching projects:', err);
                return res.status(500).json({ error: 'Failed to fetch dashboard data' });
            }
            
            // Get invoices for user's projects
            const projectIds = projects.map(p => p.id);
            if (projectIds.length === 0) {
                return res.json({
                    projects: [],
                    invoices: [],
                    tickets: [],
                    activity: []
                });
            }
            
            const placeholders = projectIds.map(() => '?').join(',');
            db.all(`
                SELECT 
                    id,
                    projectId,
                    title,
                    amount,
                    currency,
                    issuedOn,
                    dueOn,
                    status,
                    paymentMethod,
                    receiptUrl
                FROM invoices
                WHERE projectId IN (${placeholders})
                ORDER BY issuedOn DESC
            `, projectIds, (err, invoices) => {
                if (err) {
                    console.error('Error fetching invoices:', err);
                    invoices = [];
                }
                
                // Get all tickets (flattened from projects)
                const tickets = projects.flatMap(project => 
                    project.tickets.map(ticket => ({
                        ...ticket,
                        projectId: project.id,
                        projectName: project.name
                    }))
                );
                
                // Get activities for user (last 6)
                db.all(`
                    SELECT 
                        id,
                        type,
                        title,
                        description,
                        userId,
                        projectId,
                        invoiceId,
                        ticketId,
                        source,
                        userEmail,
                        read,
                        timestamp
                    FROM activities
                    WHERE userId = ? OR userId IS NULL
                    ORDER BY timestamp DESC
                    LIMIT 6
                `, [userId], (err, activities) => {
                    if (err) {
                        console.error('Error fetching activities:', err);
                        activities = [];
                    }
                    
                    res.json({
                        projects,
                        invoices: invoices.map(i => ({
                            id: i.id,
                            projectId: i.projectId,
                            title: i.title,
                            amount: i.amount,
                            currency: i.currency || 'USD',
                            issuedOn: i.issuedOn,
                            dueOn: i.dueOn,
                            status: i.status,
                            paymentMethod: i.paymentMethod,
                            receiptUrl: i.receiptUrl
                        })),
                        tickets,
                        activity: activities.map(a => ({
                            id: a.id,
                            type: a.type,
                            title: a.title,
                            description: a.description,
                            timestamp: a.timestamp,
                            read: a.read === 1,
                            userId: a.userId,
                            projectId: a.projectId,
                            invoiceId: a.invoiceId,
                            ticketId: a.ticketId,
                            source: a.source,
                            userEmail: a.userEmail
                        }))
                    });
                });
            });
        });
    } catch (error) {
        console.error('Dashboard error:', error);
        res.status(500).json({ error: 'Failed to fetch dashboard data' });
    }
});

// Projects endpoint
app.get('/api/projects', authenticateToken, async (req, res) => {
    try {
        const userId = req.user.id;
        
        // Get user projects
        getUserProjects(userId, (err, projects) => {
            if (err) {
                console.error('Error fetching projects:', err);
                return res.status(500).json({ error: 'Failed to fetch projects' });
            }
            
            // Get invoices for user's projects
            const projectIds = projects.map(p => p.id);
            if (projectIds.length === 0) {
                return res.json({
                    projects: [],
                    invoices: []
                });
            }
            
            const placeholders = projectIds.map(() => '?').join(',');
            db.all(`
                SELECT 
                    id,
                    projectId,
                    title,
                    amount,
                    currency,
                    issuedOn,
                    dueOn,
                    status,
                    paymentMethod,
                    receiptUrl
                FROM invoices
                WHERE projectId IN (${placeholders})
                ORDER BY issuedOn DESC
            `, projectIds, (err, invoices) => {
                if (err) {
                    console.error('Error fetching invoices:', err);
                    invoices = [];
                }
                
                res.json({
                    projects,
                    invoices: invoices.map(i => ({
                        id: i.id,
                        projectId: i.projectId,
                        title: i.title,
                        amount: i.amount,
                        currency: i.currency || 'USD',
                        issuedOn: i.issuedOn,
                        dueOn: i.dueOn,
                        status: i.status,
                        paymentMethod: i.paymentMethod,
                        receiptUrl: i.receiptUrl
                    }))
                });
            });
        });
    } catch (error) {
        console.error('Projects error:', error);
        res.status(500).json({ error: 'Failed to fetch projects' });
    }
});

// Notifications endpoint
app.get('/api/notifications', authenticateToken, async (req, res) => {
    try {
        const userId = req.user.id;
        const userEmail = req.user.email?.toLowerCase();
        
        // Get activities for user (last 20)
        // Exclude user-initiated actions (File Uploaded, Invoice Uploaded, Ticket Submitted)
        // Only show admin-initiated actions (File Received, Invoice Received, Ticket Replies, etc.)
        // Match by userId OR userEmail (for cross-device sync when admin creates notifications)
        console.log('[GET /api/notifications] Fetching for user:', { userId, userEmail });
        db.all(`
            SELECT 
                id,
                type,
                title,
                description,
                userId,
                projectId,
                invoiceId,
                ticketId,
                source,
                userEmail,
                read,
                timestamp
            FROM activities
            WHERE (
                CAST(userId AS TEXT) = CAST(? AS TEXT) 
                OR userId = ? 
                OR (userEmail IS NOT NULL AND LOWER(userEmail) = ?)
                OR (userId IS NULL AND userEmail IS NULL)
            )
            AND title NOT IN ('File Uploaded', 'Invoice/Receipt Uploaded', 'New Ticket Submitted', 'Ticket Submitted')
            AND title NOT LIKE '%File Uploaded%'
            AND title NOT LIKE '%Invoice%Uploaded%'
            AND title NOT LIKE '%Ticket Submitted%'
            ORDER BY timestamp DESC
            LIMIT 20
        `, [userId, userId, userEmail || ''], (err, activities) => {
            if (err) {
                console.error('[GET /api/notifications] Error fetching notifications:', err);
                return res.status(500).json({ error: 'Failed to fetch notifications' });
            }
            
            console.log('[GET /api/notifications] Found', activities.length, 'notifications for user:', { userId, userEmail });
            if (activities.length > 0) {
                const sample = activities.slice(0, 5).map(a => ({
                    id: a.id,
                    title: a.title,
                    userId: a.userId,
                    userEmail: a.userEmail,
                    userIdType: typeof a.userId,
                    type: a.type
                }));
                console.log('[GET /api/notifications] Sample notifications:', JSON.stringify(sample, null, 2));
                
                // Check if Progress Update notifications are in the results
                const progressUpdates = activities.filter(a => a.title === 'Progress Update' || a.title === 'Project Completed');
                console.log('[GET /api/notifications] Progress Update notifications found:', progressUpdates.length);
                if (progressUpdates.length > 0) {
                    console.log('[GET /api/notifications] Progress Update samples:', progressUpdates.slice(0, 2).map(a => ({
                        id: a.id,
                        title: a.title,
                        userId: a.userId,
                        userEmail: a.userEmail
                    })));
                }
            }
            
            res.json({
                notifications: activities.map(a => ({
                    id: a.id,
                    type: a.type,
                    title: a.title,
                    description: a.description,
                    timestamp: a.timestamp,
                    read: a.read === 1,
                    userId: a.userId,
                    projectId: a.projectId,
                    invoiceId: a.invoiceId,
                    ticketId: a.ticketId,
                    source: a.source,
                    userEmail: a.userEmail
                }))
            });
        });
    } catch (error) {
        console.error('Notifications error:', error);
        res.status(500).json({ error: 'Failed to fetch notifications' });
    }
});

// Mark notifications as read
app.post('/api/notifications/mark-read', authenticateToken, async (req, res) => {
    try {
        const userId = req.user.id;
        const userEmail = req.user.email?.toLowerCase();
        const { ids } = req.body || {};
        
        if (!Array.isArray(ids) || ids.length === 0) {
            return res.status(400).json({ error: 'ids array is required' });
        }
        
        // Build placeholders for the IN clause
        const placeholders = ids.map(() => '?').join(',');
        const params = [
            ...ids,
            userId,
            userId,
            userEmail || ''
        ];
        
        const sql = `
            UPDATE activities
            SET read = 1
            WHERE id IN (${placeholders})
              AND (
                    CAST(userId AS TEXT) = CAST(? AS TEXT)
                 OR userId = ?
                 OR (userEmail IS NOT NULL AND LOWER(userEmail) = ?)
              )
        `;
        
        db.run(sql, params, function(err) {
            if (err) {
                console.error('[POST /api/notifications/mark-read] Error marking as read:', err);
                return res.status(500).json({ error: 'Failed to mark notifications as read' });
            }
            res.json({ success: true, updated: this.changes });
        });
    } catch (error) {
        console.error('Mark notifications as read error:', error);
        res.status(500).json({ error: 'Failed to mark notifications as read' });
    }
});

// Helper function to send push notification via Expo
async function sendPushNotification(pushToken, title, body, data = {}) {
    try {
        // Detect iOS vs Android from token prefix (ExponentPushToken[...])
        const isIOS = pushToken.includes('ExponentPushToken[');
        
        const payload = {
            to: pushToken,
            sound: 'default',
            title: title,
            body: body,
            data: data,
            priority: 'high',
        };
        
        // Android-specific: channelId is required for Android 8.0+
        if (!isIOS) {
            payload.channelId = 'infinet-hub-notifications';
        }
        
        // iOS-specific: badge count (optional but recommended)
        if (isIOS) {
            payload.badge = 1;
        }
        
        const response = await fetch('https://exp.host/--/api/v2/push/send', {
            method: 'POST',
            headers: {
                'Accept': 'application/json',
                'Accept-Encoding': 'gzip, deflate',
                'Content-Type': 'application/json',
            },
            body: JSON.stringify(payload)
        });

        const result = await response.json();
        
        if (result.data?.status === 'ok') {
            return true;
        } else {
            return false;
        }
    } catch (error) {
        return false;
    }
}

// Helper function to get user by ID
function getUserById(userId) {
    return new Promise((resolve, reject) => {
        db.get('SELECT id, email, name, company, role FROM users WHERE id = ?', [userId], (err, row) => {
            if (err) {
                reject(err);
            } else {
                resolve(row || null);
            }
        });
    });
}

// Helper function to get push tokens for a user
function getPushTokensForUser(userId, userEmail, callback) {
    const tokens = [];
    let completedQueries = 0;
    // Count: userId queries (2: number + string) + email query (1 if provided)
    const totalQueries = (userId ? 2 : 0) + (userEmail ? 1 : 0);
    
    if (totalQueries === 0) {
        callback([]);
        return;
    }
    
    const checkComplete = () => {
        completedQueries++;
        if (completedQueries >= totalQueries) {
            callback(tokens);
        }
    };
    
    // Get tokens by userId (try both string and number)
    if (userId) {
        // Try as number first
        db.all('SELECT pushToken FROM push_tokens WHERE userId = ?', [Number(userId)], (err, rows) => {
            if (!err) {
                rows.forEach(row => {
                    if (!tokens.includes(row.pushToken)) {
                        tokens.push(row.pushToken);
                    }
                });
            }
            checkComplete();
        });
        
        // Also try as string
        db.all('SELECT pushToken FROM push_tokens WHERE CAST(userId AS TEXT) = ?', [String(userId)], (err, rows) => {
            if (!err) {
                rows.forEach(row => {
                    if (!tokens.includes(row.pushToken)) {
                        tokens.push(row.pushToken);
                    }
                });
            }
            checkComplete();
        });
    }
    
    // Also get tokens by email if userEmail is provided
    if (userEmail) {
        db.all(`
            SELECT pt.pushToken 
            FROM push_tokens pt
            JOIN users u ON pt.userId = u.id
            WHERE LOWER(u.email) = LOWER(?)
        `, [userEmail], (err, emailRows) => {
            if (!err) {
                emailRows.forEach(row => {
                    if (!tokens.includes(row.pushToken)) {
                        tokens.push(row.pushToken);
                    }
                });
            }
            checkComplete();
        });
    }
}

// POST /api/push-token - Register push token
app.post('/api/push-token', authenticateToken, async (req, res) => {
    try {
        const userId = req.user.id;
        const { pushToken } = req.body;

        if (!pushToken) {
            return res.status(400).json({ error: 'Missing pushToken' });
        }

        // Insert or update push token
        db.run(`
            INSERT OR REPLACE INTO push_tokens (userId, pushToken, updatedAt)
            VALUES (?, ?, datetime('now'))
        `, [userId, pushToken], function(err) {
            if (err) {
                return res.status(500).json({ error: 'Failed to save push token' });
            }

            res.json({ success: true, message: 'Push token registered' });
        });
    } catch (error) {
        res.status(500).json({ error: 'Failed to register push token' });
    }
});

// POST /api/activities - Create/sync an activity
app.post('/api/activities', authenticateToken, async (req, res) => {
    try {
        const {
            id,
            type,
            title,
            description,
            userId,
            projectId,
            invoiceId,
            ticketId,
            source,
            userEmail,
            read,
            timestamp
        } = req.body;

        // Validate required fields
        if (!id || !type || !title) {
            return res.status(400).json({ error: 'Missing required fields: id, type, title' });
        }

        // Use provided userId, or if userEmail is provided and userId is null/undefined, 
        // try to find user by email. Otherwise, use current user's ID.
        let targetUserId = userId;
        
        // Helper function to insert activity
        const insertActivity = (finalUserId) => {
            db.run(`
                INSERT OR REPLACE INTO activities (
                    id, type, title, description, userId, projectId,
                    invoiceId, ticketId, source, userEmail, read, timestamp
                ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
            `, [
                id,
                type,
                title,
                description || null,
                finalUserId,
                projectId || null,
                invoiceId || null,
                ticketId || null,
                source || null,
                userEmail || null,
                read ? 1 : 0,
                timestamp || new Date().toISOString()
            ], function(err) {
                if (err) {
                    console.error('[POST /api/activities] Error creating activity:', err);
                    return res.status(500).json({ error: 'Failed to create activity' });
                }

                console.log('[POST /api/activities] Activity created:', {
                    id,
                    type,
                    title,
                    userId: finalUserId,
                    userEmail: userEmail || null,
                    projectId: projectId || null
                });

                // Send push notification if this is not a user-initiated action
                // Only send for admin-initiated notifications (not File Uploaded, Invoice Uploaded, Ticket Submitted)
                const isUserInitiated = title === 'File Uploaded' || 
                                       title === 'Invoice/Receipt Uploaded' || 
                                       title === 'New Ticket Submitted' || 
                                       title === 'Ticket Submitted' ||
                                       title.includes('File Uploaded') ||
                                       title.includes('Invoice') && title.includes('Uploaded') ||
                                       title.includes('Ticket Submitted') ||
                                       title.includes('Project Request');

                // Send push notification to admin when user initiates actions
                if (isUserInitiated) {
                    const ADMIN_EMAIL = process.env.ADMIN_EMAIL || 'YOUR_ADMIN_EMAIL';
                    getPushTokensForUser(null, ADMIN_EMAIL, (adminPushTokens) => {
                        if (adminPushTokens.length > 0) {
                            // Send push notification to admin
                            const adminNotificationTitle = title.includes('Project Request') 
                                ? title 
                                : `New ${title}`;
                            const adminNotificationBody = userEmail 
                                ? `${userEmail}: ${description || title}`
                                : (description || title);
                            adminPushTokens.forEach(token => {
                                sendPushNotification(
                                    token,
                                    adminNotificationTitle,
                                    adminNotificationBody,
                                    {
                                        activityId: id,
                                        type: type,
                                        projectId: projectId || null,
                                        invoiceId: invoiceId || null,
                                        ticketId: ticketId || null
                                    }
                                ).catch(() => {});
                            });
                        }
                    });
                }

                if (!isUserInitiated && (finalUserId || userEmail)) {
                    // Get push tokens for the user
                    getPushTokensForUser(finalUserId, userEmail, (pushTokens) => {
                        if (pushTokens.length > 0) {
                            // Send push notification to all user's devices
                            const notificationBody = description || title;
                            pushTokens.forEach(token => {
                                sendPushNotification(
                                    token,
                                    title,
                                    notificationBody,
                                    {
                                        activityId: id,
                                        type: type,
                                        projectId: projectId || null,
                                        invoiceId: invoiceId || null,
                                        ticketId: ticketId || null
                                    }
                                ).catch(() => {});
                            });
                        }
                    });
                }

                res.json({
                    success: true,
                    activity: {
                        id,
                        type,
                        title,
                        description,
                        userId: finalUserId,
                        projectId,
                        invoiceId,
                        ticketId,
                        source,
                        userEmail,
                        read: read || false,
                        timestamp: timestamp || new Date().toISOString()
                    }
                });
            });
        };
        
        // If userId is not provided but userEmail is, try to find user by email
        if (!targetUserId && userEmail) {
            console.log('[POST /api/activities] Finding user by email:', userEmail);
            db.get('SELECT id FROM users WHERE LOWER(email) = LOWER(?)', [userEmail], (err, row) => {
                if (err) {
                    console.error('[POST /api/activities] Error finding user by email:', err);
                    // If userEmail is provided but user not found, save with null userId but keep userEmail
                    // This allows notifications to be retrieved by email even if user doesn't exist yet
                    console.log('[POST /api/activities] Saving activity with userEmail only (user not found):', userEmail);
                    insertActivity(null); // null userId, but userEmail will be saved
                } else if (row) {
                    console.log('[POST /api/activities] Found user by email:', row.id);
                    insertActivity(row.id);
                } else {
                    console.warn('[POST /api/activities] User not found by email:', userEmail, '- saving with userEmail only');
                    // User not found by email, save with null userId but keep userEmail for future matching
                    insertActivity(null); // null userId, but userEmail will be saved
                }
            });
        } else {
            // If userId is provided or no userEmail, use provided userId or current user's ID
            if (!targetUserId) {
                // Only use current user's ID if no userEmail is provided
                // If userEmail is provided, we want to save it for that user, not the admin
                if (!userEmail) {
                    targetUserId = req.user.id;
                } else {
                    // userEmail provided but no userId - save with null userId but keep userEmail
                    targetUserId = null;
                }
            }
            console.log('[POST /api/activities] Using provided userId:', targetUserId, 'userEmail:', userEmail);
            insertActivity(targetUserId);
        }
    } catch (error) {
        console.error('Activities POST error:', error);
        res.status(500).json({ error: 'Failed to create activity' });
    }
});

// POST /api/tickets - Create a new ticket
app.post('/api/tickets', authenticateToken, async (req, res) => {
    try {
        const userId = req.user.id;
        const { projectId, subject, message } = req.body;
        
        if (!projectId || !subject || !message) {
            return res.status(400).json({ error: 'Missing required fields: projectId, subject, message' });
        }
        
        // Get user info
        const user = await getUserById(userId);
        if (!user) {
            return res.status(404).json({ error: 'User not found' });
        }
        
        // Generate ticket ID
        const ticketId = `ticket-${Date.now()}-${Math.random().toString(36).substr(2, 9)}`;
        
        // Insert ticket into database
        db.run(`
            INSERT INTO tickets (id, projectId, subject, message, status, userId, userName, createdAt, updatedAt)
            VALUES (?, ?, ?, ?, 'Open', ?, ?, datetime('now'), datetime('now'))
        `, [ticketId, projectId, subject, message, userId, user.name || user.email], function(err) {
            if (err) {
                console.error('Error creating ticket:', err);
                return res.status(500).json({ error: 'Failed to create ticket' });
            }
            
            // Create activity for admin notification
            const activityId = `ticket-${ticketId}-${Date.now()}`;
            db.run(`
                INSERT OR REPLACE INTO activities (
                    id, type, title, description, userId, projectId, ticketId,
                    source, userEmail, read, timestamp
                ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
            `, [
                activityId,
                'Ticket',
                'New Ticket Submitted',
                `${user.name || user.email}: ${subject}`,
                null, // No userId - this is for admin
                projectId,
                ticketId,
                'tickets',
                process.env.ADMIN_EMAIL || 'YOUR_ADMIN_EMAIL', // Admin email
                0, // unread
                new Date().toISOString()
            ], (activityErr) => {
                if (activityErr) {
                    console.error('Error creating ticket activity:', activityErr);
                }
            });
            
            res.status(201).json({
                id: ticketId,
                projectId,
                subject,
                message,
                status: 'Open',
                userId,
                userName: user.name || user.email,
                createdAt: new Date().toISOString(),
                updatedAt: new Date().toISOString()
            });
        });
    } catch (error) {
        console.error('Ticket creation error:', error);
        res.status(500).json({ error: 'Failed to create ticket' });
    }
});

// POST /api/projects/:projectId/files - Upload a file to a project
app.post('/api/projects/:projectId/files', authenticateToken, async (req, res) => {
    try {
        const userId = req.user.id;
        const { projectId } = req.params;
        const { fileName, fileData, fileUri } = req.body; // fileData is base64, fileUri is local URI
        
        console.log(`[File Upload] Received request for project ${projectId}, fileName: ${fileName}, hasFileData: ${!!fileData}, hasFileUri: ${!!fileUri}`);
        
        // Security: Rate limiting
        if (!checkRateLimit(userId)) {
            return res.status(429).json({ error: 'Upload limit exceeded. Maximum 10 uploads per hour.' });
        }
        
        if (!fileName) {
            return res.status(400).json({ error: 'Missing required field: fileName' });
        }
        
        // Security: Validate file type
        const sanitizedFileName = sanitizeFileName(fileName);
        if (!validateFileExtension(sanitizedFileName, ALLOWED_FILE_EXTENSIONS)) {
            return res.status(415).json({ error: `Invalid file type. Allowed types: ${ALLOWED_FILE_EXTENSIONS.join(', ')}` });
        }
        
        // Generate file ID
        const fileId = `file-${Date.now()}-${Math.random().toString(36).substr(2, 9)}`;
        
        let fileUrl = '';
        
        // If fileData (base64) is provided, save it to disk
        if (fileData) {
            try {
                // Decode base64 and validate
                const fileBuffer = Buffer.from(fileData, 'base64');
                
                // Security: Validate file size
                const maxSize = isImageFile(sanitizedFileName) ? MAX_IMAGE_SIZE : MAX_DOCUMENT_SIZE;
                if (fileBuffer.length > maxSize) {
                    const maxSizeMB = maxSize / (1024 * 1024);
                    return res.status(413).json({ error: `File too large. Maximum size: ${maxSizeMB}MB for ${isImageFile(sanitizedFileName) ? 'images' : 'documents'}` });
                }
                
                // Security: Validate file content (MIME type)
                const fileExt = getFileExtension(sanitizedFileName);
                const expectedMimeType = MIME_TYPES[fileExt];
                if (expectedMimeType && !validateFileContent(fileBuffer, expectedMimeType)) {
                    console.warn(`[File Upload] File content validation failed for ${sanitizedFileName}, MIME: ${expectedMimeType}`);
                    // Don't block, but log the warning (some files might have minor variations)
                }
                
                // Get file extension from fileName
                const sanitizedFileId = `${fileId}${fileExt}`;
                const filePath = path.join(filesDir, sanitizedFileId);
                
                console.log(`[File Upload] Attempting to save file to: ${filePath}`);
                
                // Ensure directory exists (in case it was deleted)
                if (!fs.existsSync(filesDir)) {
                    fs.mkdirSync(filesDir, { recursive: true });
                    console.log(`[File Upload] Recreated files directory: ${filesDir}`);
                }
                
                fs.writeFileSync(filePath, fileBuffer);
                
                // Store the server path (relative to uploads directory) - use sanitized filename
                fileUrl = `/uploads/files/${sanitizedFileId}`;
                
                // Security: Log upload for audit
                console.log(`[File Upload] Security: File uploaded by user ${userId}, size: ${fileBuffer.length} bytes, type: ${fileExt}`);
                console.log(`[File Upload] File saved successfully: ${filePath} (${fileBuffer.length} bytes)`);
            } catch (fileError) {
                console.error('[File Upload] Error saving file to disk:', fileError);
                console.error('[File Upload] Error details:', {
                    message: fileError.message,
                    code: fileError.code,
                    stack: fileError.stack
                });
                // Fallback to storing URI if file save fails
                fileUrl = fileUri || '';
                console.log(`[File Upload] Using fallback URI: ${fileUrl}`);
            }
        } else if (fileUri) {
            // Fallback: if no base64 data, use URI (for backward compatibility)
            fileUrl = fileUri;
            console.log(`[File Upload] Using fileUri (no base64 data provided): ${fileUrl}`);
        } else {
            return res.status(400).json({ error: 'Missing required field: fileData or fileUri' });
        }
        
        console.log(`[File Upload] Inserting into database: fileId=${fileId}, projectId=${projectId}, fileName=${sanitizedFileName}, fileUrl=${fileUrl}`);
        
        // Insert file into database using Promise wrapper - store original filename
        await new Promise((resolve, reject) => {
            db.run(`
                INSERT INTO project_files (id, projectId, name, url, uploadedAt)
                VALUES (?, ?, ?, ?, datetime('now'))
            `, [fileId, projectId, sanitizedFileName, fileUrl], function(err) {
                if (err) {
                    console.error('[File Upload] Database error:', err);
                    console.error('[File Upload] Database error details:', {
                        message: err.message,
                        code: err.code
                    });
                    reject(err);
                    return;
                }
                
                console.log(`[File Upload] Database insert successful, lastID: ${this.lastID}`);
                resolve(this.lastID);
            });
        });
        
        // Get user info for admin notification
        const fileUser = await getUserById(userId);
        
        // Create activity for admin notification
        const fileActivityId = `file-${fileId}-${Date.now()}`;
        db.run(`
            INSERT OR REPLACE INTO activities (
                id, type, title, description, userId, projectId,
                source, userEmail, read, timestamp
            ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
        `, [
            fileActivityId,
            'File',
            'File Uploaded',
            `${fileUser?.name || fileUser?.email || 'User'}: ${fileName}`,
            null, // No userId - this is for admin
            projectId,
            'files',
            process.env.ADMIN_EMAIL || 'YOUR_ADMIN_EMAIL', // Admin email
            0, // unread
            new Date().toISOString()
        ], (activityErr) => {
            if (activityErr) {
                console.error('Error creating file upload activity:', activityErr);
            }
        });
        
        console.log(`[File Upload] Successfully uploaded file: ${fileId}`);
        res.status(201).json({
            id: fileId,
            projectId,
            name: sanitizedFileName, // Return sanitized filename
            url: fileUrl,
            uploadedAt: new Date().toISOString()
        });
    } catch (error) {
        console.error('[File Upload] Unexpected error:', error);
        console.error('[File Upload] Error stack:', error.stack);
        res.status(500).json({ error: 'Failed to upload file', details: error.message });
    }
});

// POST /api/invoices - Upload an invoice/receipt
app.post('/api/invoices', authenticateToken, async (req, res) => {
    try {
        const userId = req.user.id;
        const { projectId, title, amount, currency, issuedOn, dueOn, receiptData, receiptUri } = req.body;
        
        // Security: Rate limiting
        if (!checkRateLimit(userId)) {
            return res.status(429).json({ error: 'Upload limit exceeded. Maximum 10 uploads per hour.' });
        }
        
        if (!projectId || !title || !amount) {
            return res.status(400).json({ error: 'Missing required fields: projectId, title, amount' });
        }
        
        // Security: Sanitize title (which might be used as filename)
        const sanitizedTitle = sanitizeFileName(title);
        
        // Generate invoice ID
        const invoiceId = `invoice-${Date.now()}-${Math.random().toString(36).substr(2, 9)}`;
        
        let receiptUrl = '';
        
        // If receiptData (base64) is provided, save it to disk
        if (receiptData) {
            try {
                // Decode base64 and validate
                const fileBuffer = Buffer.from(receiptData, 'base64');
                
                // Security: Validate file size
                if (fileBuffer.length > MAX_INVOICE_SIZE) {
                    const maxSizeMB = MAX_INVOICE_SIZE / (1024 * 1024);
                    return res.status(413).json({ error: `Invoice file too large. Maximum size: ${maxSizeMB}MB` });
                }
                
                // Determine file extension from content or default to .pdf
                let fileExt = '.pdf';
                // Check for image signatures
                if (fileBuffer.length >= 8 && fileBuffer[0] === 0xFF && fileBuffer[1] === 0xD8) {
                    fileExt = '.jpg';
                } else if (fileBuffer.length >= 8 && fileBuffer[0] === 0x89 && fileBuffer[1] === 0x50 && fileBuffer[2] === 0x4E && fileBuffer[3] === 0x47) {
                    fileExt = '.png';
                } else if (fileBuffer.length >= 4 && fileBuffer[0] === 0x25 && fileBuffer[1] === 0x50 && fileBuffer[2] === 0x44 && fileBuffer[3] === 0x46) {
                    fileExt = '.pdf';
                } else if (fileBuffer.length >= 4 && fileBuffer[0] === 0x50 && fileBuffer[1] === 0x4B) {
                    // ZIP/DOCX
                    fileExt = '.docx';
                }
                
                // Security: Validate file extension is allowed
                if (!validateFileExtension(fileExt, ALLOWED_INVOICE_EXTENSIONS)) {
                    return res.status(415).json({ error: `Invalid file type. Allowed types: ${ALLOWED_INVOICE_EXTENSIONS.join(', ')}` });
                }
                
                // Security: Validate file content (MIME type)
                const expectedMimeType = MIME_TYPES[fileExt];
                if (expectedMimeType && !validateFileContent(fileBuffer, expectedMimeType)) {
                    console.warn(`[Invoice Upload] File content validation failed for invoice ${invoiceId}, MIME: ${expectedMimeType}`);
                    // Don't block, but log the warning
                }
                
                const sanitizedFileName = `${invoiceId}${fileExt}`;
                const filePath = path.join(invoicesDir, sanitizedFileName);
                
                // Ensure directory exists
                if (!fs.existsSync(invoicesDir)) {
                    fs.mkdirSync(invoicesDir, { recursive: true });
                }
                
                fs.writeFileSync(filePath, fileBuffer);
                
                // Store the server path (relative to uploads directory)
                receiptUrl = `/uploads/invoices/${sanitizedFileName}`;
                console.log(`[Invoice Upload] Receipt saved to: ${filePath} (${fileBuffer.length} bytes)`);
                
                // Security: Log upload for audit
                console.log(`[Invoice Upload] Security: Invoice uploaded by user ${userId}, size: ${fileBuffer.length} bytes, type: ${fileExt}`);
            } catch (fileError) {
                console.error('Error saving receipt to disk:', fileError);
                // Fallback to storing URI if file save fails
                receiptUrl = receiptUri || '';
            }
        } else if (receiptUri) {
            // Fallback: if no base64 data, use URI (for backward compatibility)
            receiptUrl = receiptUri;
        }
        
        // Default dates if not provided
        const issuedDate = issuedOn || new Date().toISOString().split('T')[0];
        const dueDate = dueOn || new Date(Date.now() + 30 * 24 * 60 * 60 * 1000).toISOString().split('T')[0]; // 30 days from now
        
        // Get user info for admin notification
        const invoiceUser = await getUserById(userId);
        
        // Insert invoice into database - use sanitized title
        db.run(`
            INSERT INTO invoices (id, projectId, title, amount, currency, issuedOn, dueOn, status, receiptUrl, createdAt, updatedAt)
            VALUES (?, ?, ?, ?, ?, ?, ?, 'Draft', ?, datetime('now'), datetime('now'))
        `, [invoiceId, projectId, sanitizedTitle, parseFloat(amount), currency || 'USD', issuedDate, dueDate, receiptUrl], function(err) {
            if (err) {
                console.error('Error creating invoice:', err);
                return res.status(500).json({ error: 'Failed to create invoice' });
            }
            
            // Create activity for admin notification
            const invoiceActivityId = `invoice-${invoiceId}-${Date.now()}`;
            db.run(`
                INSERT OR REPLACE INTO activities (
                    id, type, title, description, userId, projectId, invoiceId,
                    source, userEmail, read, timestamp
                ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
            `, [
                invoiceActivityId,
                'Invoice',
                'Invoice/Receipt Uploaded',
                `${invoiceUser?.name || invoiceUser?.email || 'User'}: ${sanitizedTitle} - $${amount}`,
                null, // No userId - this is for admin
                projectId,
                invoiceId,
                'invoices',
                process.env.ADMIN_EMAIL || 'YOUR_ADMIN_EMAIL', // Admin email
                0, // unread
                new Date().toISOString()
            ], (activityErr) => {
                if (activityErr) {
                    console.error('Error creating invoice upload activity:', activityErr);
                }
            });
            
        res.status(201).json({
            id: invoiceId,
            projectId,
            title: sanitizedTitle, // Return sanitized title
            amount: parseFloat(amount),
            currency: currency || 'USD',
            issuedOn: issuedDate,
            dueOn: dueDate,
            status: 'Draft',
            receiptUrl,
            createdAt: new Date().toISOString(),
            updatedAt: new Date().toISOString()
        });
        });
    } catch (error) {
        console.error('Invoice creation error:', error);
        res.status(500).json({ error: 'Failed to create invoice' });
    }
});

// GET /api/projects/history - Fetch project history
app.get('/api/projects/history', authenticateToken, async (req, res) => {
    try {
        const userId = req.user.id;
        const isAdmin = req.user.role === 'Administrator';
        const { limit = 100 } = req.query;
        
        console.log('[GET /api/projects/history] Request from user:', {
            userId,
            role: req.user.role,
            isAdmin,
            limit
        });
        
        const sanitizedLimit = Math.min(Math.max(parseInt(limit, 10) || 100, 1), 500);
        
        // Admins can fetch all project history, regular users only their own
        let query = `
            SELECT 
                id,
                userId,
                projectId,
                action,
                input_json,
                output_json,
                summary,
                timestamp,
                hiddenFromHistory
            FROM project_history
        `;
        const queryParams = [];
        
        if (!isAdmin) {
            // Ensure userId is string for comparison (database stores as TEXT)
            query += ` WHERE userId = ?`;
            queryParams.push(String(userId));
        }
        
        query += ` ORDER BY datetime(timestamp) DESC LIMIT ?`;
        queryParams.push(sanitizedLimit);
        
        console.log('[GET /api/projects/history] Query:', query);
        console.log('[GET /api/projects/history] Query params:', queryParams);
        console.log('[GET /api/projects/history] User ID type:', typeof userId, 'value:', userId);
        
        db.all(query, queryParams, (err, rows) => {
            if (err) {
                console.error('Error fetching project history:', err);
                return res.status(500).json({ error: 'Failed to fetch project history' });
            }
            
            console.log('[GET /api/projects/history] Found', rows.length, 'history entries');
            if (rows.length > 0) {
                console.log('[GET /api/projects/history] Sample entries:', rows.slice(0, 3).map(r => ({
                    id: r.id,
                    action: r.action,
                    userId: r.userId,
                    projectId: r.projectId
                })));
            }
            
            const history = rows.map(row => ({
                id: row.id,
                userId: row.userId ? String(row.userId) : undefined,
                projectId: row.projectId || undefined,
                action: row.action,
                input: row.input_json ? JSON.parse(row.input_json) : {},
                output: row.output_json ? JSON.parse(row.output_json) : {},
                summary: row.summary || undefined,
                timestamp: row.timestamp,
                hiddenFromHistory: row.hiddenFromHistory === 1
            }));
            
            res.json({
                history,
                timestamp: new Date().toISOString()
            });
        });
    } catch (error) {
        console.error('Project history fetch error:', error);
        res.status(500).json({ error: 'Failed to fetch project history' });
    }
});

// POST /api/projects/history - Save project history entry
app.post('/api/projects/history', authenticateToken, async (req, res) => {
    try {
        const currentUserId = req.user.id;
        const { id, projectId, action, input, output, summary, timestamp, hiddenFromHistory, userId } = req.body;
        
        if (!id || !action) {
            return res.status(400).json({ error: 'Missing required fields: id, action' });
        }
        
        // Use userId from request body if provided (for admin-created entries), otherwise use current user's ID
        const targetUserId = userId || currentUserId;
        
        // Ensure userId is stored as string for consistency
        const targetUserIdStr = targetUserId ? String(targetUserId) : null;
        
        const entryTimestamp = timestamp || new Date().toISOString();
        const inputJson = input ? JSON.stringify(input) : null;
        const outputJson = output ? JSON.stringify(output) : null;
        const isHidden = hiddenFromHistory === true ? 1 : 0;
        
        console.log('[POST /api/projects/history] Saving entry:', {
            id,
            action,
            userId: targetUserIdStr,
            projectId: projectId || null,
            currentUserId: String(currentUserId),
            providedUserId: userId ? String(userId) : null
        });
        
        db.run(`
            INSERT OR REPLACE INTO project_history 
            (id, userId, projectId, action, input_json, output_json, summary, timestamp, hiddenFromHistory)
            VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
        `, [id, targetUserIdStr, projectId || null, action, inputJson, outputJson, summary || null, entryTimestamp, isHidden], function(err) {
            if (err) {
                console.error('Error saving project history entry:', err);
                return res.status(500).json({ error: 'Failed to save project history entry' });
            }
            
            console.log('[POST /api/projects/history] Successfully saved entry:', {
                id,
                action,
                userId: targetUserIdStr,
                projectId: projectId || null
            });
            
            res.status(201).json({
                success: true,
                id,
                timestamp: entryTimestamp
            });
        });
    } catch (error) {
        console.error('Project history save error:', error);
        res.status(500).json({ error: 'Failed to save project history entry' });
    }
});

// Project Requests API Endpoints
// POST /api/project-requests - Submit a new project request
app.post('/api/project-requests', authenticateToken, async (req, res) => {
    try {
        const {
            id,
            serviceType,
            projectName,
            projectDescription,
            projectGoals,
            targetAudience,
            budgetRange,
            timeline,
            contactName,
            contactEmail,
            contactPhone,
            company,
            additionalNotes,
            status,
            submittedAt,
            userId,
            userEmail
        } = req.body;

        if (!id || !serviceType || !projectName || !projectDescription || !contactName || !contactEmail) {
            return res.status(400).json({ error: 'Missing required fields' });
        }

        const requestData = {
            id,
            serviceType,
            projectName,
            projectDescription,
            projectGoals: projectGoals || null,
            targetAudience: targetAudience || null,
            budgetRange: budgetRange || null,
            timeline: timeline || null,
            contactName,
            contactEmail,
            contactPhone: contactPhone || null,
            company: company || null,
            additionalNotes: additionalNotes || null,
            status: status || 'pending',
            submittedAt: submittedAt || new Date().toISOString(),
            userId: userId || req.user.id || null,
            userEmail: userEmail || req.user.email || null
        };

        db.run(`
            INSERT INTO project_requests (
                id, serviceType, projectName, projectDescription, projectGoals,
                targetAudience, budgetRange, timeline, contactName, contactEmail,
                contactPhone, company, additionalNotes, status, submittedAt,
                userId, userEmail, createdAt, updatedAt
            ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, CURRENT_TIMESTAMP, CURRENT_TIMESTAMP)
        `, [
            requestData.id,
            requestData.serviceType,
            requestData.projectName,
            requestData.projectDescription,
            requestData.projectGoals,
            requestData.targetAudience,
            requestData.budgetRange,
            requestData.timeline,
            requestData.contactName,
            requestData.contactEmail,
            requestData.contactPhone,
            requestData.company,
            requestData.additionalNotes,
            requestData.status,
            requestData.submittedAt,
            requestData.userId,
            requestData.userEmail
        ], function(err) {
            if (err) {
                console.error('Error saving project request:', err);
                return res.status(500).json({ error: 'Failed to save project request' });
            }

            res.status(201).json({
                success: true,
                request: requestData
            });
        });
    } catch (error) {
        console.error('Project request submission error:', error);
        res.status(500).json({ error: 'Failed to submit project request' });
    }
});

// GET /api/project-requests - Get project requests (all for admin, own for regular users)
app.get('/api/project-requests', authenticateToken, async (req, res) => {
    try {
        const isAdmin = req.user.role === 'Administrator';
        const userId = req.user.id;
        const userEmail = req.user.email;
        
        // Log user info for debugging
        console.log('[GET /api/project-requests] User info:', {
            id: userId,
            email: userEmail,
            role: req.user.role,
            isAdmin: isAdmin
        });

        // Build query: admins get all, regular users get only their own
        let query = `
            SELECT 
                id, serviceType, projectName, projectDescription, projectGoals,
                targetAudience, budgetRange, timeline, contactName, contactEmail,
                contactPhone, company, additionalNotes, status, submittedAt,
                userId, userEmail, projectId, confirmedAt, declinedAt,
                createdAt, updatedAt
            FROM project_requests
        `;
        
        const queryParams = [];
        
        if (!isAdmin) {
            // Regular users: only their own requests (by userId or email)
            query += ` WHERE (userId = ? OR userEmail = ?)`;
            queryParams.push(userId, userEmail);
        }
        
        query += ` ORDER BY datetime(submittedAt) DESC`;

        db.all(query, queryParams, (err, rows) => {
            if (err) {
                console.error('Error fetching project requests:', err);
                return res.status(500).json({ error: 'Failed to fetch project requests' });
            }

            const requests = rows.map(row => ({
                id: row.id,
                serviceType: row.serviceType,
                projectName: row.projectName,
                projectDescription: row.projectDescription,
                projectGoals: row.projectGoals || undefined,
                targetAudience: row.targetAudience || undefined,
                budgetRange: row.budgetRange || undefined,
                timeline: row.timeline || undefined,
                contactName: row.contactName,
                contactEmail: row.contactEmail,
                contactPhone: row.contactPhone || undefined,
                company: row.company || undefined,
                additionalNotes: row.additionalNotes || undefined,
                status: row.status,
                submittedAt: row.submittedAt,
                userId: row.userId ? String(row.userId) : undefined,
                userEmail: row.userEmail || undefined,
                projectId: row.projectId || undefined,
                confirmedAt: row.confirmedAt || undefined,
                declinedAt: row.declinedAt || undefined
            }));

            res.json({
                requests,
                timestamp: new Date().toISOString()
            });
        });
    } catch (error) {
        console.error('Project requests fetch error:', error);
        res.status(500).json({ error: 'Failed to fetch project requests' });
    }
});

// PUT /api/project-requests/:id - Update a project request (admin only)
app.put('/api/project-requests/:id', authenticateToken, async (req, res) => {
    try {
        // Check if user is admin
        if (req.user.role !== 'Administrator') {
            return res.status(403).json({ error: 'Access denied. Admin only.' });
        }

        const requestId = req.params.id;
        const updates = req.body;

        // Build update query dynamically
        const updateFields = [];
        const updateValues = [];

        if (updates.status !== undefined) {
            updateFields.push('status = ?');
            updateValues.push(updates.status);
        }
        if (updates.projectId !== undefined) {
            updateFields.push('projectId = ?');
            updateValues.push(updates.projectId);
        }
        if (updates.confirmedAt !== undefined) {
            updateFields.push('confirmedAt = ?');
            updateValues.push(updates.confirmedAt);
        }
        if (updates.declinedAt !== undefined) {
            updateFields.push('declinedAt = ?');
            updateValues.push(updates.declinedAt);
        }

        if (updateFields.length === 0) {
            return res.status(400).json({ error: 'No valid fields to update' });
        }

        updateFields.push('updatedAt = CURRENT_TIMESTAMP');
        updateValues.push(requestId);

        db.run(`
            UPDATE project_requests
            SET ${updateFields.join(', ')}
            WHERE id = ?
        `, updateValues, function(err) {
            if (err) {
                console.error('Error updating project request:', err);
                return res.status(500).json({ error: 'Failed to update project request' });
            }

            if (this.changes === 0) {
                return res.status(404).json({ error: 'Project request not found' });
            }

            // Fetch updated request
            db.get(`
                SELECT 
                    id, serviceType, projectName, projectDescription, projectGoals,
                    targetAudience, budgetRange, timeline, contactName, contactEmail,
                    contactPhone, company, additionalNotes, status, submittedAt,
                    userId, userEmail, projectId, confirmedAt, declinedAt,
                    createdAt, updatedAt
                FROM project_requests
                WHERE id = ?
            `, [requestId], (err, row) => {
                if (err) {
                    console.error('Error fetching updated project request:', err);
                    return res.status(500).json({ error: 'Failed to fetch updated request' });
                }

                if (!row) {
                    return res.status(404).json({ error: 'Project request not found' });
                }

                const updatedRequest = {
                    id: row.id,
                    serviceType: row.serviceType,
                    projectName: row.projectName,
                    projectDescription: row.projectDescription,
                    projectGoals: row.projectGoals || undefined,
                    targetAudience: row.targetAudience || undefined,
                    budgetRange: row.budgetRange || undefined,
                    timeline: row.timeline || undefined,
                    contactName: row.contactName,
                    contactEmail: row.contactEmail,
                    contactPhone: row.contactPhone || undefined,
                    company: row.company || undefined,
                    additionalNotes: row.additionalNotes || undefined,
                    status: row.status,
                    submittedAt: row.submittedAt,
                    userId: row.userId ? String(row.userId) : undefined,
                    userEmail: row.userEmail || undefined,
                    projectId: row.projectId || undefined,
                    confirmedAt: row.confirmedAt || undefined,
                    declinedAt: row.declinedAt || undefined
                };

                res.json({
                    success: true,
                    request: updatedRequest
                });
            });
        });
    } catch (error) {
        console.error('Project request update error:', error);
        res.status(500).json({ error: 'Failed to update project request' });
    }
});

// POST /api/agent-requests - Submit a new agent request
app.post('/api/agent-requests', authenticateToken, async (req, res) => {
    try {
        const {
            id,
            summary,
            idealOutcome,
            contactEmail,
            status,
            submittedAt,
            userId,
            userEmail
        } = req.body;

        if (!id || !summary || !contactEmail) {
            return res.status(400).json({ error: 'Missing required fields' });
        }

        const requestData = {
            id,
            summary,
            idealOutcome: idealOutcome || null,
            contactEmail,
            status: status || 'pending',
            submittedAt: submittedAt || new Date().toISOString(),
            userId: userId || req.user.id || null,
            userEmail: userEmail || req.user.email || null
        };

        db.run(`
            INSERT INTO agent_requests (
                id, summary, idealOutcome, contactEmail, status, submittedAt,
                userId, userEmail, createdAt, updatedAt
            ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, CURRENT_TIMESTAMP, CURRENT_TIMESTAMP)
        `, [
            requestData.id,
            requestData.summary,
            requestData.idealOutcome,
            requestData.contactEmail,
            requestData.status,
            requestData.submittedAt,
            requestData.userId,
            requestData.userEmail
        ], function(err) {
            if (err) {
                console.error('Error saving agent request:', err);
                return res.status(500).json({ error: 'Failed to save agent request' });
            }

            res.status(201).json({
                success: true,
                request: requestData
            });
        });
    } catch (error) {
        console.error('Agent request submission error:', error);
        res.status(500).json({ error: 'Failed to submit agent request' });
    }
});

// GET /api/agent-requests - Get all agent requests (admin only)
app.get('/api/agent-requests', authenticateToken, async (req, res) => {
    try {
        // Check if user is admin
        if (req.user.role !== 'Administrator') {
            return res.status(403).json({ error: 'Access denied. Admin only.' });
        }

        db.all(`
            SELECT 
                id, summary, idealOutcome, contactEmail, status, submittedAt,
                userId, userEmail, projectId, confirmedAt, declinedAt,
                createdAt, updatedAt
            FROM agent_requests
            ORDER BY datetime(submittedAt) DESC
        `, (err, rows) => {
            if (err) {
                console.error('Error fetching agent requests:', err);
                return res.status(500).json({ error: 'Failed to fetch agent requests' });
            }

            const requests = rows.map(row => ({
                id: row.id,
                summary: row.summary,
                idealOutcome: row.idealOutcome || undefined,
                contactEmail: row.contactEmail,
                status: row.status,
                submittedAt: row.submittedAt,
                userId: row.userId ? String(row.userId) : undefined,
                userEmail: row.userEmail || undefined,
                projectId: row.projectId || undefined,
                confirmedAt: row.confirmedAt || undefined,
                declinedAt: row.declinedAt || undefined
            }));

            res.json({
                requests,
                timestamp: new Date().toISOString()
            });
        });
    } catch (error) {
        console.error('Agent requests fetch error:', error);
        res.status(500).json({ error: 'Failed to fetch agent requests' });
    }
});

// PUT /api/agent-requests/:id - Update an agent request (admin only)
app.put('/api/agent-requests/:id', authenticateToken, async (req, res) => {
    try {
        // Check if user is admin
        if (req.user.role !== 'Administrator') {
            return res.status(403).json({ error: 'Access denied. Admin only.' });
        }

        const requestId = req.params.id;
        const updates = req.body;

        // Build update query dynamically
        const updateFields = [];
        const updateValues = [];

        if (updates.status !== undefined) {
            updateFields.push('status = ?');
            updateValues.push(updates.status);
        }
        if (updates.projectId !== undefined) {
            updateFields.push('projectId = ?');
            updateValues.push(updates.projectId);
        }
        if (updates.confirmedAt !== undefined) {
            updateFields.push('confirmedAt = ?');
            updateValues.push(updates.confirmedAt);
        }
        if (updates.declinedAt !== undefined) {
            updateFields.push('declinedAt = ?');
            updateValues.push(updates.declinedAt);
        }

        if (updateFields.length === 0) {
            return res.status(400).json({ error: 'No valid fields to update' });
        }

        updateFields.push('updatedAt = CURRENT_TIMESTAMP');
        updateValues.push(requestId);

        db.run(`
            UPDATE agent_requests
            SET ${updateFields.join(', ')}
            WHERE id = ?
        `, updateValues, function(err) {
            if (err) {
                console.error('Error updating agent request:', err);
                return res.status(500).json({ error: 'Failed to update agent request' });
            }

            if (this.changes === 0) {
                return res.status(404).json({ error: 'Agent request not found' });
            }

            res.json({
                success: true,
                message: 'Agent request updated successfully'
            });
        });
    } catch (error) {
        console.error('Agent request update error:', error);
        res.status(500).json({ error: 'Failed to update agent request' });
    }
});

// POST /api/tool-history - Add tool history entry
app.post('/api/tool-history', authenticateToken, async (req, res) => {
    try {
        const {
            id,
            toolType,
            input,
            output,
            result,
            timestamp,
            userId,
            userEmail
        } = req.body;

        if (!id || !toolType || !timestamp) {
            return res.status(400).json({ error: 'Missing required fields' });
        }

        const historyData = {
            id,
            toolType,
            input: input || null,
            output: output || null,
            result: result || null,
            timestamp,
            userId: userId || req.user.id,
            userEmail: userEmail || req.user.email || null
        };

        db.run(`
            INSERT INTO tool_history (
                id, userId, userEmail, toolType, input, output, result, timestamp
            ) VALUES (?, ?, ?, ?, ?, ?, ?, ?)
        `, [
            historyData.id,
            historyData.userId,
            historyData.userEmail,
            historyData.toolType,
            historyData.input,
            historyData.output,
            historyData.result,
            historyData.timestamp
        ], function(err) {
            if (err) {
                console.error('Error saving tool history:', err);
                return res.status(500).json({ error: 'Failed to save tool history' });
            }

            res.status(201).json({
                success: true,
                entry: historyData
            });
        });
    } catch (error) {
        console.error('Tool history submission error:', error);
        res.status(500).json({ error: 'Failed to submit tool history' });
    }
});

// GET /api/tool-history - Get tool history for user
app.get('/api/tool-history', authenticateToken, async (req, res) => {
    try {
        const userId = req.user.id;
        const limit = parseInt(req.query.limit) || 25;

        db.all(`
            SELECT 
                id, userId, userEmail, toolType, input, output, result, timestamp
            FROM tool_history
            WHERE userId = ?
            ORDER BY datetime(timestamp) DESC
            LIMIT ?
        `, [userId, limit], (err, rows) => {
            if (err) {
                console.error('Error fetching tool history:', err);
                return res.status(500).json({ error: 'Failed to fetch tool history' });
            }

            const history = rows.map(row => ({
                id: row.id,
                toolType: row.toolType,
                input: row.input || undefined,
                output: row.output || undefined,
                result: row.result || undefined,
                timestamp: row.timestamp
            }));

            res.json({
                history,
                timestamp: new Date().toISOString()
            });
        });
    } catch (error) {
        console.error('Tool history fetch error:', error);
        res.status(500).json({ error: 'Failed to fetch tool history' });
    }
});

// POST /api/creator-history - Add creator history entry
app.post('/api/creator-history', authenticateToken, async (req, res) => {
    try {
        const {
            id,
            contentType,
            topic,
            tone,
            style,
            prompt,
            generatedContent,
            imageUrls,
            timestamp,
            userId,
            userEmail
        } = req.body;

        if (!id || !contentType || !timestamp) {
            return res.status(400).json({ error: 'Missing required fields' });
        }

        const historyData = {
            id,
            contentType,
            topic: topic || null,
            tone: tone || null,
            style: style || null,
            prompt: prompt || null,
            generatedContent: generatedContent || null,
            imageUrls: imageUrls ? JSON.stringify(imageUrls) : null,
            timestamp,
            userId: userId || req.user.id,
            userEmail: userEmail || req.user.email || null
        };

        db.run(`
            INSERT INTO creator_history (
                id, userId, userEmail, contentType, topic, tone, style,
                prompt, generatedContent, imageUrls, timestamp
            ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
        `, [
            historyData.id,
            historyData.userId,
            historyData.userEmail,
            historyData.contentType,
            historyData.topic,
            historyData.tone,
            historyData.style,
            historyData.prompt,
            historyData.generatedContent,
            historyData.imageUrls,
            historyData.timestamp
        ], function(err) {
            if (err) {
                console.error('Error saving creator history:', err);
                return res.status(500).json({ error: 'Failed to save creator history' });
            }

            res.status(201).json({
                success: true,
                entry: historyData
            });
        });
    } catch (error) {
        console.error('Creator history submission error:', error);
        res.status(500).json({ error: 'Failed to submit creator history' });
    }
});

// GET /api/creator-history - Get creator history for user
app.get('/api/creator-history', authenticateToken, async (req, res) => {
    try {
        const userId = req.user.id;
        const limit = parseInt(req.query.limit) || 25;

        db.all(`
            SELECT 
                id, userId, userEmail, contentType, topic, tone, style,
                prompt, generatedContent, imageUrls, timestamp
            FROM creator_history
            WHERE userId = ?
            ORDER BY datetime(timestamp) DESC
            LIMIT ?
        `, [userId, limit], (err, rows) => {
            if (err) {
                console.error('Error fetching creator history:', err);
                return res.status(500).json({ error: 'Failed to fetch creator history' });
            }

            const history = rows.map(row => ({
                id: row.id,
                contentType: row.contentType,
                topic: row.topic || undefined,
                tone: row.tone || undefined,
                style: row.style || undefined,
                prompt: row.prompt || undefined,
                generatedContent: row.generatedContent || undefined,
                imageUrls: row.imageUrls ? JSON.parse(row.imageUrls) : undefined,
                timestamp: row.timestamp
            }));

            res.json({
                history,
                timestamp: new Date().toISOString()
            });
        });
    } catch (error) {
        console.error('Creator history fetch error:', error);
        res.status(500).json({ error: 'Failed to fetch creator history' });
    }
});

// GET /api/user-preferences - Get user preferences
app.get('/api/user-preferences', authenticateToken, async (req, res) => {
    try {
        const userId = req.user.id;

        db.get(`
            SELECT shortcuts, avatar
            FROM user_preferences
            WHERE userId = ?
        `, [userId], (err, row) => {
            if (err) {
                console.error('Error fetching user preferences:', err);
                return res.status(500).json({ error: 'Failed to fetch user preferences' });
            }

            if (!row) {
                return res.json({
                    shortcuts: null,
                    avatar: null
                });
            }

            res.json({
                shortcuts: row.shortcuts ? JSON.parse(row.shortcuts) : null,
                avatar: row.avatar || null
            });
        });
    } catch (error) {
        console.error('User preferences fetch error:', error);
        res.status(500).json({ error: 'Failed to fetch user preferences' });
    }
});

// PUT /api/user-preferences - Update user preferences
app.put('/api/user-preferences', authenticateToken, async (req, res) => {
    try {
        const userId = req.user.id;
        const { shortcuts, avatar } = req.body;

        db.run(`
            INSERT INTO user_preferences (userId, shortcuts, avatar, updatedAt)
            VALUES (?, ?, ?, CURRENT_TIMESTAMP)
            ON CONFLICT(userId) DO UPDATE SET
                shortcuts = COALESCE(?, shortcuts),
                avatar = COALESCE(?, avatar),
                updatedAt = CURRENT_TIMESTAMP
        `, [
            userId,
            shortcuts ? JSON.stringify(shortcuts) : null,
            avatar || null,
            shortcuts ? JSON.stringify(shortcuts) : null,
            avatar || null
        ], function(err) {
            if (err) {
                console.error('Error updating user preferences:', err);
                return res.status(500).json({ error: 'Failed to update user preferences' });
            }

            res.json({
                success: true,
                message: 'User preferences updated successfully'
            });
        });
    } catch (error) {
        console.error('User preferences update error:', error);
        res.status(500).json({ error: 'Failed to update user preferences' });
    }
});

// GET /api/user-service-assignments - Get service assignments (all for admin, own for regular users)
app.get('/api/user-service-assignments', authenticateToken, async (req, res) => {
    try {
        const isAdmin = req.user.role === 'Administrator';
        const userEmail = req.user.email;
        
        // Build query: admins get all, regular users get only their own
        let query = `
            SELECT userEmail, serviceType, projectId, progress, dueDate, assignedAt, createdAt
            FROM user_service_assignments
        `;
        
        const queryParams = [];
        
        if (!isAdmin) {
            // Regular users: only their own assignments (case-insensitive comparison)
            query += ` WHERE LOWER(userEmail) = LOWER(?)`;
            queryParams.push(userEmail);
        }
        
        query += ` ORDER BY createdAt DESC`;

        db.all(query, queryParams, (err, rows) => {
            if (err) {
                console.error('Error fetching service assignments:', err);
                return res.status(500).json({ error: 'Failed to fetch service assignments' });
            }

            console.log('[GET /api/user-service-assignments] Found', rows.length, 'assignments for user:', userEmail, 'isAdmin:', isAdmin);
            if (rows.length > 0) {
                console.log('[GET /api/user-service-assignments] Sample assignments:', rows.slice(0, 3).map(r => ({
                    userEmail: r.userEmail,
                    serviceType: r.serviceType,
                    projectId: r.projectId
                })));
            }

            const assignments = rows.map(row => ({
                email: row.userEmail,
                serviceType: row.serviceType,
                projectId: row.projectId || undefined,
                progress: row.progress || 0,
                dueDate: row.dueDate || undefined,
                assignedAt: row.assignedAt || row.createdAt || new Date().toISOString()
            }));

            res.json({
                assignments,
                timestamp: new Date().toISOString()
            });
        });
    } catch (error) {
        console.error('Service assignments fetch error:', error);
        res.status(500).json({ error: 'Failed to fetch service assignments' });
    }
});

// POST /api/user-service-assignments - Create service assignment (admin only)
app.post('/api/user-service-assignments', authenticateToken, async (req, res) => {
    try {
        // Check if user is admin
        if (req.user.role !== 'Administrator') {
            return res.status(403).json({ error: 'Access denied. Admin only.' });
        }

        const { userEmail, serviceType, projectId, progress, dueDate, assignedAt } = req.body;

        if (!userEmail || !serviceType) {
            return res.status(400).json({ error: 'Missing required fields: userEmail, serviceType' });
        }

        const assignmentDate = assignedAt || new Date().toISOString();

        console.log('[POST /api/user-service-assignments] Creating assignment:', {
            userEmail,
            serviceType,
            projectId: projectId || null,
            progress: progress || 0,
            dueDate: dueDate || null
        });

        // Check if an assignment with this projectId already exists for this user
        // If yes, update it. If no, insert a new one.
        // This allows multiple projects of the same serviceType per user
        db.get(`
            SELECT id FROM user_service_assignments 
            WHERE userEmail = ? AND projectId = ?
        `, [userEmail, projectId || null], (err, existing) => {
            if (err) {
                console.error('Error checking existing assignment:', err);
                return res.status(500).json({ error: 'Failed to check service assignment' });
            }
            
            if (existing) {
                // Update existing assignment with same projectId
                db.run(`
                    UPDATE user_service_assignments 
                    SET serviceType = ?, progress = ?, dueDate = ?, assignedAt = ?
                    WHERE userEmail = ? AND projectId = ?
                `, [
                    serviceType,
                    progress || 0,
                    dueDate || null,
                    assignmentDate,
                    userEmail,
                    projectId || null
                ], function(updateErr) {
                    if (updateErr) {
                        console.error('Error updating service assignment:', updateErr);
                        return res.status(500).json({ error: 'Failed to update service assignment' });
                    }
                    
                    console.log('[POST /api/user-service-assignments] Successfully updated assignment:', {
                        userEmail,
                        serviceType,
                        projectId: projectId || null,
                        changes: this.changes
                    });

                    res.status(200).json({
                        success: true,
                        assignment: { 
                            email: userEmail, 
                            serviceType, 
                            projectId: projectId || undefined,
                            progress: progress || 0,
                            dueDate: dueDate || undefined,
                            assignedAt: assignmentDate
                        }
                    });
                });
            } else {
                // Insert new assignment
                // After migration, UNIQUE constraint is (userEmail, projectId)
                // So multiple projects of same serviceType are allowed
                db.run(`
                    INSERT INTO user_service_assignments (userEmail, serviceType, projectId, progress, dueDate, assignedAt)
                    VALUES (?, ?, ?, ?, ?, ?)
                `, [
                    userEmail, 
                    serviceType, 
                    projectId || null, 
                    progress || 0, 
                    dueDate || null, 
                    assignmentDate
                ], function(insertErr) {
                    if (insertErr) {
                        // If error is due to old UNIQUE constraint, the migration might not have run yet
                        // Log the error and suggest restarting the server
                        if (insertErr.message && insertErr.message.includes('UNIQUE constraint')) {
                            console.error('[POST /api/user-service-assignments] UNIQUE constraint error - migration may not have completed. Error:', insertErr.message);
                            return res.status(500).json({ 
                                error: 'Database constraint error. Please restart the server to run migration.' 
                            });
                        }
                        console.error('Error creating service assignment:', insertErr);
                        return res.status(500).json({ error: 'Failed to create service assignment' });
                    }
                    
                    console.log('[POST /api/user-service-assignments] Successfully created new assignment:', {
                        userEmail,
                        serviceType,
                        projectId: projectId || null,
                        changes: this.changes
                    });

                    res.status(201).json({
                        success: true,
                        assignment: { 
                            email: userEmail, 
                            serviceType, 
                            projectId: projectId || undefined,
                            progress: progress || 0,
                            dueDate: dueDate || undefined,
                            assignedAt: assignmentDate
                        }
                    });
                });
            }
        });
    } catch (error) {
        console.error('Service assignment creation error:', error);
        res.status(500).json({ error: 'Failed to create service assignment' });
    }
});

// DELETE /api/user-service-assignments - Delete service assignment (admin only)
app.delete('/api/user-service-assignments', authenticateToken, async (req, res) => {
    try {
        // Check if user is admin
        if (req.user.role !== 'Administrator') {
            return res.status(403).json({ error: 'Access denied. Admin only.' });
        }

        const { userEmail, serviceType } = req.body;

        if (!userEmail || !serviceType) {
            return res.status(400).json({ error: 'Missing required fields' });
        }

        db.run(`
            DELETE FROM user_service_assignments
            WHERE userEmail = ? AND serviceType = ?
        `, [userEmail, serviceType], function(err) {
            if (err) {
                console.error('Error deleting service assignment:', err);
                return res.status(500).json({ error: 'Failed to delete service assignment' });
            }

            if (this.changes === 0) {
                return res.status(404).json({ error: 'Assignment not found' });
            }

            res.json({
                success: true,
                message: 'Service assignment deleted successfully'
            });
        });
    } catch (error) {
        console.error('Service assignment deletion error:', error);
        res.status(500).json({ error: 'Failed to delete service assignment' });
    }
});

// Middleware to log ALL /api/management requests
app.use('/api/management', (req, res, next) => {
    next();
});

// Test endpoint to verify routing works
app.get('/api/management/test', (req, res) => {
    res.json({ message: 'Admin routes are working' });
});

// Test endpoint without auth to verify routing
app.get('/api/management/test-no-auth', (req, res) => {
    res.json({ message: 'Routing works without auth' });
});

// Admin: Get all users - Using simpler path to avoid routing conflicts
app.get('/api/admin/users', authenticateToken, async (req, res) => {
    try {
        const userId = req.user.id;
        const userEmail = req.user.email;
        
        // Check if user is admin - check both database and JWT token role
        const user = await getUserById(userId);
        const jwtRole = req.user.role;
        
        // Log for debugging
        console.log(`[GET /api/admin/users] User check - ID: ${userId}, Email: ${userEmail}, DB Role: ${user?.role || 'null'}, JWT Role: ${jwtRole || 'null'}`);
        
        // Check role from database first, fallback to JWT token role
        const userRole = user?.role || jwtRole;
        
        if (!user || (userRole !== 'Administrator' && jwtRole !== 'Administrator')) {
            console.error(`Unauthorized admin access attempt - User ID: ${userId}, Email: ${userEmail}, DB Role: ${user?.role || 'unknown'}, JWT Role: ${jwtRole || 'unknown'}`);
            return res.status(403).json({ error: 'Unauthorized - Admin access required' });
        }
        
        // Get all users (without passwords)
        db.all(`
            SELECT 
                id,
                email,
                name,
                company,
                role,
                emailVerified,
                avatar,
                createdAt,
                updatedAt
            FROM users
            ORDER BY createdAt DESC
        `, [], (err, users) => {
            if (err) {
                console.error('Error fetching users:', err);
                return res.status(500).json({ error: 'Failed to fetch users' });
            }
            
            console.log(`Admin users list accessed by user ${userId} - ${users.length} users returned`);
            res.json({
                users: users.map(u => ({
                    id: u.id,
                    email: u.email,
                    name: u.name,
                    company: u.company,
                    role: u.role || 'Member',
                    emailVerified: u.emailVerified === 1,
                    avatar: u.avatar,
                    createdAt: u.createdAt,
                    updatedAt: u.updatedAt
                }))
            });
        });
    } catch (error) {
        console.error('Admin users error:', error);
        res.status(500).json({ error: 'Failed to fetch users' });
    }
});

// Admin endpoint to delete a user and all related data
app.delete('/api/admin/users/:userId', authenticateToken, async (req, res) => {
    try {
        const adminUserId = req.user.id;
        const targetUserId = req.params.userId;
        
        // Check if admin user is admin
        const adminUser = await getUserById(adminUserId);
        const jwtRole = req.user.role;
        const userRole = adminUser?.role || jwtRole;
        
        if (!adminUser || (userRole !== 'Administrator' && jwtRole !== 'Administrator')) {
            console.error(`Unauthorized admin access attempt - User ID: ${adminUserId}, Role: ${userRole || 'unknown'}`);
            return res.status(403).json({ error: 'Unauthorized - Admin access required' });
        }
        
        // Prevent self-deletion
        if (String(adminUserId) === String(targetUserId)) {
            return res.status(400).json({ error: 'Cannot delete your own account' });
        }
        
        // Get target user to verify they exist
        const targetUser = await getUserById(targetUserId);
        if (!targetUser) {
            return res.status(404).json({ error: 'User not found' });
        }
        
        const targetUserEmail = targetUser.email;
        
        // Wrap all deletions in a transaction-like pattern (SQLite doesn't support transactions with multiple statements easily)
        // Delete related data first, then the user
        
        // 1. Delete ticket_replies for tickets belonging to this user
        db.run(`DELETE FROM ticket_replies WHERE ticketId IN (SELECT id FROM tickets WHERE userId = ?)`, [targetUserId], (err) => {
            if (err && !err.message.includes('no such table')) {
                console.error('Error deleting ticket replies:', err);
            }
        });
        
        // 2. Delete project_files for projects belonging to this user
        db.run(`DELETE FROM project_files WHERE projectId IN (SELECT id FROM projects WHERE userId = ?)`, [targetUserId], (err) => {
            if (err && !err.message.includes('no such table')) {
                console.error('Error deleting project files:', err);
            }
        });
        
        // 3. Delete invoices for projects belonging to this user
        db.run(`DELETE FROM invoices WHERE projectId IN (SELECT id FROM projects WHERE userId = ?)`, [targetUserId], (err) => {
            if (err && !err.message.includes('no such table')) {
                console.error('Error deleting invoices:', err);
            }
        });
        
        // 4. Delete project_history for projects belonging to this user
        db.run(`DELETE FROM project_history WHERE projectId IN (SELECT id FROM projects WHERE userId = ?)`, [targetUserId], (err) => {
            if (err && !err.message.includes('no such table')) {
                console.error('Error deleting project history:', err);
            }
        });
        
        // 5. Delete activities for projects belonging to this user
        db.run(`DELETE FROM activities WHERE projectId IN (SELECT id FROM projects WHERE userId = ?)`, [targetUserId], (err) => {
            if (err && !err.message.includes('no such table')) {
                console.error('Error deleting activities by project:', err);
            }
        });
        
        // 6. Delete tables with userId field
        const tablesWithUserId = [
            'activities', 'push_tokens', 'project_history', 'ai_chat_messages',
            'project_requests', 'agent_requests', 'tool_history', 'creator_history',
            'user_preferences', 'tickets', 'projects'
        ];
        
        tablesWithUserId.forEach(tableName => {
            db.run(`DELETE FROM ${tableName} WHERE userId = ?`, [targetUserId], (err) => {
                if (err && !err.message.includes('no such table') && !err.message.includes('no such column')) {
                    console.error(`Error deleting from ${tableName}:`, err);
                }
            });
        });
        
        // 7. Delete tables with userEmail field (using lowercase comparison)
        const tablesWithUserEmail = [
            'activities', 'project_requests', 'agent_requests', 'tool_history',
            'creator_history', 'user_service_assignments'
        ];
        
        tablesWithUserEmail.forEach(tableName => {
            db.run(`DELETE FROM ${tableName} WHERE LOWER(userEmail) = LOWER(?)`, [targetUserEmail], (err) => {
                if (err && !err.message.includes('no such table') && !err.message.includes('no such column')) {
                    console.error(`Error deleting from ${tableName} by email:`, err);
                }
            });
        });
        
        // 8. Finally, delete the user
        db.run('DELETE FROM users WHERE id = ?', [targetUserId], function(err) {
            if (err) {
                console.error('Error deleting user:', err);
                return res.status(500).json({ error: 'Failed to delete user' });
            }
            
            if (this.changes === 0) {
                return res.status(404).json({ error: 'User not found' });
            }
            
            console.log(`Admin ${adminUserId} deleted user ${targetUserId} (${targetUserEmail})`);
            res.json({
                success: true,
                message: 'User deleted successfully',
                deletedUserId: targetUserId
            });
        });
    } catch (error) {
        console.error('Delete user error:', error);
        res.status(500).json({ error: 'Failed to delete user' });
    }
});

// Admin endpoint to clear all activities/notifications (for database reset)
app.delete('/api/admin/clear-notifications', authenticateToken, async (req, res) => {
    try {
        const userId = req.user.id;
        
        // Check if user is admin
        const user = await getUserById(userId);
        if (!user || user.role !== 'Administrator') {
            console.error(`Unauthorized admin access attempt - User ID: ${userId}, Role: ${user?.role || 'unknown'}`);
            return res.status(403).json({ error: 'Unauthorized - Admin access required' });
        }
        
        // Delete all activities
        db.run('DELETE FROM activities', [], function(err) {
            if (err) {
                console.error('Error clearing activities:', err);
                return res.status(500).json({ error: 'Failed to clear notifications' });
            }
            
            console.log(`Admin cleared all activities - ${this.changes} rows deleted by user ${userId}`);
            res.json({
                success: true,
                message: 'All notifications cleared',
                deleted: this.changes
            });
        });
    } catch (error) {
        console.error('Clear notifications error:', error);
        res.status(500).json({ error: 'Failed to clear notifications' });
    }
});

// Redirect short URL - MUST be after all API routes
// This catch-all route handles short URL redirects
// IMPORTANT: This route only matches single-segment paths (e.g., /abc, not /api/management/users)
app.get('/:slug', (req, res) => {
    const { slug } = req.params;
    
    console.log(`🔗 Short URL access attempt: ${req.method} ${req.path} (slug: "${slug}")`);
    
    // Skip API routes and other known paths
    if (slug.startsWith('api') || slug === 'favicon.ico' || slug.includes('.')) {
        console.log(`⚠️ 404: API route not found: ${req.method} ${req.path} (slug: ${slug})`);
        return res.status(404).json({ error: 'Not found' });
    }
    
    db.get('SELECT * FROM short_urls WHERE slug = ?', [slug], (err, row) => {
        if (err) {
            console.error(`❌ Database error looking up slug "${slug}":`, err.message);
            return res.status(500).json({ error: 'Database error' });
        }
        
        if (!row) {
            console.log(`⚠️ Slug "${slug}" not found in database`);
            return res.status(404).send(`
                <!DOCTYPE html>
                <html>
                <head>
                    <title>404 - Short URL Not Found</title>
                    <style>
                        body { font-family: Arial, sans-serif; text-align: center; padding: 50px; }
                        h1 { color: #333; }
                        p { color: #666; }
                    </style>
                </head>
                <body>
                    <h1>404 - Short URL Not Found</h1>
                    <p>The short URL you're looking for doesn't exist.</p>
                </body>
                </html>
            `);
        }
        
        console.log(`✅ Slug "${slug}" found, redirecting to: ${row.original_url}`);
        
        // Update click count
        db.run('UPDATE short_urls SET click_count = click_count + 1 WHERE slug = ?', [slug], (err) => {
            if (err) console.error('Error updating click count:', err);
        });
        
        // Redirect to original URL
        res.redirect(301, row.original_url);
    });
});

// Get short URL stats (optional admin endpoint)
app.get('/api/tools/short-url/:slug', (req, res) => {
    const { slug } = req.params;
    
    db.get('SELECT * FROM short_urls WHERE slug = ?', [slug], (err, row) => {
        if (err) {
            return res.status(500).json({ error: 'Database error' });
        }
        
        if (!row) {
            return res.status(404).json({ error: 'Short URL not found' });
        }
        
        res.json({
            slug: row.slug,
            originalUrl: row.original_url,
            shortUrl: `https://infi.live/${row.slug}`,
            clickCount: row.click_count,
            createdAt: row.created_at,
            isCustom: row.custom_slug === 1
        });
    });
});

// Helper function to check domain availability using WHOIS
async function checkDomainWithWhois(domain) {
    try {
        const whoisData = await whoisLookup(domain);
        const whoisText = whoisData.toString();
        const lowerText = whoisText.toLowerCase();
        const lines = whoisText.split('\n');
        
        // Check if WHOIS package doesn't support this TLD
        if (lowerText.includes('tld is not supported') || lowerText.includes('not supported')) {
            // ALWAYS use DNS lookup as fallback for unsupported TLDs
            // DNS records are the most reliable indicator of registration
            try {
                console.log(`[WHOIS] TLD not supported for ${domain}, checking DNS...`);
                
                // Try to resolve DNS records - use allSettled to handle individual failures
                const dnsPromises = [
                    dns.resolve4(domain).catch(() => null),
                    dns.resolve6(domain).catch(() => null),
                    dns.resolveMx(domain).catch(() => null),
                    dns.resolveNs(domain).catch(() => null),
                    dns.resolveTxt(domain).catch(() => null)
                ];
                
                const records = await Promise.allSettled(dnsPromises);
                
                // Check if any DNS records exist - be more explicit
                let hasDnsRecords = false;
                let foundRecordType = '';
                for (let i = 0; i < records.length; i++) {
                    const result = records[i];
                    if (result.status === 'fulfilled' && result.value !== null) {
                        if (Array.isArray(result.value)) {
                            if (result.value.length > 0) {
                                hasDnsRecords = true;
                                const types = ['A', 'AAAA', 'MX', 'NS', 'TXT'];
                                foundRecordType = types[i];
                                console.log(`[WHOIS] Found ${foundRecordType} record for ${domain}:`, result.value);
                                break;
                            }
                        } else if (result.value) {
                            hasDnsRecords = true;
                            const types = ['A', 'AAAA', 'MX', 'NS', 'TXT'];
                            foundRecordType = types[i];
                            console.log(`[WHOIS] Found ${foundRecordType} record for ${domain}:`, result.value);
                            break;
                        }
                    }
                }
                
                if (hasDnsRecords) {
                    console.log(`[WHOIS] Domain ${domain} has DNS records (${foundRecordType}), returning TAKEN`);
                    return 'taken'; // Domain has DNS records, definitely registered - RETURN IMMEDIATELY
                }
                
                // No DNS records found - domain is likely available
                console.log(`[WHOIS] Domain ${domain} has no DNS records, returning AVAILABLE`);
                return 'available';
                
            } catch (dnsError) {
                // DNS lookup failed completely - be conservative and assume available
                console.error('[WHOIS] DNS fallback failed for', domain, dnsError.message);
                return 'available';
            }
        }
        
        // FIRST: Check for registration indicators (these are most reliable for "taken")
        // If we find ANY registration data, the domain is definitely taken
        let hasRegistrar = false;
        let hasCreationDate = false;
        let hasExpiryDate = false;
        let hasNameServers = false;
        let hasStatus = false;
        let hasRegistrant = false;
        let hasUpdatedDate = false;
        let nameServerCount = 0;
        
        for (const line of lines) {
            const lowerLine = line.toLowerCase().trim();
            if (!lowerLine || lowerLine.startsWith('%') || lowerLine.startsWith('#')) continue;
            
            // Check for registrar (multiple patterns)
            if ((lowerLine.includes('registrar:') || lowerLine.includes('registrar name:') || 
                 lowerLine.includes('registrar iana id:') || lowerLine.includes('sponsoring registrar:')) && !hasRegistrar) {
                const parts = line.split(':');
                if (parts.length > 1) {
                    const value = parts.slice(1).join(':').trim();
                    if (value && value.length > 2 && 
                        !value.toLowerCase().includes('not available') && 
                        !value.toLowerCase().includes('n/a') &&
                        !value.toLowerCase().includes('none') &&
                        value !== 'N/A' && value !== 'NONE') {
                        hasRegistrar = true;
                    }
                }
            }
            
            // Check for creation date (multiple patterns)
            if ((lowerLine.includes('creation date:') || lowerLine.includes('created:') || 
                 lowerLine.includes('registered on:') || lowerLine.includes('registration date:') ||
                 lowerLine.includes('domain registration date:') || lowerLine.includes('domain created:')) && !hasCreationDate) {
                const parts = line.split(':');
                if (parts.length > 1) {
                    const value = parts.slice(1).join(':').trim();
                    // Check if it looks like a date (has numbers and common date separators)
                    if (value && value.length > 5 && 
                        (value.match(/\d{4}/) || value.match(/\d{2}[-\/]\d{2}/)) &&
                        !value.toLowerCase().includes('not available') && 
                        !value.toLowerCase().includes('n/a') &&
                        !value.toLowerCase().includes('none')) {
                        hasCreationDate = true;
                    }
                }
            }
            
            // Check for expiry date (multiple patterns)
            if ((lowerLine.includes('expiry date:') || lowerLine.includes('expires:') || 
                 lowerLine.includes('expiration date:') || lowerLine.includes('registry expiry date:') ||
                 lowerLine.includes('domain expiration date:') || lowerLine.includes('expiration:')) && !hasExpiryDate) {
                const parts = line.split(':');
                if (parts.length > 1) {
                    const value = parts.slice(1).join(':').trim();
                    // Check if it looks like a date
                    if (value && value.length > 5 && 
                        (value.match(/\d{4}/) || value.match(/\d{2}[-\/]\d{2}/)) &&
                        !value.toLowerCase().includes('not available') && 
                        !value.toLowerCase().includes('n/a') &&
                        !value.toLowerCase().includes('none')) {
                        hasExpiryDate = true;
                    }
                }
            }
            
            // Check for updated date
            if ((lowerLine.includes('updated date:') || lowerLine.includes('modified:') || 
                 lowerLine.includes('last updated:') || lowerLine.includes('last modified:')) && !hasUpdatedDate) {
                const parts = line.split(':');
                if (parts.length > 1) {
                    const value = parts.slice(1).join(':').trim();
                    if (value && value.length > 5 && 
                        (value.match(/\d{4}/) || value.match(/\d{2}[-\/]\d{2}/)) &&
                        !value.toLowerCase().includes('not available') && 
                        !value.toLowerCase().includes('n/a')) {
                        hasUpdatedDate = true;
                    }
                }
            }
            
            // Check for name servers (count them, not just boolean)
            if (lowerLine.includes('name server:') || lowerLine.includes('nameserver:') || 
                lowerLine.includes('nserver:') || lowerLine.includes('dns:') ||
                lowerLine.includes('name servers:')) {
                const parts = line.split(':');
                if (parts.length > 1) {
                    const ns = parts.slice(1).join(':').trim().toLowerCase();
                    // Check if it's a valid name server format
                    if (ns && ns.includes('.') && ns.length > 3 &&
                        !ns.includes('not available') && !ns.includes('n/a') && 
                        !ns.includes('placeholder') && !ns.includes('none') &&
                        !ns.match(/^[\s\.]+$/)) { // Not just dots/spaces
                        nameServerCount++;
                        hasNameServers = true;
                    }
                }
            }
            
            // Check for status (but not HTTP status codes)
            if (lowerLine.includes('status:') && !lowerLine.includes('http') && !lowerLine.includes('https')) {
                const parts = line.split(':');
                if (parts.length > 1) {
                    const status = parts.slice(1).join(':').trim().toLowerCase();
                    // Common registered statuses - be more inclusive
                    if (status && (status.includes('ok') || status.includes('active') || 
                        status.includes('client') || status.includes('server') || 
                        status.includes('registered') || status.includes('paid') ||
                        status.includes('auto') || status.includes('transfer') ||
                        status.includes('renew') || status.includes('delete') ||
                        status.includes('redemption') || status.includes('pending'))) {
                        hasStatus = true;
                    }
                }
            }
            
            // Check for registrant info
            if ((lowerLine.includes('registrant:') || lowerLine.includes('registrant name:') ||
                 lowerLine.includes('registrant organization:') || lowerLine.includes('registrant country:')) && !hasRegistrant) {
                const parts = line.split(':');
                if (parts.length > 1) {
                    const value = parts.slice(1).join(':').trim();
                    if (value && value.length > 2 &&
                        !value.toLowerCase().includes('not available') && 
                        !value.toLowerCase().includes('n/a') &&
                        !value.toLowerCase().includes('none') &&
                        value !== 'N/A' && value !== 'NONE') {
                        hasRegistrant = true;
                    }
                }
            }
        }
        
        // If we have ANY registration indicator, domain is definitely TAKEN
        // This is the most reliable check - registration data is definitive
        if (hasRegistrar || hasCreationDate || hasExpiryDate || hasNameServers || hasStatus || hasRegistrant || hasUpdatedDate) {
            return 'taken';
        }
        
        // SECOND: Check for explicit "available" indicators
        // Only trust these if we found NO registration data above
        const availableIndicators = [
            'no match for',
            'not found',
            'no entries found',
            'no data found',
            'domain not found',
            'status: available',
            'status: free',
            'no such domain',
            'domain name not found',
            'domain is available for registration',
            'this domain is available'
        ];
        
        for (const indicator of availableIndicators) {
            if (lowerText.includes(indicator)) {
                // Double-check: make sure there are no name servers
                if (!lowerText.includes('name server') && !lowerText.includes('nameserver') && 
                    !lowerText.includes('nserver') && nameServerCount === 0) {
                    return 'available';
                }
            }
        }
        
        // THIRD: Check if WHOIS response is substantial
        // If we have substantial structured data but no clear indicators, likely registered
        const nonCommentLines = lines.filter(line => {
            const trimmed = line.trim();
            return trimmed && !trimmed.startsWith('%') && !trimmed.startsWith('#') && trimmed.length > 3;
        });
        
        if (nonCommentLines.length > 10) {
            // Check if there's structured data (key:value pairs with actual values)
            let structuredDataCount = 0;
            for (const line of nonCommentLines) {
                if (line.includes(':') && line.split(':').length > 1) {
                    const value = line.split(':').slice(1).join(':').trim();
                    if (value && value.length > 2 && 
                        !value.toLowerCase().includes('not available') && 
                        !value.toLowerCase().includes('n/a') &&
                        !value.toLowerCase().includes('none')) {
                        structuredDataCount++;
                    }
                }
            }
            // If we have multiple structured data fields, likely registered
            if (structuredDataCount > 3) {
                return 'taken';
            }
        }
        
        // If response is very short or empty, likely available
        if (nonCommentLines.length < 3) {
            return 'available';
        }
        
        // Default: if we can't determine, be conservative and assume taken
        // (better to show false positive for "taken" than false negative)
        return 'taken';
    } catch (error) {
        console.error('WHOIS lookup error:', error);
        return null; // Return null if WHOIS fails
    }
}

// Domain availability check endpoint (now uses WHOIS for accuracy)
app.post('/api/tools/domain-check', async (req, res) => {
    const { domain } = req.body;
    
    if (!domain || typeof domain !== 'string') {
        return res.status(400).json({ error: 'Domain is required' });
    }
    
    // Clean and validate domain format
    const cleanDomain = domain.trim().toLowerCase();
    
    // Basic domain format validation
    const domainRegex = /^([a-z0-9]+(-[a-z0-9]+)*\.)+[a-z]{2,}$/;
    if (!domainRegex.test(cleanDomain)) {
        return res.status(400).json({ error: 'Invalid domain format' });
    }
    
    try {
        // Use WHOIS for accurate results - this is the most reliable method
        let status = await checkDomainWithWhois(cleanDomain);
        
        // If WHOIS fails completely, we can't reliably determine status
        // Don't fall back to DNS as it's unreliable (domains can be registered without DNS)
        if (!status) {
            // If WHOIS lookup fails, we can't determine status accurately
            // Return 'unknown' or retry once more
            try {
                // Retry WHOIS once more
                status = await checkDomainWithWhois(cleanDomain);
                if (!status) {
                    // If still fails, default to 'available' but note it's uncertain
                    status = 'available';
                }
            } catch (retryError) {
                console.error('WHOIS retry failed:', retryError);
                status = 'available'; // Default to available if we can't check
            }
        }
        
        res.json({ status });
    } catch (error) {
        console.error('Domain check error:', error);
        // On error, default to "available" (safer assumption)
        res.json({ status: 'available' });
    }
});

// WHOIS lookup endpoint
app.post('/api/tools/whois-lookup', async (req, res) => {
    const { domain } = req.body;
    
    if (!domain || typeof domain !== 'string') {
        return res.status(400).json({ error: 'Domain is required' });
    }
    
    // Clean and validate domain format
    const cleanDomain = domain.trim().toLowerCase();
    
    // Basic domain format validation
    const domainRegex = /^([a-z0-9]+(-[a-z0-9]+)*\.)+[a-z]{2,}$/;
    if (!domainRegex.test(cleanDomain)) {
        return res.status(400).json({ error: 'Invalid domain format' });
    }
    
    try {
        let whoisData = await whoisLookup(cleanDomain);
        let whoisText = whoisData.toString();
        let lowerText = whoisText.toLowerCase();
        
        // Check if WHOIS package doesn't support this TLD
        // If so, try direct WHOIS query first, then DNS lookup as fallback
        let isRegisteredFromDns = null;
        if (lowerText.includes('tld is not supported') || lowerText.includes('not supported')) {
            console.log(`[WHOIS Lookup] Package doesn't support ${cleanDomain}, trying direct WHOIS query...`);
            
            // Try direct WHOIS query first to get actual data
            try {
                const directWhoisText = await queryWhoisDirectly(cleanDomain);
                if (directWhoisText && directWhoisText.length > 100 && 
                    !directWhoisText.toLowerCase().includes('tld is not supported')) {
                    // Got actual WHOIS data from direct query
                    whoisText = directWhoisText;
                    lowerText = whoisText.toLowerCase();
                    console.log(`[WHOIS Lookup] Got WHOIS data from direct query for ${cleanDomain}`);
                } else {
                    // Direct query also failed, use DNS lookup
                    console.log(`[WHOIS Lookup] Direct query failed for ${cleanDomain}, using DNS fallback`);
                    throw new Error('Direct query returned no data');
                }
            } catch (directError) {
                console.log(`[WHOIS Lookup] Direct WHOIS query failed: ${directError.message}`);
                
                // Fallback to DNS lookup to determine registration status
                try {
                    const dnsPromises = [
                        dns.resolve4(cleanDomain).catch(() => null),
                        dns.resolve6(cleanDomain).catch(() => null),
                        dns.resolveMx(cleanDomain).catch(() => null),
                        dns.resolveNs(cleanDomain).catch(() => null),
                        dns.resolveTxt(cleanDomain).catch(() => null)
                    ];
                    
                    const records = await Promise.allSettled(dnsPromises);
                    
                    // Check if any DNS records exist - be more explicit
                    let hasDnsRecords = false;
                    for (const result of records) {
                        if (result.status === 'fulfilled' && result.value !== null) {
                            if (Array.isArray(result.value)) {
                                if (result.value.length > 0) {
                                    hasDnsRecords = true;
                                    break;
                                }
                            } else if (result.value) {
                                hasDnsRecords = true;
                                break;
                            }
                        }
                    }
                    
                    isRegisteredFromDns = hasDnsRecords;
                    console.log(`[WHOIS Lookup] Domain ${cleanDomain} DNS check: ${hasDnsRecords ? 'TAKEN' : 'AVAILABLE'}`);
                } catch (dnsError) {
                    console.error('[WHOIS Lookup] DNS fallback failed for:', cleanDomain, dnsError.message);
                }
            }
        }
        
        // Parse WHOIS data into structured format
        const parsed = {
            domain: cleanDomain,
            registrar: null,
            registrarUrl: null,
            creationDate: null,
            expiryDate: null,
            updatedDate: null,
            nameServers: [],
            status: [],
            registrant: null,
            registrantOrganization: null,
            registrantCountry: null,
            adminContact: null,
            techContact: null,
            isRegistered: false
        };
        
        // Parse common WHOIS fields with better extraction
        const lines = whoisText.split('\n');
        // lowerText already declared above
        
        // First, parse all the fields
        for (let i = 0; i < lines.length; i++) {
            const line = lines[i].trim();
            if (!line || line.startsWith('%') || line.startsWith('#')) continue;
            
            const lowerLine = line.toLowerCase();
            
            // Registrar
            if ((lowerLine.includes('registrar:') || lowerLine.includes('registrar name:')) && !parsed.registrar) {
                const match = line.match(/registrar(?: name)?:\s*(.+)/i);
                if (match) parsed.registrar = match[1].trim();
            }
            
            // Registrar URL
            if (lowerLine.includes('registrar url:') || lowerLine.includes('registrar website:')) {
                const match = line.match(/registrar\s*(?:url|website):\s*(.+)/i);
                if (match) parsed.registrarUrl = match[1].trim();
            }
            
            // Creation Date (multiple formats)
            if ((lowerLine.includes('creation date:') || lowerLine.includes('created:') || 
                 lowerLine.includes('registered on:') || lowerLine.includes('registration date:')) && !parsed.creationDate) {
                const match = line.match(/(?:creation|registered|registration)\s*(?:date|on):\s*(.+)/i);
                if (match) parsed.creationDate = match[1].trim();
            }
            
            // Expiry Date
            if ((lowerLine.includes('expiry date:') || lowerLine.includes('expires:') || 
                 lowerLine.includes('expiration date:') || lowerLine.includes('registry expiry date:')) && !parsed.expiryDate) {
                const match = line.match(/(?:expiry|expiration|expires)\s*(?:date)?:\s*(.+)/i);
                if (match) parsed.expiryDate = match[1].trim();
            }
            
            // Updated Date
            if ((lowerLine.includes('updated date:') || lowerLine.includes('modified:') || 
                 lowerLine.includes('last updated:')) && !parsed.updatedDate) {
                const match = line.match(/(?:updated|modified|last updated)\s*(?:date)?:\s*(.+)/i);
                if (match) parsed.updatedDate = match[1].trim();
            }
            
            // Name Servers
            if (lowerLine.includes('name server:') || lowerLine.includes('nameserver:') || 
                lowerLine.includes('nserver:') || lowerLine.includes('dns:')) {
                const match = line.match(/(?:name\s*server|nameserver|nserver|dns):\s*(.+)/i);
                if (match) {
                    const ns = match[1].trim().toLowerCase().split(/\s+/)[0];
                    if (ns && !parsed.nameServers.includes(ns)) {
                        parsed.nameServers.push(ns);
                    }
                }
            }
            
            // Status
            if (lowerLine.includes('status:') && !lowerLine.includes('http') && !lowerLine.includes('https')) {
                const match = line.match(/status:\s*(.+)/i);
                if (match) {
                    const status = match[1].trim();
                    if (status && !parsed.status.includes(status)) {
                        parsed.status.push(status);
                    }
                }
            }
            
            // Registrant
            if (lowerLine.includes('registrant:') || lowerLine.includes('registrant name:')) {
                const match = line.match(/registrant(?:\s+name)?:\s*(.+)/i);
                if (match) parsed.registrant = match[1].trim();
            }
            
            // Registrant Organization
            if (lowerLine.includes('registrant organization:') || lowerLine.includes('organization:')) {
                const match = line.match(/(?:registrant\s+)?organization:\s*(.+)/i);
                if (match) parsed.registrantOrganization = match[1].trim();
            }
            
            // Registrant Country
            if (lowerLine.includes('registrant country:') || lowerLine.includes('country:')) {
                const match = line.match(/(?:registrant\s+)?country:\s*(.+)/i);
                if (match) parsed.registrantCountry = match[1].trim();
            }
        }
        
        // If we used DNS fallback and didn't get name servers from WHOIS, get them from DNS
        if (isRegisteredFromDns !== null && parsed.nameServers.length === 0) {
            try {
                const nsRecords = await dns.resolveNs(cleanDomain).catch(() => null);
                if (nsRecords && Array.isArray(nsRecords) && nsRecords.length > 0) {
                    parsed.nameServers = nsRecords.map(ns => ns.toLowerCase());
                    console.log(`[WHOIS Lookup] Extracted ${parsed.nameServers.length} name servers from DNS for ${cleanDomain}`);
                    
                    // Try to infer registrar from name servers
                    let registrarWhoisServer = null;
                    const nsString = parsed.nameServers.join(' ');
                    
                    if (!parsed.registrar) {
                        // Common registrar name server patterns
                        if (nsString.includes('domaincontrol.com') || nsString.includes('domaincontrol')) {
                            parsed.registrar = 'GoDaddy';
                            parsed.registrarUrl = 'https://www.godaddy.com';
                            registrarWhoisServer = 'whois.godaddy.com';
                        } else if (nsString.includes('namecheap') || nsString.includes('registrar-servers.com')) {
                            parsed.registrar = 'Namecheap';
                            parsed.registrarUrl = 'https://www.namecheap.com';
                            registrarWhoisServer = 'whois.namecheap.com';
                        } else if (nsString.includes('cloudflare') || nsString.includes('cloudflare.com')) {
                            parsed.registrar = 'Cloudflare';
                            parsed.registrarUrl = 'https://www.cloudflare.com';
                            registrarWhoisServer = 'whois.cloudflare.com';
                        } else if (nsString.includes('google') || nsString.includes('googledomains')) {
                            parsed.registrar = 'Google Domains';
                            parsed.registrarUrl = 'https://domains.google';
                            registrarWhoisServer = 'whois.google.com';
                        } else if (nsString.includes('namesilo') || nsString.includes('namesilo.com')) {
                            parsed.registrar = 'NameSilo';
                            parsed.registrarUrl = 'https://www.namesilo.com';
                            registrarWhoisServer = 'whois.namesilo.com';
                        } else if (nsString.includes('dynadot') || nsString.includes('dynadot.com')) {
                            parsed.registrar = 'Dynadot';
                            parsed.registrarUrl = 'https://www.dynadot.com';
                            registrarWhoisServer = 'whois.dynadot.com';
                        } else if (nsString.includes('porkbun') || nsString.includes('porkbun.com')) {
                            parsed.registrar = 'Porkbun';
                            parsed.registrarUrl = 'https://porkbun.com';
                            registrarWhoisServer = 'whois.porkbun.com';
                        }
                    } else {
                        // Registrar already detected, determine WHOIS server
                        const registrarLower = parsed.registrar.toLowerCase();
                        if (registrarLower.includes('godaddy')) {
                            registrarWhoisServer = 'whois.godaddy.com';
                        } else if (registrarLower.includes('namecheap')) {
                            registrarWhoisServer = 'whois.namecheap.com';
                        } else if (registrarLower.includes('cloudflare')) {
                            registrarWhoisServer = 'whois.cloudflare.com';
                        } else if (registrarLower.includes('google')) {
                            registrarWhoisServer = 'whois.google.com';
                        } else if (registrarLower.includes('namesilo')) {
                            registrarWhoisServer = 'whois.namesilo.com';
                        } else if (registrarLower.includes('dynadot')) {
                            registrarWhoisServer = 'whois.dynadot.com';
                        } else if (registrarLower.includes('porkbun')) {
                            registrarWhoisServer = 'whois.porkbun.com';
                        }
                    }
                    
                    // If we detected a registrar and don't have dates, try querying registrar's WHOIS server
                    if (registrarWhoisServer && (!parsed.creationDate || !parsed.expiryDate)) {
                        try {
                            console.log(`[WHOIS Lookup] Querying ${registrarWhoisServer} for dates...`);
                            const registrarWhoisText = await queryWhoisDirectly(cleanDomain, registrarWhoisServer);
                            if (registrarWhoisText && registrarWhoisText.length > 100) {
                                const registrarLines = registrarWhoisText.split('\n');
                                
                                // Parse dates from registrar WHOIS
                                for (const line of registrarLines) {
                                    const lowerLine = line.toLowerCase().trim();
                                    
                                    // Creation Date - handle "Creation Date: 2025-10-15T12:36:58Z" format
                                    if (!parsed.creationDate && (lowerLine.includes('creation date:') || 
                                        lowerLine.includes('created:') || 
                                        lowerLine.includes('domain created:'))) {
                                        // Try multiple regex patterns to handle different formats
                                        let match = line.match(/(?:creation|created|domain created)\s+date:\s*(.+)/i);
                                        if (!match) {
                                            match = line.match(/(?:creation|created|domain created)[\s:]+(.+)/i);
                                        }
                                        if (match) {
                                            let dateStr = match[1].trim();
                                            parsed.creationDate = dateStr;
                                            console.log(`[WHOIS Lookup] Found creation date: ${parsed.creationDate}`);
                                        }
                                    }
                                    
                                    // Expiry Date - handle "Registrar Registration Expiration Date: 2026-10-15T12:36:58Z" format
                                    if (!parsed.expiryDate && (lowerLine.includes('expiration date:') || 
                                        lowerLine.includes('expires:') || 
                                        lowerLine.includes('expiry date:') ||
                                        lowerLine.includes('registrar registration expiration date:'))) {
                                        // Try multiple regex patterns
                                        let match = line.match(/(?:expiration|expires|expiry|registrar registration expiration)\s+date:\s*(.+)/i);
                                        if (!match) {
                                            match = line.match(/(?:expiration|expires|expiry|registrar registration expiration)[\s:]+(.+)/i);
                                        }
                                        if (match) {
                                            let dateStr = match[1].trim();
                                            parsed.expiryDate = dateStr;
                                            console.log(`[WHOIS Lookup] Found expiry date: ${parsed.expiryDate}`);
                                        }
                                    }
                                    
                                    // Updated Date - handle "Updated Date: 2025-10-15T12:36:59Z" format
                                    if (!parsed.updatedDate && (lowerLine.includes('updated date:') || 
                                        lowerLine.includes('last updated:'))) {
                                        // Try multiple regex patterns
                                        let match = line.match(/(?:updated|last updated)\s+date:\s*(.+)/i);
                                        if (!match) {
                                            match = line.match(/(?:updated|last updated)[\s:]+(.+)/i);
                                        }
                                        if (match) {
                                            let dateStr = match[1].trim();
                                            parsed.updatedDate = dateStr;
                                            console.log(`[WHOIS Lookup] Found updated date: ${parsed.updatedDate}`);
                                        }
                                    }
                                    
                                    // Registrar - update with full official name from WHOIS response
                                    if (lowerLine.includes('registrar:') && !lowerLine.includes('registrar whois server') && 
                                        !lowerLine.includes('registrar url') && !lowerLine.includes('registrar iana id')) {
                                        const match = line.match(/registrar:\s*(.+)/i);
                                        if (match) {
                                            const registrarName = match[1].trim();
                                            // Use the full official name from WHOIS (e.g., "GoDaddy.com, LLC" instead of just "GoDaddy")
                                            if (registrarName && registrarName.length > 0) {
                                                parsed.registrar = registrarName;
                                                console.log(`[WHOIS Lookup] Updated registrar to: ${parsed.registrar}`);
                                            }
                                        }
                                    }
                                }
                            }
                        } catch (regError) {
                            console.log(`[WHOIS Lookup] Could not query registrar WHOIS: ${regError.message}`);
                        }
                    }
                }
            } catch (nsError) {
                console.log(`[WHOIS Lookup] Could not get NS records from DNS: ${nsError.message}`);
            }
        }
        
        // NOW determine if domain is registered - after parsing all fields
        // FIRST: Check for registration indicators (these are most reliable for "taken")
        // If we find ANY registration data, the domain is definitely taken
        const hasRegistrar = parsed.registrar && parsed.registrar.length > 2 && 
                            !parsed.registrar.toLowerCase().includes('not available') && 
                            !parsed.registrar.toLowerCase().includes('n/a') &&
                            !parsed.registrar.toLowerCase().includes('none') &&
                            parsed.registrar !== 'N/A' && parsed.registrar !== 'NONE';
        const hasCreationDate = parsed.creationDate && parsed.creationDate.length > 5 && 
                              !parsed.creationDate.toLowerCase().includes('not available') && 
                              !parsed.creationDate.toLowerCase().includes('n/a') &&
                              !parsed.creationDate.toLowerCase().includes('none') &&
                              (parsed.creationDate.match(/\d{4}/) || parsed.creationDate.match(/\d{2}[-\/]\d{2}/));
        const hasExpiryDate = parsed.expiryDate && parsed.expiryDate.length > 5 && 
                            !parsed.expiryDate.toLowerCase().includes('not available') && 
                            !parsed.expiryDate.toLowerCase().includes('n/a') &&
                            !parsed.expiryDate.toLowerCase().includes('none') &&
                            (parsed.expiryDate.match(/\d{4}/) || parsed.expiryDate.match(/\d{2}[-\/]\d{2}/));
        const hasRealNameServers = parsed.nameServers && parsed.nameServers.length > 0 && 
                                   parsed.nameServers.some(ns => {
                                       const lowerNs = ns.toLowerCase();
                                       return ns.includes('.') && ns.length > 3 &&
                                              !lowerNs.includes('not available') && 
                                              !lowerNs.includes('n/a') && 
                                              !lowerNs.includes('placeholder') &&
                                              !lowerNs.includes('none') &&
                                              !lowerNs.match(/^[\s\.]+$/);
                                   });
        const hasUpdatedDate = parsed.updatedDate && parsed.updatedDate.length > 5 && 
                              !parsed.updatedDate.toLowerCase().includes('not available') && 
                              !parsed.updatedDate.toLowerCase().includes('n/a') &&
                              (parsed.updatedDate.match(/\d{4}/) || parsed.updatedDate.match(/\d{2}[-\/]\d{2}/));
        const hasRegistrant = (parsed.registrant && parsed.registrant.length > 2) ||
                             (parsed.registrantOrganization && parsed.registrantOrganization.length > 2) ||
                             (parsed.registrantCountry && parsed.registrantCountry.length > 2);
        
        // Also check for status indicators in the parsed status array
        const hasRegisteredStatus = parsed.status && parsed.status.length > 0 && 
                                   parsed.status.some(s => {
                                       const lowerStatus = s.toLowerCase();
                                       return lowerStatus.includes('ok') || lowerStatus.includes('active') || 
                                              lowerStatus.includes('client') || lowerStatus.includes('server') || 
                                              lowerStatus.includes('registered') || lowerStatus.includes('paid') ||
                                              lowerStatus.includes('auto') || lowerStatus.includes('transfer') ||
                                              lowerStatus.includes('renew') || lowerStatus.includes('delete') ||
                                              lowerStatus.includes('redemption') || lowerStatus.includes('pending');
                                   });
        
        // If we have ANY registration indicator, domain is definitely TAKEN
        // This is the most reliable check - registration data is definitive
        if (hasRegistrar || hasCreationDate || hasExpiryDate || hasRealNameServers || hasRegisteredStatus || hasRegistrant || hasUpdatedDate) {
            parsed.isRegistered = true;
        } else {
            // SECOND: Check for explicit "available" indicators
            // Only trust these if we found NO registration data above
            const availableIndicators = [
                'no match for',
                'not found',
                'no entries found',
                'no data found',
                'domain not found',
                'status: available',
                'status: free',
                'no such domain',
                'domain name not found',
                'domain is available for registration',
                'this domain is available'
            ];
            
            let isAvailable = false;
            for (const indicator of availableIndicators) {
                if (lowerText.includes(indicator)) {
                    // Double-check: make sure there are no name servers
                    if (!lowerText.includes('name server') && !lowerText.includes('nameserver') && 
                        !lowerText.includes('nserver') && (!parsed.nameServers || parsed.nameServers.length === 0)) {
                        isAvailable = true;
                        break;
                    }
                }
            }
            
            if (isAvailable) {
                parsed.isRegistered = false;
            } else {
                // THIRD: Check if WHOIS response is substantial
                // If we have substantial structured data but no clear indicators, likely registered
                const nonCommentLines = lines.filter(line => {
                    const trimmed = line.trim();
                    return trimmed && !trimmed.startsWith('%') && !trimmed.startsWith('#') && trimmed.length > 3;
                });
                
                if (nonCommentLines.length > 10) {
                    // Check if there's structured data (key:value pairs with actual values)
                    let structuredDataCount = 0;
                    for (const line of nonCommentLines) {
                        if (line.includes(':') && line.split(':').length > 1) {
                            const value = line.split(':').slice(1).join(':').trim();
                            if (value && value.length > 2 && 
                                !value.toLowerCase().includes('not available') && 
                                !value.toLowerCase().includes('n/a') &&
                                !value.toLowerCase().includes('none')) {
                                structuredDataCount++;
                            }
                        }
                    }
                    // If we have multiple structured data fields, likely registered
                    if (structuredDataCount > 3) {
                        parsed.isRegistered = true;
                    } else {
                        parsed.isRegistered = false;
                    }
                } else if (nonCommentLines.length < 3) {
                    // If response is very short or empty, likely available
                    parsed.isRegistered = false;
                } else {
                    // Default: if we can't determine, be conservative and assume taken
                    parsed.isRegistered = true;
                }
            }
        }
        
        // If DNS lookup determined registration status (for unsupported TLDs), use that
        if (isRegisteredFromDns !== null) {
            parsed.isRegistered = isRegisteredFromDns;
        }
        
        res.json({
            domain: cleanDomain,
            whois: parsed,
            raw: whoisText
        });
    } catch (error) {
        console.error('WHOIS lookup error:', error);
        res.status(500).json({ 
            error: 'Failed to perform WHOIS lookup',
            message: error.message 
        });
    }
});

// Email verification endpoint (called by mock server)
app.post('/api/send-verification-email', async (req, res) => {
    try {
        const { email, name, verificationCode, verificationExpiry, isResend } = req.body;
        
        if (!email || !name || !verificationCode) {
            return res.status(400).json({ 
                success: false,
                error: 'Missing required fields: email, name, and verificationCode are required' 
            });
        }
        
        await sendEmailVerification(email, name, verificationCode, verificationExpiry, isResend === true);
        
        res.json({ 
            success: true,
            message: 'Verification email sent successfully' 
        });
    } catch (error) {
        console.error('❌ Error sending verification email:', error);
        res.status(500).json({ 
            success: false,
            error: error.message || 'Failed to send verification email' 
        });
    }
});

// Send password reset email endpoint
app.post('/api/send-password-reset-email', async (req, res) => {
    try {
        const { email, name, verificationCode, verificationExpiry, newPassword } = req.body;
        
        if (!email || !name || !verificationCode) {
            return res.status(400).json({ 
                success: false,
                error: 'Missing required fields: email, name, and verificationCode are required' 
            });
        }
        
        // Note: newPassword is included in the request but we don't store it here
        // The password will be updated after code verification in the app
        await sendPasswordResetEmail(email, name, verificationCode, verificationExpiry);
        
        res.json({ 
            success: true,
            message: 'Password reset email sent successfully' 
        });
    } catch (error) {
        console.error('❌ Error sending password reset email:', error);
        res.status(500).json({ 
            success: false,
            error: error.message || 'Failed to send password reset email' 
        });
    }
});

// Send project confirmation email endpoint
app.post('/api/send-project-confirmation-email', async (req, res) => {
    try {
        const { email, name, projectName, serviceType } = req.body;
        
        if (!email || !name || !projectName || !serviceType) {
            return res.status(400).json({ 
                success: false,
                error: 'Missing required fields: email, name, projectName, and serviceType are required' 
            });
        }
        
        await sendProjectConfirmationEmail(email, name, projectName, serviceType);
        
        res.json({ 
            success: true,
            message: 'Project confirmation email sent successfully' 
        });
    } catch (error) {
        console.error('❌ Error sending project confirmation email:', error);
        res.status(500).json({ 
            success: false,
            error: error.message || 'Failed to send project confirmation email' 
        });
    }
});

// Test endpoint to send a test verification email
app.post('/api/test-verification-email', async (req, res) => {
    try {
        const { email } = req.body;
        const testEmail = email || (process.env.ADMIN_EMAIL || 'YOUR_ADMIN_EMAIL');
        const testCode = '123456';
        const testExpiry = new Date(Date.now() + 24 * 60 * 60 * 1000);
        
        await sendEmailVerification(testEmail, 'Test User', testCode, testExpiry);
        
        res.json({ 
            success: true,
            message: `Test verification email sent successfully to ${testEmail}` 
        });
    } catch (error) {
        console.error('❌ Error sending test verification email:', error);
        res.status(500).json({ 
            success: false,
            error: error.message || 'Failed to send test verification email' 
        });
    }
});

// Email verification handler (GET request from email link)
app.get('/api/verify-email', async (req, res) => {
    try {
        const { token, email } = req.query;
        
        if (!code || !email) {
            return res.status(400).send(`
                <!DOCTYPE html>
                <html>
                <head>
                    <title>Verification Failed - InfiNet Hub</title>
                    <meta name="viewport" content="width=device-width, initial-scale=1.0">
                    <style>
                        body { font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, Arial, sans-serif; text-align: center; padding: 20px; background: #f5f5f5; min-height: 100vh; margin: 0; display: flex; align-items: center; justify-content: center; }
                        .container { max-width: 600px; background: white; padding: 40px; border-radius: 12px; box-shadow: 0 4px 6px rgba(0,0,0,0.1); }
                        h1 { color: #dc2626; margin: 0 0 20px 0; }
                        p { color: #666; font-size: 16px; line-height: 1.6; }
                    </style>
                </head>
                <body>
                    <div class="container">
                        <h1>❌ Verification Failed</h1>
                        <p>Missing verification code or email. Please check your verification link.</p>
                    </div>
                </body>
                </html>
            `);
        }
        
        // Show page with instructions to open app with verification code
        res.send(`
            <!DOCTYPE html>
            <html>
            <head>
                <title>Open InfiNet Hub - Email Verification</title>
                <meta name="viewport" content="width=device-width, initial-scale=1.0">
                <style>
                    body { font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, Arial, sans-serif; text-align: center; padding: 20px; background: linear-gradient(135deg, #72FF13 0%, #00F0FF 100%); min-height: 100vh; margin: 0; display: flex; align-items: center; justify-content: center; }
                    .container { max-width: 600px; background: white; padding: 40px; border-radius: 12px; box-shadow: 0 8px 24px rgba(0,0,0,0.2); }
                    h1 { color: #333; margin: 0 0 20px 0; font-size: 32px; }
                    p { color: #666; font-size: 16px; line-height: 1.6; }
                    .code-box { background: linear-gradient(135deg, #72FF13 0%, #00F0FF 100%); padding: 30px; margin: 30px 0; border-radius: 12px; }
                    .code { color: #ffffff; font-size: 48px; font-weight: 700; letter-spacing: 8px; font-family: 'Courier New', monospace; margin: 10px 0; }
                    .info-box { background: linear-gradient(135deg, #E6FFE6 0%, #E0F7FF 100%); border-left: 4px solid #72FF13; padding: 20px; margin: 20px 0; border-radius: 6px; text-align: left; }
                </style>
            </head>
            <body>
                <div class="container">
                    <h1>📱 Open InfiNet Hub App</h1>
                    <p>Please open the InfiNet Hub app and enter this verification code on the login page:</p>
                    <div class="code-box">
                        <p style="margin: 0 0 10px 0; color: #ffffff; font-size: 14px; font-weight: 600; text-transform: uppercase; letter-spacing: 1px;">Your Verification Code</p>
                        <div class="code">${code}</div>
                    </div>
                    <div class="info-box">
                        <p style="margin: 0 0 10px 0; color: #0369a1; font-size: 14px; font-weight: 600;">📌 Instructions:</p>
                        <ol style="margin: 0; padding-left: 20px; color: #0369a1; font-size: 14px; line-height: 1.8;">
                            <li>Open the InfiNet Hub app</li>
                            <li>Go to the Login page</li>
                            <li>Enter the code above in the verification field</li>
                            <li>Click "Verify Email"</li>
                        </ol>
                    </div>
                    <p style="margin-top: 30px; color: #999; font-size: 14px;">The verification field will be visible on the login page for 24 hours.</p>
                </div>
            </body>
            </html>
        `);
    } catch (error) {
        console.error('❌ Error in verification page:', error);
        res.status(500).send(`
            <!DOCTYPE html>
            <html>
            <head>
                <title>Verification Error - InfiNet Hub</title>
                <style>
                    body { font-family: Arial, sans-serif; text-align: center; padding: 50px; background: #f5f5f5; }
                    .container { max-width: 600px; margin: 0 auto; background: white; padding: 40px; border-radius: 12px; box-shadow: 0 4px 6px rgba(0,0,0,0.1); }
                    h1 { color: #dc2626; }
                </style>
            </head>
            <body>
                <div class="container">
                    <h1>❌ Verification Error</h1>
                    <p>An error occurred while processing your verification. Please try again later.</p>
                </div>
            </body>
            </html>
        `);
    }
});

// Email verification redirect handler (GET request from email link)
// Redirects to app login page with verification code
app.get('/api/verify-email-redirect', async (req, res) => {
    try {
        const { code, email } = req.query;
        
        if (!code || !email) {
            return res.status(400).send(`
                <!DOCTYPE html>
                <html>
                <head>
                    <title>Verification Failed - InfiNet Hub</title>
                    <meta name="viewport" content="width=device-width, initial-scale=1.0">
                    <style>
                        body { font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, Arial, sans-serif; text-align: center; padding: 20px; background: #f5f5f5; min-height: 100vh; margin: 0; display: flex; align-items: center; justify-content: center; }
                        .container { max-width: 600px; background: white; padding: 40px; border-radius: 12px; box-shadow: 0 4px 6px rgba(0,0,0,0.1); }
                        h1 { color: #dc2626; margin: 0 0 20px 0; }
                        p { color: #666; font-size: 16px; line-height: 1.6; }
                    </style>
                </head>
                <body>
                    <div class="container">
                        <h1>❌ Verification Failed</h1>
                        <p>Missing verification code or email. Please check your verification link.</p>
                    </div>
                </body>
                </html>
            `);
        }
        
        // Show page with instructions to open app with verification code
        res.send(`
            <!DOCTYPE html>
            <html>
            <head>
                <title>Open InfiNet Hub - Email Verification</title>
                <meta name="viewport" content="width=device-width, initial-scale=1.0">
                <style>
                    body { font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, Arial, sans-serif; text-align: center; padding: 20px; background: linear-gradient(135deg, #72FF13 0%, #00F0FF 100%); min-height: 100vh; margin: 0; display: flex; align-items: center; justify-content: center; }
                    .container { max-width: 600px; background: white; padding: 40px; border-radius: 12px; box-shadow: 0 8px 24px rgba(0,0,0,0.2); }
                    h1 { color: #333; margin: 0 0 20px 0; font-size: 32px; }
                    p { color: #666; font-size: 16px; line-height: 1.6; }
                    .code-box { background: linear-gradient(135deg, #72FF13 0%, #00F0FF 100%); padding: 30px; margin: 30px 0; border-radius: 12px; }
                    .code { color: #ffffff; font-size: 48px; font-weight: 700; letter-spacing: 8px; font-family: 'Courier New', monospace; margin: 10px 0; }
                    .info-box { background: linear-gradient(135deg, #E6FFE6 0%, #E0F7FF 100%); border-left: 4px solid #72FF13; padding: 20px; margin: 20px 0; border-radius: 6px; text-align: left; }
                </style>
            </head>
            <body>
                <div class="container">
                    <h1>📱 Open InfiNet Hub App</h1>
                    <p>Please open the InfiNet Hub app and enter this verification code on the login page:</p>
                    <div class="code-box">
                        <p style="margin: 0 0 10px 0; color: #ffffff; font-size: 14px; font-weight: 600; text-transform: uppercase; letter-spacing: 1px;">Your Verification Code</p>
                        <div class="code">${code}</div>
                    </div>
                    <div class="info-box">
                        <p style="margin: 0 0 10px 0; color: #0369a1; font-size: 14px; font-weight: 600;">📌 Instructions:</p>
                        <ol style="margin: 0; padding-left: 20px; color: #0369a1; font-size: 14px; line-height: 1.8;">
                            <li>Open the InfiNet Hub app</li>
                            <li>Go to the Login page</li>
                            <li>Enter the code above in the verification field</li>
                            <li>Click "Verify Email"</li>
                        </ol>
                    </div>
                    <p style="margin-top: 30px; color: #999; font-size: 14px;">The verification field will be visible on the login page for 24 hours.</p>
                </div>
            </body>
            </html>
        `);
    } catch (error) {
        console.error('❌ Error in verification redirect:', error);
        res.status(500).send(`
            <!DOCTYPE html>
            <html>
            <head>
                <title>Verification Error - InfiNet Hub</title>
                <style>
                    body { font-family: Arial, sans-serif; text-align: center; padding: 50px; background: #f5f5f5; }
                    .container { max-width: 600px; margin: 0 auto; background: white; padding: 40px; border-radius: 12px; box-shadow: 0 4px 6px rgba(0,0,0,0.1); }
                    h1 { color: #dc2626; }
                </style>
            </head>
            <body>
                <div class="container">
                    <h1>❌ Verification Error</h1>
                    <p>An error occurred while processing your verification. Please try again later.</p>
                </div>
            </body>
            </html>
        `);
    }
});

// ============================================
// AUTHENTICATION ENDPOINTS
// ============================================

// JWT Secret (use environment variable or fallback)
// Register endpoint
app.post('/api/auth/register', async (req, res) => {
    try {
        const { name, email, password, company } = req.body;
        
        // Validation
        if (!name || !email || !password) {
            return res.status(400).json({ 
                error: 'Name, email, and password are required' 
            });
        }
        
        if (password.length < 8) {
            return res.status(400).json({ 
                error: 'Password must be at least 8 characters long' 
            });
        }
        
        // Check if user already exists
        const existingUser = await getUserByEmail(email);
        if (existingUser) {
            return res.status(400).json({ 
                error: 'Email already registered' 
            });
        }
        
        // Hash password
        const passwordHash = await bcrypt.hash(password, 10);
        
        // Generate verification code
        const verificationCode = generateVerificationCode();
        const verificationExpiry = new Date(Date.now() + 24 * 60 * 60 * 1000); // 24 hours
        
        // Normalize email before using it
        const normalizedEmail = email.toLowerCase().trim();
        
        // Set role: Administrator for admin email, Member for others
        const adminEmail = process.env.ADMIN_EMAIL || 'YOUR_ADMIN_EMAIL';
        const userRole = normalizedEmail === adminEmail ? 'Administrator' : 'Member';
        
        // Insert user into database
        db.run(
            `INSERT INTO users (email, password_hash, name, company, role, emailVerified, verificationToken, verificationExpiry) 
             VALUES (?, ?, ?, ?, ?, 0, ?, ?)`,
            [normalizedEmail, passwordHash, name, company || null, userRole, verificationCode, verificationExpiry.toISOString()],
            function(err) {
                if (err) {
                    console.error('Database error:', err);
                    return res.status(500).json({ error: 'Failed to create user account' });
                }
                
                const userId = this.lastID;
                
                // Send verification email using existing function
                // Ensure email is valid before sending
                if (!normalizedEmail || normalizedEmail.length === 0) {
                    console.error('Cannot send verification email: email is empty');
                    return res.status(201).json({
                        message: 'Registration successful, but verification email could not be sent. Please contact support.',
                        requiresVerification: true
                    });
                }
                
                sendEmailVerification(normalizedEmail, name, verificationCode, verificationExpiry, false)
                    .then(() => {
                        res.status(201).json({
                            message: 'Registration successful. Please check your email to verify your account.',
                            requiresVerification: true
                        });
                    })
                    .catch((emailError) => {
                        console.error('Failed to send verification email:', emailError);
                        // User is created, but email failed - still return success
                        res.status(201).json({
                            message: 'Registration successful, but verification email could not be sent. Please contact support.',
                            requiresVerification: true
                        });
                    });
            }
        );
    } catch (error) {
        console.error('Registration error:', error);
        res.status(500).json({ error: 'Registration failed' });
    }
});

// Login endpoint
app.post('/api/auth/login', async (req, res) => {
    try {
        const { email, password } = req.body;
        
        if (!email || !password) {
            return res.status(400).json({ error: 'Email and password are required' });
        }
        
        // Normalize email (lowercase and trim)
        const normalizedEmail = email.toLowerCase().trim();
        
        // Get user from database
        const user = await getUserByEmail(normalizedEmail);
        if (!user) {
            console.log(`❌ Login failed: User not found for email: ${normalizedEmail}`);
            return res.status(401).json({ error: 'Invalid credentials' });
        }
        
        // Auto-fix admin role if email matches admin but role is wrong
        const adminEmail = process.env.ADMIN_EMAIL || 'YOUR_ADMIN_EMAIL';
        if (normalizedEmail === adminEmail && user.role !== 'Administrator') {
            // Update user object immediately for this request (synchronously)
            user.role = 'Administrator';
            // Also update database (async, but user object is already fixed for this response)
            db.run(
                "UPDATE users SET role = 'Administrator' WHERE email = ?",
                [normalizedEmail],
                (err) => {
                    if (err) {
                        console.error('Error fixing admin role in DB:', err);
                    }
                }
            );
        }
        
        // Ensure role is set (default to Member if not set, or Administrator for admin email)
        if (!user.role) {
            const adminEmail = process.env.ADMIN_EMAIL || 'YOUR_ADMIN_EMAIL';
            user.role = normalizedEmail === adminEmail ? 'Administrator' : 'Member';
        }
        
        // Check if email is verified
        if (user.emailVerified === 0) {
            console.log(`❌ Login failed: Email not verified for: ${normalizedEmail}`);
            return res.status(403).json({ 
                error: 'Please verify your email address before logging in. Check your inbox for the verification email.' 
            });
        }
        
        // Verify password
        const passwordMatch = await bcrypt.compare(password, user.password_hash);
        if (!passwordMatch) {
            console.log(`❌ Login failed: Password mismatch for email: ${normalizedEmail}`);
            return res.status(401).json({ error: 'Invalid credentials' });
        }
        
        console.log(`✅ Login successful for email: ${normalizedEmail}, role: ${user.role}`);
        
        // Generate JWT token (includes role for admin checks)
        const token = generateToken(user);
        
        // Return user data (without password hash)
        // IMPORTANT: Use user.role directly (already fixed above if needed)
        const userData = {
            id: user.id,
            email: user.email,
            name: user.name,
            company: user.company,
            role: (() => { const adminEmail = process.env.ADMIN_EMAIL || 'YOUR_ADMIN_EMAIL'; return normalizedEmail === adminEmail ? 'Administrator' : (user.role || 'Member'); })(),
            emailVerified: user.emailVerified === 1,
            avatar: user.avatar
        };
        
        res.json({
            token,
            user: userData
        });
    } catch (error) {
        console.error('Login error:', error);
        res.status(500).json({ error: 'Login failed' });
    }
});

// Get user profile endpoint (protected)
app.get('/api/auth/profile', authenticateToken, async (req, res) => {
    try {
        const user = await getUserById(req.user.id);
        if (!user) {
            return res.status(404).json({ error: 'User not found' });
        }
        
        res.json({
            id: user.id,
            email: user.email,
            name: user.name,
            company: user.company,
            role: user.role || 'Member',
            emailVerified: user.emailVerified === 1,
            avatar: user.avatar,
            createdAt: user.createdAt,
            updatedAt: user.updatedAt
        });
    } catch (error) {
        console.error('Get profile error:', error);
        res.status(500).json({ error: 'Failed to get profile' });
    }
});

// Update user profile endpoint (protected)
app.put('/api/auth/profile', authenticateToken, async (req, res) => {
    try {
        const { name, company, avatar } = req.body;
        const userId = req.user.id;
        
        // Build update query dynamically
        const updates = [];
        const values = [];
        
        if (name !== undefined) {
            updates.push('name = ?');
            values.push(name);
        }
        if (company !== undefined) {
            updates.push('company = ?');
            values.push(company);
        }
        if (avatar !== undefined) {
            updates.push('avatar = ?');
            values.push(avatar);
        }
        
        if (updates.length === 0) {
            return res.status(400).json({ error: 'No fields to update' });
        }
        
        updates.push('updatedAt = CURRENT_TIMESTAMP');
        values.push(userId);
        
        db.run(
            `UPDATE users SET ${updates.join(', ')} WHERE id = ?`,
            values,
            async (err) => {
                if (err) {
                    console.error('Update profile error:', err);
                    return res.status(500).json({ error: 'Failed to update profile' });
                }
                
                // Get updated user
                const updatedUser = await getUserById(userId);
                res.json({
                    id: updatedUser.id,
                    email: updatedUser.email,
                    name: updatedUser.name,
                    company: updatedUser.company,
                    role: updatedUser.role || 'Member',
                    emailVerified: updatedUser.emailVerified === 1,
                    avatar: updatedUser.avatar,
                    createdAt: updatedUser.createdAt,
                    updatedAt: updatedUser.updatedAt
                });
            }
        );
    } catch (error) {
        console.error('Update profile error:', error);
        res.status(500).json({ error: 'Failed to update profile' });
    }
});

// Change password endpoint (protected)
app.post('/api/auth/change-password', authenticateToken, async (req, res) => {
    try {
        const { currentPassword, newPassword } = req.body;
        const userId = req.user.id;
        
        if (!currentPassword || !newPassword) {
            return res.status(400).json({ error: 'Current password and new password are required' });
        }
        
        if (newPassword.length < 8) {
            return res.status(400).json({ error: 'New password must be at least 8 characters long' });
        }
        
        // Get user with password hash
        db.get('SELECT password_hash FROM users WHERE id = ?', [userId], async (err, user) => {
            if (err || !user) {
                return res.status(404).json({ error: 'User not found' });
            }
            
            // Verify current password
            const passwordMatch = await bcrypt.compare(currentPassword, user.password_hash);
            if (!passwordMatch) {
                return res.status(401).json({ error: 'Current password is incorrect' });
            }
            
            // Hash new password
            const newPasswordHash = await bcrypt.hash(newPassword, 10);
            
            // Update password
            db.run(
                'UPDATE users SET password_hash = ?, updatedAt = CURRENT_TIMESTAMP WHERE id = ?',
                [newPasswordHash, userId],
                (err) => {
                    if (err) {
                        console.error('Change password error:', err);
                        return res.status(500).json({ error: 'Failed to change password' });
                    }
                    
                    res.json({ success: true, message: 'Password changed successfully' });
                }
            );
        });
    } catch (error) {
        console.error('Change password error:', error);
        res.status(500).json({ error: 'Failed to change password' });
    }
});

// Delete user account endpoint (protected) - allows users to delete their own account
app.delete('/api/auth/account', authenticateToken, async (req, res) => {
    try {
        const userId = req.user.id;
        
        // Get user to verify they exist and get email
        const user = await getUserById(userId);
        if (!user) {
            return res.status(404).json({ error: 'User not found' });
        }
        
        const userEmail = user.email;
        
        // Prevent deletion of admin accounts (optional safety check)
        // You can remove this if you want admins to be able to delete their own accounts
        if (user.role === 'Administrator') {
            return res.status(403).json({ error: 'Administrator accounts cannot be deleted through this endpoint. Please contact support.' });
        }
        
        // Delete related data first, then the user (same cleanup logic as admin endpoint)
        
        // 1. Delete ticket_replies for tickets belonging to this user
        db.run(`DELETE FROM ticket_replies WHERE ticketId IN (SELECT id FROM tickets WHERE userId = ?)`, [userId], (err) => {
            if (err && !err.message.includes('no such table')) {
                console.error('Error deleting ticket replies:', err);
            }
        });
        
        // 2. Delete project_files for projects belonging to this user
        db.run(`DELETE FROM project_files WHERE projectId IN (SELECT id FROM projects WHERE userId = ?)`, [userId], (err) => {
            if (err && !err.message.includes('no such table')) {
                console.error('Error deleting project files:', err);
            }
        });
        
        // 3. Delete invoices for projects belonging to this user
        db.run(`DELETE FROM invoices WHERE projectId IN (SELECT id FROM projects WHERE userId = ?)`, [userId], (err) => {
            if (err && !err.message.includes('no such table')) {
                console.error('Error deleting invoices:', err);
            }
        });
        
        // 4. Delete project_history for projects belonging to this user
        db.run(`DELETE FROM project_history WHERE projectId IN (SELECT id FROM projects WHERE userId = ?)`, [userId], (err) => {
            if (err && !err.message.includes('no such table')) {
                console.error('Error deleting project history:', err);
            }
        });
        
        // 5. Delete activities for projects belonging to this user
        db.run(`DELETE FROM activities WHERE projectId IN (SELECT id FROM projects WHERE userId = ?)`, [userId], (err) => {
            if (err && !err.message.includes('no such table')) {
                console.error('Error deleting activities by project:', err);
            }
        });
        
        // 6. Delete tables with userId field
        const tablesWithUserId = [
            'activities', 'push_tokens', 'project_history', 'ai_chat_messages',
            'project_requests', 'agent_requests', 'tool_history', 'creator_history',
            'user_preferences', 'tickets', 'projects'
        ];
        
        tablesWithUserId.forEach(tableName => {
            db.run(`DELETE FROM ${tableName} WHERE userId = ?`, [userId], (err) => {
                if (err && !err.message.includes('no such table') && !err.message.includes('no such column')) {
                    console.error(`Error deleting from ${tableName}:`, err);
                }
            });
        });
        
        // 7. Delete tables with userEmail field (using lowercase comparison)
        const tablesWithUserEmail = [
            'activities', 'project_requests', 'agent_requests', 'tool_history',
            'creator_history', 'user_service_assignments'
        ];
        
        tablesWithUserEmail.forEach(tableName => {
            db.run(`DELETE FROM ${tableName} WHERE LOWER(userEmail) = LOWER(?)`, [userEmail], (err) => {
                if (err && !err.message.includes('no such table') && !err.message.includes('no such column')) {
                    console.error(`Error deleting from ${tableName} by email:`, err);
                }
            });
        });
        
        // 8. Finally, delete the user
        db.run('DELETE FROM users WHERE id = ?', [userId], function(err) {
            if (err) {
                console.error('Error deleting user account:', err);
                return res.status(500).json({ error: 'Failed to delete account' });
            }
            
            if (this.changes === 0) {
                return res.status(404).json({ error: 'User not found' });
            }
            
            console.log(`User ${userId} (${userEmail}) deleted their own account`);
            res.json({
                success: true,
                message: 'Account deleted successfully'
            });
        });
    } catch (error) {
        console.error('Delete account error:', error);
        res.status(500).json({ error: 'Failed to delete account' });
    }
});

// Verify email endpoint
app.post('/api/auth/verify-email', async (req, res) => {
    try {
        const { code, email } = req.body;
        
        if (!code || !email) {
            return res.status(400).json({ error: 'Verification code and email are required' });
        }
        
        const user = await getUserByEmail(email);
        if (!user) {
            return res.status(404).json({ error: 'User not found' });
        }
        
        if (user.emailVerified === 1) {
            return res.json({ message: 'Email already verified' });
        }
        
        // Check if code matches
        if (user.verificationToken !== code.trim()) {
            return res.status(400).json({ error: 'Invalid verification code' });
        }
        
        // Check if code has expired
        if (user.verificationExpiry && new Date(user.verificationExpiry) < new Date()) {
            return res.status(400).json({ 
                error: 'Verification code has expired. Please request a new one.' 
            });
        }
        
        // Mark email as verified
        db.run(
            'UPDATE users SET emailVerified = 1, verificationToken = NULL, verificationExpiry = NULL, updatedAt = CURRENT_TIMESTAMP WHERE id = ?',
            [user.id],
            (err) => {
                if (err) {
                    console.error('Verify email error:', err);
                    return res.status(500).json({ error: 'Failed to verify email' });
                }
                
                res.json({ message: 'Email verified successfully' });
            }
        );
    } catch (error) {
        console.error('Verify email error:', error);
        res.status(500).json({ error: 'Failed to verify email' });
    }
});

// Resend verification email endpoint
app.post('/api/auth/resend-verification', async (req, res) => {
    try {
        const { email } = req.body;
        
        if (!email) {
            return res.status(400).json({ error: 'Email is required' });
        }
        
        const user = await getUserByEmail(email);
        if (!user) {
            return res.status(404).json({ error: 'User not found' });
        }
        
        if (user.emailVerified === 1) {
            return res.json({ message: 'Email already verified' });
        }
        
        // Generate new verification code
        const verificationCode = generateVerificationCode();
        const verificationExpiry = new Date(Date.now() + 24 * 60 * 60 * 1000); // 24 hours
        
        // Update verification token in database
        db.run(
            'UPDATE users SET verificationToken = ?, verificationExpiry = ?, updatedAt = CURRENT_TIMESTAMP WHERE id = ?',
            [verificationCode, verificationExpiry.toISOString(), user.id],
            async (err) => {
                if (err) {
                    console.error('Resend verification error:', err);
                    return res.status(500).json({ error: 'Failed to resend verification email' });
                }
                
                // Send verification email (ensure email is valid)
                const userEmail = user.email || email;
                if (!userEmail) {
                    return res.status(400).json({ error: 'Email address not found' });
                }
                try {
                    await sendEmailVerification(userEmail, user.name, verificationCode, verificationExpiry, true);
                    res.json({ message: 'Verification email sent successfully' });
                } catch (emailError) {
                    console.error('Failed to send verification email:', emailError);
                    res.status(500).json({ error: 'Failed to send verification email' });
                }
            }
        );
    } catch (error) {
        console.error('Resend verification error:', error);
        res.status(500).json({ error: 'Failed to resend verification email' });
    }
});

// Request password reset endpoint
app.post('/api/auth/request-password-reset', async (req, res) => {
    try {
        const { email, newPassword } = req.body;
        
        if (!email || !newPassword) {
            return res.status(400).json({ error: 'Email and new password are required' });
        }
        
        if (newPassword.length < 8) {
            return res.status(400).json({ error: 'New password must be at least 8 characters long' });
        }
        
        const user = await getUserByEmail(email);
        if (!user) {
            // Don't reveal if user exists for security
            return res.json({ message: 'If the email exists, a password reset code has been sent' });
        }
        
        // Generate reset code
        const resetCode = generateVerificationCode();
        const resetExpiry = new Date(Date.now() + 1 * 60 * 60 * 1000); // 1 hour
        
        // Update password reset token in database
        db.run(
            'UPDATE users SET passwordResetToken = ?, passwordResetExpiry = ?, updatedAt = CURRENT_TIMESTAMP WHERE id = ?',
            [resetCode, resetExpiry.toISOString(), user.id],
            async (err) => {
                if (err) {
                    console.error('Request password reset error:', err);
                    return res.status(500).json({ error: 'Failed to request password reset' });
                }
                
                // Send password reset email
                try {
                    await sendPasswordResetEmail(user.email, user.name, resetCode, resetExpiry);
                    res.json({ message: 'If the email exists, a password reset code has been sent' });
                } catch (emailError) {
                    console.error('Failed to send password reset email:', emailError);
                    res.status(500).json({ error: 'Failed to send password reset email' });
                }
            }
        );
    } catch (error) {
        console.error('Request password reset error:', error);
        res.status(500).json({ error: 'Failed to request password reset' });
    }
});

// Confirm password reset endpoint
app.post('/api/auth/confirm-password-reset', async (req, res) => {
    try {
        const { email, code, newPassword } = req.body;
        
        if (!email || !code || !newPassword) {
            return res.status(400).json({ error: 'Email, code, and new password are required' });
        }
        
        if (newPassword.length < 8) {
            return res.status(400).json({ error: 'New password must be at least 8 characters long' });
        }
        
        const user = await getUserByEmail(email);
        if (!user) {
            return res.status(404).json({ error: 'User not found' });
        }
        
        // Check if code matches
        if (user.passwordResetToken !== code.trim()) {
            return res.status(400).json({ error: 'Invalid reset code' });
        }
        
        // Check if code has expired
        if (user.passwordResetExpiry && new Date(user.passwordResetExpiry) < new Date()) {
            return res.status(400).json({ 
                error: 'Reset code has expired. Please request a new one.' 
            });
        }
        
        // Hash new password
        const newPasswordHash = await bcrypt.hash(newPassword, 10);
        
        // Update password and clear reset token
        db.run(
            'UPDATE users SET password_hash = ?, passwordResetToken = NULL, passwordResetExpiry = NULL, updatedAt = CURRENT_TIMESTAMP WHERE id = ?',
            [newPasswordHash, user.id],
            (err) => {
                if (err) {
                    console.error('Confirm password reset error:', err);
                    return res.status(500).json({ error: 'Failed to reset password' });
                }
                
                res.json({ message: 'Password reset successfully' });
            }
        );
    } catch (error) {
        console.error('Confirm password reset error:', error);
        res.status(500).json({ error: 'Failed to reset password' });
    }
});

// ============================================
// Dashboard, Projects, Notifications, Admin Endpoints (DUPLICATE - REMOVED)
// ============================================
// NOTE: These endpoints have been moved BEFORE the catch-all /:slug route
// This duplicate section should be removed to avoid conflicts

// Helper function to get user projects with tickets and files (DUPLICATE - REMOVED)
function getUserProjectsDuplicate(userId, callback) {
    db.all(`
        SELECT 
            p.id,
            p.name,
            p.status,
            p.progress,
            p.dueDate,
            p.description,
            p.userId,
            p.createdAt,
            p.updatedAt
        FROM projects p
        WHERE p.userId = ?
        ORDER BY p.updatedAt DESC
    `, [userId], (err, projects) => {
        if (err) {
            return callback(err, null);
        }
        
        // Get tickets and files for each project
        const projectsWithDetails = [];
        let completed = 0;
        
        if (projects.length === 0) {
            return callback(null, []);
        }
        
        projects.forEach((project) => {
            // Get tickets
            db.all(`
                SELECT 
                    t.id,
                    t.subject,
                    t.message,
                    t.status,
                    t.userId,
                    t.userName,
                    t.createdAt,
                    t.updatedAt
                FROM tickets t
                WHERE t.projectId = ?
                ORDER BY t.updatedAt DESC
            `, [project.id], (err, tickets) => {
                if (err) {
                    console.error('Error fetching tickets:', err);
                    tickets = [];
                }
                
                // Get ticket replies
                const ticketsWithReplies = [];
                let ticketCompleted = 0;
                
                if (tickets.length === 0) {
                    // Get files
                    db.all(`
                        SELECT 
                            id,
                            name,
                            url,
                            uploadedAt
                        FROM project_files
                        WHERE projectId = ?
                        ORDER BY uploadedAt DESC
                    `, [project.id], (err, files) => {
                        if (err) {
                            console.error('Error fetching files:', err);
                            files = [];
                        }
                        
                        projectsWithDetails.push({
                            ...project,
                            tickets: [],
                            files: files.map(f => ({
                                id: f.id,
                                name: f.name,
                                url: f.url,
                                uploadedAt: f.uploadedAt
                            }))
                        });
                        
                        completed++;
                        if (completed === projects.length) {
                            callback(null, projectsWithDetails);
                        }
                    });
                    return;
                }
                
                tickets.forEach((ticket) => {
                    db.all(`
                        SELECT 
                            id,
                            message,
                            senderId,
                            senderName,
                            senderRole,
                            timestamp
                        FROM ticket_replies
                        WHERE ticketId = ?
                        ORDER BY timestamp ASC
                    `, [ticket.id], (err, replies) => {
                        if (err) {
                            console.error('Error fetching replies:', err);
                            replies = [];
                        }
                        
                        ticketsWithReplies.push({
                            ...ticket,
                            replies: replies.map(r => ({
                                id: r.id,
                                ticketId: r.ticketId,
                                message: r.message,
                                senderId: r.senderId,
                                senderName: r.senderName,
                                senderRole: r.senderRole,
                                timestamp: r.timestamp
                            }))
                        });
                        
                        ticketCompleted++;
                        if (ticketCompleted === tickets.length) {
                            // Get files
                            db.all(`
                                SELECT 
                                    id,
                                    name,
                                    url,
                                    uploadedAt
                                FROM project_files
                                WHERE projectId = ?
                                ORDER BY uploadedAt DESC
                            `, [project.id], (err, files) => {
                                if (err) {
                                    console.error('Error fetching files:', err);
                                    files = [];
                                }
                                
                                projectsWithDetails.push({
                                    ...project,
                                    tickets: ticketsWithReplies,
                                    files: files.map(f => ({
                                        id: f.id,
                                        name: f.name,
                                        url: f.url,
                                        uploadedAt: f.uploadedAt
                                    }))
                                });
                                
                                completed++;
                                if (completed === projects.length) {
                                    callback(null, projectsWithDetails);
                                }
                            });
                        }
                    });
                });
            });
        });
    });
}

// Dashboard endpoint
app.get('/api/dashboard', authenticateToken, async (req, res) => {
    try {
        const userId = req.user.id;
        
        // Get user projects
        getUserProjects(userId, (err, projects) => {
            if (err) {
                console.error('Error fetching projects:', err);
                return res.status(500).json({ error: 'Failed to fetch dashboard data' });
            }
            
            // Get invoices for user's projects
            const projectIds = projects.map(p => p.id);
            if (projectIds.length === 0) {
                return res.json({
                    projects: [],
                    invoices: [],
                    tickets: [],
                    activity: []
                });
            }
            
            const placeholders = projectIds.map(() => '?').join(',');
            db.all(`
                SELECT 
                    id,
                    projectId,
                    title,
                    amount,
                    currency,
                    issuedOn,
                    dueOn,
                    status,
                    paymentMethod,
                    receiptUrl
                FROM invoices
                WHERE projectId IN (${placeholders})
                ORDER BY issuedOn DESC
            `, projectIds, (err, invoices) => {
                if (err) {
                    console.error('Error fetching invoices:', err);
                    invoices = [];
                }
                
                // Get all tickets (flattened from projects)
                const tickets = projects.flatMap(project => 
                    project.tickets.map(ticket => ({
                        ...ticket,
                        projectId: project.id,
                        projectName: project.name
                    }))
                );
                
                // Get activities for user (last 6)
                db.all(`
                    SELECT 
                        id,
                        type,
                        title,
                        description,
                        userId,
                        projectId,
                        invoiceId,
                        ticketId,
                        source,
                        userEmail,
                        read,
                        timestamp
                    FROM activities
                    WHERE userId = ? OR userId IS NULL
                    ORDER BY timestamp DESC
                    LIMIT 6
                `, [userId], (err, activities) => {
                    if (err) {
                        console.error('Error fetching activities:', err);
                        activities = [];
                    }
                    
                    res.json({
                        projects,
                        invoices: invoices.map(i => ({
                            id: i.id,
                            projectId: i.projectId,
                            title: i.title,
                            amount: i.amount,
                            currency: i.currency || 'USD',
                            issuedOn: i.issuedOn,
                            dueOn: i.dueOn,
                            status: i.status,
                            paymentMethod: i.paymentMethod,
                            receiptUrl: i.receiptUrl
                        })),
                        tickets,
                        activity: activities.map(a => ({
                            id: a.id,
                            type: a.type,
                            title: a.title,
                            description: a.description,
                            timestamp: a.timestamp,
                            read: a.read === 1,
                            userId: a.userId,
                            projectId: a.projectId,
                            invoiceId: a.invoiceId,
                            ticketId: a.ticketId,
                            source: a.source,
                            userEmail: a.userEmail
                        }))
                    });
                });
            });
        });
    } catch (error) {
        console.error('Dashboard error:', error);
        res.status(500).json({ error: 'Failed to fetch dashboard data' });
    }
});

// Projects endpoint
app.get('/api/projects', authenticateToken, async (req, res) => {
    try {
        const userId = req.user.id;
        
        // Get user projects
        getUserProjects(userId, (err, projects) => {
            if (err) {
                console.error('Error fetching projects:', err);
                return res.status(500).json({ error: 'Failed to fetch projects' });
            }
            
            // Get invoices for user's projects
            const projectIds = projects.map(p => p.id);
            if (projectIds.length === 0) {
                return res.json({
                    projects: [],
                    invoices: []
                });
            }
            
            const placeholders = projectIds.map(() => '?').join(',');
            db.all(`
                SELECT 
                    id,
                    projectId,
                    title,
                    amount,
                    currency,
                    issuedOn,
                    dueOn,
                    status,
                    paymentMethod,
                    receiptUrl
                FROM invoices
                WHERE projectId IN (${placeholders})
                ORDER BY issuedOn DESC
            `, projectIds, (err, invoices) => {
                if (err) {
                    console.error('Error fetching invoices:', err);
                    invoices = [];
                }
                
                res.json({
                    projects,
                    invoices: invoices.map(i => ({
                        id: i.id,
                        projectId: i.projectId,
                        title: i.title,
                        amount: i.amount,
                        currency: i.currency || 'USD',
                        issuedOn: i.issuedOn,
                        dueOn: i.dueOn,
                        status: i.status,
                        paymentMethod: i.paymentMethod,
                        receiptUrl: i.receiptUrl
                    }))
                });
            });
        });
    } catch (error) {
        console.error('Projects error:', error);
        res.status(500).json({ error: 'Failed to fetch projects' });
    }
});

// Notifications endpoint
app.get('/api/notifications', authenticateToken, async (req, res) => {
    try {
        const userId = req.user.id;
        const userEmail = req.user.email?.toLowerCase();
        
        // Get activities for user (last 20)
        // Exclude user-initiated actions (File Uploaded, Invoice Uploaded, Ticket Submitted)
        // Only show admin-initiated actions (File Received, Invoice Received, Ticket Replies, etc.)
        // Match by userId OR userEmail (for cross-device sync when admin creates notifications)
        console.log('[GET /api/notifications] Fetching for user:', { userId, userEmail });
        db.all(`
            SELECT 
                id,
                type,
                title,
                description,
                userId,
                projectId,
                invoiceId,
                ticketId,
                source,
                userEmail,
                read,
                timestamp
            FROM activities
            WHERE (
                CAST(userId AS TEXT) = CAST(? AS TEXT) 
                OR userId = ? 
                OR (userEmail IS NOT NULL AND LOWER(userEmail) = ?)
                OR (userId IS NULL AND userEmail IS NULL)
            )
            AND title NOT IN ('File Uploaded', 'Invoice/Receipt Uploaded', 'New Ticket Submitted', 'Ticket Submitted')
            AND title NOT LIKE '%File Uploaded%'
            AND title NOT LIKE '%Invoice%Uploaded%'
            AND title NOT LIKE '%Ticket Submitted%'
            ORDER BY timestamp DESC
            LIMIT 20
        `, [userId, userId, userEmail || ''], (err, activities) => {
            if (err) {
                console.error('[GET /api/notifications] Error fetching notifications:', err);
                return res.status(500).json({ error: 'Failed to fetch notifications' });
            }
            
            console.log('[GET /api/notifications] Found', activities.length, 'notifications for user:', { userId, userEmail });
            if (activities.length > 0) {
                const sample = activities.slice(0, 5).map(a => ({
                    id: a.id,
                    title: a.title,
                    userId: a.userId,
                    userEmail: a.userEmail,
                    userIdType: typeof a.userId,
                    type: a.type
                }));
                console.log('[GET /api/notifications] Sample notifications:', JSON.stringify(sample, null, 2));
                
                // Check if Progress Update notifications are in the results
                const progressUpdates = activities.filter(a => a.title === 'Progress Update' || a.title === 'Project Completed');
                console.log('[GET /api/notifications] Progress Update notifications found:', progressUpdates.length);
                if (progressUpdates.length > 0) {
                    console.log('[GET /api/notifications] Progress Update samples:', progressUpdates.slice(0, 2).map(a => ({
                        id: a.id,
                        title: a.title,
                        userId: a.userId,
                        userEmail: a.userEmail
                    })));
                }
            }
            
            res.json({
                notifications: activities.map(a => ({
                    id: a.id,
                    type: a.type,
                    title: a.title,
                    description: a.description,
                    timestamp: a.timestamp,
                    read: a.read === 1,
                    userId: a.userId,
                    projectId: a.projectId,
                    invoiceId: a.invoiceId,
                    ticketId: a.ticketId,
                    source: a.source,
                    userEmail: a.userEmail
                }))
            });
        });
    } catch (error) {
        console.error('Notifications error:', error);
        res.status(500).json({ error: 'Failed to fetch notifications' });
    }
});

// GET /api/ai/chat/history - Fetch AI chat history
app.get('/api/ai/chat/history', authenticateToken, async (req, res) => {
    try {
        const userId = req.user.id;
        const { limit = 50, reset } = req.query;

        // Handle reset: clear chat history for the user
        if (reset === 'true') {
            await new Promise((resolve, reject) => {
                db.run(`DELETE FROM ai_chat_messages WHERE userId = ?`, [userId], function(err) {
                    if (err) reject(err);
                    else resolve(this.changes);
                });
            });
            // Return only the welcome message after reset
            return res.json({
                messages: [{
                    id: `msg-${Date.now()}-welcome`,
                    sender: 'assistant',
                    content: "Hi! I'm your InfiNet AI Assistant — ask me anything.",
                    timestamp: new Date().toISOString(),
                    userId: userId
                }],
                timestamp: new Date().toISOString()
            });
        }
        
        const sanitizedLimit = Math.min(Math.max(parseInt(limit, 10) || 50, 1), 200);
        
        db.all(`
            SELECT 
                id,
                userId,
                sender,
                content,
                timestamp
            FROM ai_chat_messages
            WHERE userId = ?
            ORDER BY datetime(timestamp) ASC
            LIMIT ?
        `, [userId, sanitizedLimit], (err, rows) => {
            if (err) {
                console.error('Error fetching AI chat history:', err);
                return res.status(500).json({ error: 'Failed to fetch AI chat history' });
            }
            
            const messages = rows.map(row => ({
                id: row.id,
                sender: row.sender,
                content: row.content,
                timestamp: row.timestamp
            }));
            
            // If no messages, return a default welcome message
            if (messages.length === 0) {
                messages.push({
                    id: `msg-${Date.now()}-welcome`,
                    sender: 'assistant',
                    content: "Hi! I'm your InfiNet AI Assistant — ask me anything.",
                    timestamp: new Date().toISOString(),
                    userId: userId
                });
            }
            
            res.json({
                messages,
                timestamp: new Date().toISOString()
            });
        });
    } catch (error) {
        console.error('AI chat history fetch error:', error);
        res.status(500).json({ error: 'Failed to fetch AI chat history' });
    }
});

// POST /api/ai/chat/message - Save AI chat message
app.post('/api/ai/chat/message', authenticateToken, async (req, res) => {
    try {
        const userId = req.user.id;
        const { id, sender, content, timestamp } = req.body;
        
        if (!id || !sender || !content) {
            return res.status(400).json({ error: 'Missing required fields: id, sender, content' });
        }
        
        if (sender !== 'user' && sender !== 'assistant') {
            return res.status(400).json({ error: 'Invalid sender. Must be "user" or "assistant"' });
        }
        
        const messageTimestamp = timestamp || new Date().toISOString();
        
        db.run(`
            INSERT OR REPLACE INTO ai_chat_messages 
            (id, userId, sender, content, timestamp)
            VALUES (?, ?, ?, ?, ?)
        `, [id, userId, sender, content, messageTimestamp], function(err) {
            if (err) {
                console.error('Error saving AI chat message:', err);
                return res.status(500).json({ error: 'Failed to save AI chat message' });
            }
            
            res.status(201).json({
                success: true,
                id,
                timestamp: messageTimestamp
            });
        });
    } catch (error) {
        console.error('AI chat message save error:', error);
        res.status(500).json({ error: 'Failed to save AI chat message' });
    }
});

// Error handling middleware - MUST be last (after all routes)
app.use((err, req, res, next) => {
    console.error('[Error Handler] Unhandled error:', err);
    console.error('[Error Handler] Error stack:', err.stack);
    console.error('[Error Handler] Request path:', req.path);
    console.error('[Error Handler] Request method:', req.method);
    
    // Don't send response if headers already sent
    if (res.headersSent) {
        return next(err);
    }
    
    res.status(500).json({ 
        error: 'Something went wrong!',
        message: err.message || 'An unexpected error occurred',
        details: process.env.NODE_ENV === 'development' ? err.stack : undefined
    });
});

// 404 handler for unmatched routes
app.use((req, res) => {
    console.log(`⚠️ 404: Route not found: ${req.method} ${req.path}`);
    res.status(404).json({ error: 'Route not found' });
});

// Start server
// Listen on all interfaces (0.0.0.0) to be accessible from remote connections
app.listen(PORT, '0.0.0.0', () => {
    console.log(`🚀 Consultation Booking API is running on port ${PORT}`);
    console.log(`🌐 Server accessible on all interfaces (0.0.0.0:${PORT})`);
    console.log(`📧 Email service: ${process.env.EMAIL_USER ? 'Configured ✓' : 'Not configured ✗'}`);
    console.log(`📱 Telegram bot: ${process.env.TELEGRAM_BOT_TOKEN && process.env.TELEGRAM_BOT_TOKEN !== 'YOUR_BOT_TOKEN' ? 'Configured ✓' : 'Not configured ✗'}`);
    console.log(`🤖 Gemini AI: ${process.env.GEMINI_API_KEY ? 'Configured ✓' : 'Not configured ✗'}`);
    console.log(`🔷 Groq AI: ${groqInstances.length > 0 ? `Configured ✓ (${groqInstances.length} key${groqInstances.length > 1 ? 's' : ''})` : 'Not configured ✗'}`);
    console.log(`🔷 Groq AI: ${groqInstances.length > 0 ? `Configured ✓ (${groqInstances.length} key${groqInstances.length > 1 ? 's' : ''})` : 'Not configured ✗'}`);
    console.log(`\n📋 Available endpoints:`);
    console.log(`   GET  /api/health - Health check`);
    console.log(`   GET  /api/bookings - Get all bookings`);
    console.log(`   POST /api/bookings - Create new booking`);
    console.log(`   PUT  /api/bookings/:id - Update booking`);
    console.log(`   DELETE /api/bookings/:id - Delete booking`);
    console.log(`   POST /api/ai/chat - AI chat endpoint`);
    console.log(`   POST /api/ai/create-booking - Create booking from AI`);
    console.log(`   GET  /api/ai/conversations - Get all conversations (Admin)`);
    console.log(`   GET  /api/ai/conversations/:sessionId - Get conversation (Admin)`);
    console.log(`   GET  /api/ai/leads - Get all leads (Admin)`);
    console.log(`   GET  /api/ai/leads/:sessionId - Get lead (Admin)`);
    console.log(`   POST /api/tools/shorten-url - Create short URL`);
    console.log(`   GET  /:slug - Redirect short URL`);
    console.log(`   GET  /api/tools/short-url/:slug - Get short URL stats`);
    console.log(`   POST /api/tools/domain-check - Check domain availability`);
    console.log(`   POST /api/tools/whois-lookup - Perform WHOIS lookup`);
    console.log(`   GET  /api/dashboard - Get dashboard data`);
    console.log(`   GET  /api/projects - Get projects`);
    console.log(`   GET  /api/notifications - Get notifications`);
    console.log(`   POST /api/project-requests - Submit project request`);
    console.log(`   GET  /api/project-requests - Get all project requests (Admin)`);
    console.log(`   PUT  /api/project-requests/:id - Update project request (Admin)`);
    console.log(`   POST /api/activities - Create/sync activity`);
    console.log(`   POST /api/agent-requests - Submit agent request`);
    console.log(`   GET  /api/agent-requests - Get all agent requests (Admin)`);
    console.log(`   PUT  /api/agent-requests/:id - Update agent request (Admin)`);
    console.log(`   POST /api/tool-history - Add tool history entry`);
    console.log(`   GET  /api/tool-history - Get tool history for user`);
    console.log(`   POST /api/creator-history - Add creator history entry`);
    console.log(`   GET  /api/creator-history - Get creator history for user`);
    console.log(`   GET  /api/user-preferences - Get user preferences`);
    console.log(`   PUT  /api/user-preferences - Update user preferences`);
    console.log(`   GET  /api/user-service-assignments - Get service assignments (all for Admin, own for users)`);
    console.log(`   POST /api/user-service-assignments - Create service assignment (Admin)`);
    console.log(`   DELETE /api/user-service-assignments - Delete service assignment (Admin)`);
    console.log(`   GET  /api/management/users - Get all users (Admin)`);
    console.log(`   GET  /api/management/test - Test admin route`);
});

// Graceful shutdown
process.on('SIGINT', () => {
    console.log('\n🛑 Shutting down server...');
    db.close((err) => {
        if (err) {
            console.error(err.message);
        } else {
            console.log('📊 Database connection closed.');
        }
        process.exit(0);
    });
});
