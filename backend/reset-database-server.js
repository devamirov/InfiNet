#!/usr/bin/env node
/**
 * Server-Safe Database Reset Script
 * 
 * This script safely resets the database on the production server by:
 * 1. Creating a manual backup
 * 2. Stopping the PM2 backend service
 * 3. Resetting the database (preserving admin user)
 * 4. Verifying admin user
 * 5. Restarting the PM2 backend service
 */

const sqlite3 = require('sqlite3').verbose();
const fs = require('fs');
const path = require('path');
const { execSync } = require('child_process');

const DB_PATH = path.join(__dirname, 'bookings.db');
const BACKUP_DIR = path.join(__dirname, 'backups');
const ADMIN_EMAIL = 'amirxtet@gmail.com';
const PM2_SERVICE_NAME = 'infinet-backend';

// Colors for console output
const colors = {
    reset: '\x1b[0m',
    green: '\x1b[32m',
    red: '\x1b[31m',
    yellow: '\x1b[33m',
    blue: '\x1b[34m',
    cyan: '\x1b[36m'
};

function log(message, color = 'reset') {
    console.log(`${colors[color]}${message}${colors.reset}`);
}

// Create backup directory if it doesn't exist
if (!fs.existsSync(BACKUP_DIR)) {
    fs.mkdirSync(BACKUP_DIR, { recursive: true });
    log(`✅ Created backup directory: ${BACKUP_DIR}`, 'green');
}

// Generate backup filename with timestamp
const timestamp = new Date().toISOString().replace(/[:.]/g, '-').replace('T', '_').substring(0, 19);
const backupFile = path.join(BACKUP_DIR, `bookings_manual_backup_before_reset_${timestamp}.db`);

// Check if database exists
if (!fs.existsSync(DB_PATH)) {
    log(`❌ Error: Database file not found at ${DB_PATH}`, 'red');
    process.exit(1);
}

// Helper function to run SQL and return a promise
function runSQL(sql, params = []) {
    return new Promise((resolve, reject) => {
        db.run(sql, params, function(err) {
            if (err) {
                reject(err);
            } else {
                resolve({ lastID: this.lastID, changes: this.changes });
            }
        });
    });
}

// Helper function to get data and return a promise
function getSQL(sql, params = []) {
    return new Promise((resolve, reject) => {
        db.get(sql, params, (err, row) => {
            if (err) {
                reject(err);
            } else {
                resolve(row);
            }
        });
    });
}

// Helper function to get all rows and return a promise
function allSQL(sql, params = []) {
    return new Promise((resolve, reject) => {
        db.all(sql, params, (err, rows) => {
            if (err) {
                reject(err);
            } else {
                resolve(rows);
            }
        });
    });
}

// Check PM2 service status
function checkPM2Status() {
    try {
        const output = execSync(`pm2 list | grep ${PM2_SERVICE_NAME} || echo ""`, { encoding: 'utf-8' });
        if (output.includes('online')) {
            return 'online';
        } else if (output.includes('stopped')) {
            return 'stopped';
        }
        return 'not_found';
    } catch (error) {
        return 'error';
    }
}

// Stop PM2 service
function stopPM2Service() {
    try {
        log(`\n🛑 Stopping PM2 service: ${PM2_SERVICE_NAME}...`, 'yellow');
        execSync(`pm2 stop ${PM2_SERVICE_NAME}`, { stdio: 'inherit' });
        // Wait a moment for the service to stop
        execSync('sleep 2', { stdio: 'inherit' });
        const status = checkPM2Status();
        if (status === 'stopped' || status === 'not_found') {
            log(`✅ PM2 service stopped successfully`, 'green');
            return true;
        } else {
            log(`⚠️  Warning: PM2 service may still be running. Status: ${status}`, 'yellow');
            return false;
        }
    } catch (error) {
        log(`❌ Error stopping PM2 service: ${error.message}`, 'red');
        return false;
    }
}

// Start PM2 service
function startPM2Service() {
    try {
        log(`\n🚀 Starting PM2 service: ${PM2_SERVICE_NAME}...`, 'yellow');
        execSync(`pm2 restart ${PM2_SERVICE_NAME}`, { stdio: 'inherit' });
        // Wait a moment for the service to start
        execSync('sleep 3', { stdio: 'inherit' });
        const status = checkPM2Status();
        if (status === 'online') {
            log(`✅ PM2 service started successfully`, 'green');
            return true;
        } else {
            log(`⚠️  Warning: PM2 service may not be running. Status: ${status}`, 'yellow');
            return false;
        }
    } catch (error) {
        log(`❌ Error starting PM2 service: ${error.message}`, 'red');
        return false;
    }
}

