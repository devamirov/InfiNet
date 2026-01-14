#!/usr/bin/env node
/**
 * Database Cleanup Script
 * 
 * This script:
 * 1. Creates a backup of the database
 * 2. Deletes ALL history, activities, notifications, and data (for everyone including kept users)
 * 3. Deletes all users except: amirxtet@gmail.com, ahoteit710@gmail.com, contact.infinetservices@gmail.com
 * 4. The 3 kept users will have clean accounts with NO history or data
 */

const sqlite3 = require('sqlite3').verbose();
const fs = require('fs');
const path = require('path');

const DB_PATH = path.join(__dirname, 'bookings.db');
const BACKUP_DIR = path.join(__dirname, 'backups');

// Users to keep
const USERS_TO_KEEP = [
    'amirxtet@gmail.com',
    'ahoteit710@gmail.com',
    'contact.infinetservices@gmail.com'
];

// Create backup directory if it doesn't exist
if (!fs.existsSync(BACKUP_DIR)) {
    fs.mkdirSync(BACKUP_DIR, { recursive: true });
}

// Generate backup filename with timestamp
const timestamp = new Date().toISOString().replace(/[:.]/g, '-').replace('T', '_').substring(0, 19);
const backupFile = path.join(BACKUP_DIR, `bookings_backup_before_cleanup_${timestamp}.db`);

// Check if database exists
if (!fs.existsSync(DB_PATH)) {
    console.error(`❌ Error: Database file not found at ${DB_PATH}`);
    process.exit(1);
}

// Open database
const db = new sqlite3.Database(DB_PATH, (err) => {
    if (err) {
        console.error('❌ Error opening database:', err.message);
        process.exit(1);
    }
    console.log('✅ Connected to database');
});

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

