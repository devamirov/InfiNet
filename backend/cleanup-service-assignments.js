const sqlite3 = require('sqlite3').verbose();
const path = require('path');
const fs = require('fs');

// Database path
const DB_PATH = process.env.DB_PATH || './bookings.db';

// User email to keep assignments for
const KEEP_USER_EMAIL = 'ahoteit710@gmail.com';
const KEEP_SERVICE_TYPE = 'Mobile App'; // Keep only Mobile App assignment

// Helper function to run SQL queries
function runSQL(query, params = []) {
    return new Promise((resolve, reject) => {
        const db = new sqlite3.Database(DB_PATH);
        db.run(query, params, function(err) {
            db.close();
            if (err) {
                reject(err);
            } else {
                resolve({ changes: this.changes, lastID: this.lastID });
            }
        });
    });
}

// Helper function to get SQL results
function getSQL(query, params = []) {
    return new Promise((resolve, reject) => {
        const db = new sqlite3.Database(DB_PATH);
        db.all(query, params, (err, rows) => {
            db.close();
            if (err) {
                reject(err);
            } else {
                resolve(rows);
            }
        });
    });
}

async function cleanupServiceAssignments() {
    console.log('🚀 Starting service assignments cleanup...\n');
    
    // Step 1: Check current assignments
    console.log('📋 Step 1: Checking current assignments...');
    const allAssignments = await getSQL(
        'SELECT id, userEmail, serviceType, projectId, progress FROM user_service_assignments ORDER BY userEmail, serviceType'
    );
    
    console.log(`   Found ${allAssignments.length} assignment(s):\n`);
    allAssignments.forEach(a => {
        console.log(`   - ${a.userEmail} | ${a.serviceType} | Project: ${a.projectId || 'N/A'} | Progress: ${a.progress}%`);
    });
    console.log('');
    
    // Step 2: Find assignments to keep
    console.log('✅ Step 2: Finding assignments to keep...');
    const assignmentsToKeep = allAssignments.filter(a => 
        a.userEmail.toLowerCase() === KEEP_USER_EMAIL.toLowerCase() && 
        a.serviceType === KEEP_SERVICE_TYPE
    );
    
    if (assignmentsToKeep.length === 0) {
        console.log(`   ⚠️  No assignment found for ${KEEP_USER_EMAIL} with service type "${KEEP_SERVICE_TYPE}"`);
        console.log('   Will delete all assignments.\n');
    } else {
        console.log(`   ✅ Found ${assignmentsToKeep.length} assignment(s) to keep:\n`);
        assignmentsToKeep.forEach(a => {
            console.log(`   - ${a.userEmail} | ${a.serviceType} | Project: ${a.projectId || 'N/A'}`);
        });
        console.log('');
    }
    
    // Step 3: Delete all assignments except the ones to keep
    console.log('🗑️  Step 3: Deleting assignments...\n');
    
    if (assignmentsToKeep.length > 0) {
        // Delete all assignments that are NOT in the keep list
        const keepIds = assignmentsToKeep.map(a => a.id);
        const placeholders = keepIds.map(() => '?').join(',');
        
        const deleteResult = await runSQL(
            `DELETE FROM user_service_assignments WHERE id NOT IN (${placeholders})`,
            keepIds
        );
        console.log(`   ✅ Deleted ${deleteResult.changes} assignment(s)\n`);
    } else {
        // Delete all assignments
        const deleteResult = await runSQL('DELETE FROM user_service_assignments');
        console.log(`   ✅ Deleted ${deleteResult.changes} assignment(s)\n`);
    }
    
    // Step 4: Verify cleanup
    console.log('✅ Step 4: Verifying cleanup...');
    const remainingAssignments = await getSQL(
        'SELECT id, userEmail, serviceType, projectId, progress FROM user_service_assignments ORDER BY userEmail, serviceType'
    );
    
    console.log(`\n   Remaining assignments (${remainingAssignments.length}):\n`);
    if (remainingAssignments.length === 0) {
        console.log('   (No assignments remaining)');
    } else {
        remainingAssignments.forEach(a => {
            console.log(`   - ${a.userEmail} | ${a.serviceType} | Project: ${a.projectId || 'N/A'} | Progress: ${a.progress}%`);
        });
    }
    
    console.log('\n✅ Service assignments cleanup completed successfully!\n');
}

// Run cleanup
cleanupServiceAssignments().catch(err => {
    console.error('❌ Fatal error:', err);
    process.exit(1);
});