let db;

async function resetDatabase() {
    try {
        // Step 1: Check PM2 service status
        log('\n📊 Step 1: Checking PM2 service status...', 'cyan');
        const initialStatus = checkPM2Status();
        log(`   Current status: ${initialStatus}`, 'blue');
        
        // Step 2: Create manual backup
        log('\n📦 Step 2: Creating manual backup...', 'cyan');
        try {
            fs.copyFileSync(DB_PATH, backupFile);
            const stats = fs.statSync(backupFile);
            const fileSizeInMB = (stats.size / (1024 * 1024)).toFixed(2);
            log(`✅ Manual backup created: ${backupFile}`, 'green');
            log(`   Size: ${fileSizeInMB} MB`, 'blue');
        } catch (error) {
            log(`❌ Error creating backup: ${error.message}`, 'red');
            process.exit(1);
        }
        
        // Step 3: Stop PM2 service
        if (initialStatus === 'online') {
            const stopped = stopPM2Service();
            if (!stopped) {
                log(`⚠️  Warning: Could not confirm PM2 service stopped. Proceeding with caution...`, 'yellow');
            }
        } else {
            log(`ℹ️  PM2 service is not running (status: ${initialStatus}). Skipping stop step.`, 'blue');
        }
        
        // Step 4: Open database
        log('\n🔌 Step 3: Connecting to database...', 'cyan');
        db = new sqlite3.Database(DB_PATH, (err) => {
            if (err) {
                log(`❌ Error opening database: ${err.message}`, 'red');
                process.exit(1);
            }
            log(`✅ Connected to database`, 'green');
        });
        
        // Step 5: Extract admin user data
        log('\n📋 Step 4: Extracting admin user data...', 'cyan');
        const adminUser = await getSQL(
            "SELECT * FROM users WHERE LOWER(email) = LOWER(?)",
            [ADMIN_EMAIL]
        );
        
        if (!adminUser) {
            log(`❌ Error: Admin user (${ADMIN_EMAIL}) not found in database!`, 'red');
            log('   Cannot proceed with reset without admin user.', 'red');
            process.exit(1);
        }
        
        log(`✅ Admin user found: ${adminUser.email} (ID: ${adminUser.id}, Role: ${adminUser.role || 'Member'})`, 'green');
        
        // Store admin user data
        const adminData = {
            id: adminUser.id,
            email: adminUser.email,
            password_hash: adminUser.password_hash,
            name: adminUser.name,
            company: adminUser.company || null,
            role: 'Administrator',
            emailVerified: adminUser.emailVerified || 1,
            verificationToken: adminUser.verificationToken || null,
            verificationExpiry: adminUser.verificationExpiry || null,
            passwordResetToken: adminUser.passwordResetToken || null,
            passwordResetExpiry: adminUser.passwordResetExpiry || null,
            avatar: adminUser.avatar || null,
            createdAt: adminUser.createdAt || new Date().toISOString(),
            updatedAt: new Date().toISOString()
        };
        
        // Step 6: Delete all data from tables
        log('\n🗑️  Step 5: Deleting all data from tables...', 'cyan');
        
        const tablesToClear = [
            'ticket_replies',
            'project_files',
            'invoices',
            'tickets',
            'project_history',
            'ai_chat_messages',
            'project_requests',
            'agent_requests',
            'tool_history',
            'creator_history',
            'user_service_assignments',
            'activities',
            'push_tokens',
            'projects',
            'user_preferences',
            'bookings',
            'ai_conversations',
            'ai_leads',
            'short_urls',
        ];
        
        let totalDeleted = 0;
        for (const table of tablesToClear) {
            try {
                const result = await runSQL(`DELETE FROM ${table}`);
                totalDeleted += result.changes;
                if (result.changes > 0) {
                    log(`   ✅ Cleared ${table} (${result.changes} rows)`, 'green');
                }
            } catch (err) {
                if (err.message.includes('no such table')) {
                    log(`   ⚠️  Table ${table} does not exist (skipping)`, 'yellow');
                } else {
                    log(`   ❌ Error clearing ${table}: ${err.message}`, 'red');
                }
            }
        }
        log(`✅ Total rows deleted: ${totalDeleted}`, 'green');
        
        // Step 7: Delete all users except admin
        log('\n👤 Step 6: Deleting all users except admin...', 'cyan');
        const deleteResult = await runSQL(
            "DELETE FROM users WHERE LOWER(email) != LOWER(?)",
            [ADMIN_EMAIL]
        );
        log(`✅ Deleted ${deleteResult.changes} user(s) (admin preserved)`, 'green');
        
        // Step 8: Re-insert admin user
        log('\n🔄 Step 7: Re-inserting admin user with Administrator role...', 'cyan');
        await runSQL("DELETE FROM users WHERE LOWER(email) = LOWER(?)", [ADMIN_EMAIL]);
        
        await runSQL(
            `INSERT INTO users (
                email, password_hash, name, company, role, emailVerified,
                verificationToken, verificationExpiry, passwordResetToken, passwordResetExpiry,
                avatar, createdAt, updatedAt
            ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
            [
                adminData.email,
                adminData.password_hash,
                adminData.name,
                adminData.company,
                'Administrator',
                adminData.emailVerified,
                adminData.verificationToken,
                adminData.verificationExpiry,
                adminData.passwordResetToken,
                adminData.passwordResetExpiry,
                adminData.avatar,
                adminData.createdAt,
                adminData.updatedAt
            ]
        );
        
        log('✅ Admin user re-inserted with Administrator role', 'green');
        
        // Step 9: Verify admin user
        log('\n✅ Step 8: Verifying admin user...', 'cyan');
        const verifiedAdmin = await getSQL(
            "SELECT id, email, name, role FROM users WHERE LOWER(email) = LOWER(?)",
            [ADMIN_EMAIL]
        );
        
        if (!verifiedAdmin) {
            log('❌ CRITICAL ERROR: Admin user not found after reset!', 'red');
            process.exit(1);
        }
        
        if (verifiedAdmin.role !== 'Administrator') {
            log(`⚠️  WARNING: Admin user role is "${verifiedAdmin.role}" instead of "Administrator"`, 'yellow');
            await runSQL(
                "UPDATE users SET role = 'Administrator' WHERE LOWER(email) = LOWER(?)",
                [ADMIN_EMAIL]
            );
            log('✅ Fixed admin role to Administrator', 'green');
        }
        
        log(`✅ Verification successful:`, 'green');
        log(`   - Email: ${verifiedAdmin.email}`, 'blue');
        log(`   - Name: ${verifiedAdmin.name}`, 'blue');
        log(`   - Role: ${verifiedAdmin.role}`, 'blue');
        log(`   - ID: ${verifiedAdmin.id}`, 'blue');
        
        // Step 10: Final statistics
        const userCount = await allSQL("SELECT COUNT(*) as count FROM users");
        log(`\n📊 Step 9: Final Statistics:`, 'cyan');
        log(`   - Total users: ${userCount[0].count} (should be 1)`, 'blue');
        
        if (userCount[0].count !== 1) {
            log(`⚠️  WARNING: Expected 1 user, found ${userCount[0].count}`, 'yellow');
        }
        
        log('\n✅ Database reset completed successfully!', 'green');
        log(`📦 Backup saved at: ${backupFile}`, 'blue');
        log('\n⚠️  All data has been cleared except the admin user.', 'yellow');
        log('   The admin user (amirxtet@gmail.com) is preserved with Administrator role.', 'blue');
        
        // Step 11: Restart PM2 service
        if (initialStatus === 'online') {
            const started = startPM2Service();
            if (!started) {
                log(`\n⚠️  WARNING: Could not confirm PM2 service started. Please check manually.`, 'yellow');
                log(`   Run: pm2 restart ${PM2_SERVICE_NAME}`, 'blue');
            }
        } else {
            log(`\nℹ️  PM2 service was not running initially. Skipping restart.`, 'blue');
        }
        
    } catch (error) {
        log('\n❌ Error during database reset:', 'red');
        log(error.message, 'red');
        log('\n⚠️  The database may be in an inconsistent state.', 'yellow');
        log(`📦 A backup was created before the reset: ${backupFile}`, 'blue');
        log('   You can restore from the backup if needed.', 'blue');
        
        // Try to restart service even on error
        if (initialStatus === 'online') {
            log('\n🔄 Attempting to restart PM2 service...', 'yellow');
            startPM2Service();
        }
        
        process.exit(1);
    } finally {
        if (db) {
            db.close((err) => {
                if (err) {
                    log('Error closing database:', 'red');
                    log(err.message, 'red');
                } else {
                    log('\n✅ Database connection closed', 'green');
                }
            });
        }
    }
}

// Run the reset
log('🚀 Starting server-safe database reset process...', 'cyan');
log('=' .repeat(60), 'cyan');
resetDatabase();