async function cleanupDatabase() {
    try {
        // Step 1: Create backup
        console.log('\n📦 Step 1: Creating backup...');
        try {
            fs.copyFileSync(DB_PATH, backupFile);
            const stats = fs.statSync(backupFile);
            const fileSizeInMB = (stats.size / (1024 * 1024)).toFixed(2);
            console.log(`✅ Backup created: ${backupFile} (${fileSizeInMB} MB)`);
        } catch (error) {
            console.error(`❌ Error creating backup:`, error.message);
            process.exit(1);
        }

        // Step 2: Delete ALL data from all tables (for everyone, including kept users)
        console.log('\n🧹 Step 2: Deleting ALL history, activities, notifications, and data...');
        console.log('   (This includes data for all users, even those being kept)');
        
        // List of all tables to clear completely (in order to respect foreign key constraints)
        const tablesToClear = [
            // Child tables with foreign keys (delete these first)
            'ticket_replies',
            'project_files',
            'invoices',
            'activities',  // Notifications/activities
            'project_history',  // History
            'ai_chat_messages',  // Chat history
            'project_requests',
            'agent_requests',
            'tool_history',  // Tool history
            'creator_history',  // Creator history
            'user_service_assignments',
            'push_tokens',
            'user_preferences',
            
            // Parent tables
            'tickets',
            'projects',
            
            // Standalone tables
            'bookings',
            'ai_conversations',
            'ai_leads',
            'short_urls',
        ];

        let totalDeleted = 0;
        for (const tableName of tablesToClear) {
            try {
                // Check if table exists
                const tableCheck = await getSQL(
                    "SELECT name FROM sqlite_master WHERE type='table' AND name=?",
                    [tableName]
                );
                
                if (!tableCheck) {
                    console.log(`   ⚠️  Table ${tableName} does not exist (skipping)`);
                    continue;
                }

                // Delete ALL rows from table
                const result = await runSQL(`DELETE FROM ${tableName}`);
                
                if (result.changes > 0) {
                    console.log(`   ✅ Deleted ${result.changes} rows from ${tableName}`);
                    totalDeleted += result.changes;
                } else {
                    console.log(`   ℹ️  Table ${tableName} was already empty`);
                }
            } catch (err) {
                console.error(`   ❌ Error clearing ${tableName}:`, err.message);
            }
        }

        console.log(`\n✅ Total rows deleted from data tables: ${totalDeleted}`);

        // Step 3: Get all users
        console.log('\n📋 Step 3: Fetching all users...');
        const allUsers = await allSQL("SELECT id, email, name, role FROM users");
        console.log(`✅ Found ${allUsers.length} users`);

        // Step 4: Find users to keep and delete
        const usersToKeep = allUsers.filter(user => 
            USERS_TO_KEEP.includes((user.email || '').toLowerCase())
        );
        const usersToDelete = allUsers.filter(user => 
            !USERS_TO_KEEP.includes((user.email || '').toLowerCase())
        );

        if (usersToKeep.length === 0) {
            console.error('❌ Error: None of the users to keep were found in database!');
            console.error('   Users to keep:', USERS_TO_KEEP);
            process.exit(1);
        }

        console.log(`\n✅ Users to keep (${usersToKeep.length}):`);
        usersToKeep.forEach(user => {
            console.log(`   - ${user.email} (ID: ${user.id}, Role: ${user.role || 'Member'})`);
        });

        if (usersToDelete.length === 0) {
            console.log('\n✅ No users to delete. All data has been cleared.');
        } else {
            console.log(`\n🗑️  Users to delete (${usersToDelete.length}):`);
            usersToDelete.forEach(user => {
                console.log(`   - ${user.email} (ID: ${user.id})`);
            });

            // Step 5: Delete users
            console.log('\n👤 Step 4: Deleting users...');
            const userIdsToDelete = usersToDelete.map(u => u.id);
            const deleteResult = await runSQL(
                `DELETE FROM users WHERE id IN (${userIdsToDelete.map(() => '?').join(',')})`,
                userIdsToDelete
            );
            console.log(`✅ Deleted ${deleteResult.changes} user(s)`);
        }

        // Step 6: Verify remaining users
        console.log('\n✅ Step 5: Verifying remaining users...');
        const remainingUsers = await allSQL("SELECT id, email, name, role FROM users");
        console.log(`   Remaining users: ${remainingUsers.length}`);
        remainingUsers.forEach(user => {
            console.log(`     - ${user.email} (${user.role || 'Member'})`);
        });

        // Verify all users to keep are present
        const keptEmails = remainingUsers.map(u => (u.email || '').toLowerCase());
        const missingUsers = USERS_TO_KEEP.filter(email => !keptEmails.includes(email.toLowerCase()));
        
        if (missingUsers.length > 0) {
            console.error(`\n❌ WARNING: Some users to keep are missing!`);
            missingUsers.forEach(email => {
                console.error(`   - Missing: ${email}`);
            });
        } else {
            console.log('\n✅ All users to keep are present');
        }

        // Final statistics
        const finalStats = await allSQL(`
            SELECT 
                (SELECT COUNT(*) FROM users) as user_count,
                (SELECT COUNT(*) FROM projects) as project_count,
                (SELECT COUNT(*) FROM tickets) as ticket_count,
                (SELECT COUNT(*) FROM activities) as activity_count,
                (SELECT COUNT(*) FROM ai_chat_messages) as chat_count,
                (SELECT COUNT(*) FROM tool_history) as tool_history_count,
                (SELECT COUNT(*) FROM creator_history) as creator_history_count
        `);

        console.log('\n📊 Final Statistics:');
        console.log(`   - Users: ${finalStats[0].user_count}`);
        console.log(`   - Projects: ${finalStats[0].project_count}`);
        console.log(`   - Tickets: ${finalStats[0].ticket_count}`);
        console.log(`   - Activities: ${finalStats[0].activity_count}`);
        console.log(`   - Chat Messages: ${finalStats[0].chat_count}`);
        console.log(`   - Tool History: ${finalStats[0].tool_history_count}`);
        console.log(`   - Creator History: ${finalStats[0].creator_history_count}`);

        console.log('\n✅ Database cleanup completed successfully!');
        console.log(`📦 Backup saved at: ${backupFile}`);
        console.log('\n⚠️  ALL history, activities, notifications, and data have been removed.');
        console.log('   The 3 kept users have clean accounts with NO history or data.');

    } catch (error) {
        console.error('\n❌ Error during database cleanup:', error);
        console.error('\n⚠️  The database may be in an inconsistent state.');
        console.error(`📦 A backup was created before the cleanup: ${backupFile}`);
        console.error('   You can restore from the backup if needed.');
        process.exit(1);
    } finally {
        db.close((err) => {
            if (err) {
                console.error('Error closing database:', err.message);
            } else {
                console.log('\n✅ Database connection closed');
            }
        });
    }
}

// Run the cleanup
console.log('🚀 Starting database cleanup process...\n');
console.log('Users to keep:');
USERS_TO_KEEP.forEach(email => console.log(`  - ${email}`));
cleanupDatabase();

