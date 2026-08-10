#!/usr/bin/env node
/**
 * Tool History Database Cleanup Script
 * 
 * This script:
 * 1. Creates a backup of the tool history database
 * 2. Deletes ALL tool history entries (for everyone including kept users)
 * 3. The 3 kept users will have clean accounts with NO tool history
 * 4. Note: This database uses userId (email) as TEXT, not user IDs
 */

const Database = require('better-sqlite3');
const fs = require('fs');
const path = require('path');

// Use same path logic as toolHistory.js
const DB_DIR = process.env.TOOL_HISTORY_DB_DIR || path.join(__dirname, 'data');
const DB_PATH = process.env.TOOL_HISTORY_DB || path.join(DB_DIR, 'tool-history.db');
const BACKUP_DIR = path.join(__dirname, 'backups');

// Users to keep (these are email addresses used as userId in this database)
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
const backupFile = path.join(BACKUP_DIR, `tool-history_backup_before_cleanup_${timestamp}.db`);

// Check if database exists
if (!fs.existsSync(DB_PATH)) {
    console.error(`❌ Error: Database file not found at ${DB_PATH}`);
    process.exit(1);
}

async function cleanupDatabase() {
    let db;
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

        // Step 2: Open database
        console.log('\n🔌 Step 2: Connecting to database...');
        db = new Database(DB_PATH);
        console.log('✅ Connected to database');

        // Step 3: Delete ALL tool history entries
        console.log('\n🧹 Step 3: Deleting ALL tool history entries...');
        console.log('   (This includes data for all users, even those being kept)');
        
        const deleteResult = db.prepare('DELETE FROM tool_history').run();
        const totalDeleted = deleteResult.changes;
        
        if (totalDeleted > 0) {
            console.log(`   ✅ Deleted ${totalDeleted} tool history entries`);
        } else {
            console.log(`   ℹ️  Tool history table was already empty`);
        }

        // Step 4: Verify cleanup
        console.log('\n✅ Step 4: Verifying cleanup...');
        const remainingEntries = db.prepare('SELECT COUNT(*) as count FROM tool_history').get();
        console.log(`   Total remaining entries: ${remainingEntries.count}`);

        console.log('\n✅ Tool history database cleanup completed successfully!');
        console.log(`📦 Backup saved at: ${backupFile}`);
        console.log('\n⚠️  ALL tool history has been removed.');
        console.log('   The 3 kept users have clean accounts with NO tool history.');

    } catch (error) {
        console.error('\n❌ Error during database cleanup:', error);
        console.error('\n⚠️  The database may be in an inconsistent state.');
        console.error(`📦 A backup was created before the cleanup: ${backupFile}`);
        console.error('   You can restore from the backup if needed.');
        process.exit(1);
    } finally {
        if (db) {
            db.close();
            console.log('\n✅ Database connection closed');
        }
    }
}

// Run the cleanup
console.log('🚀 Starting tool history database cleanup process...\n');
console.log('Users to keep:');
USERS_TO_KEEP.forEach(email => console.log(`  - ${email}`));
cleanupDatabase();

