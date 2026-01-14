#!/usr/bin/env node

/**
 * Create owner account with unlimited tokens
 * Email: Set via OWNER_EMAIL environment variable (default: admin@infinet.services)
 * Password: Set via OWNER_PASSWORD environment variable (REQUIRED)
 */

const sqlite3 = require('sqlite3').verbose();
const bcrypt = require('bcrypt');
const path = require('path');

const dbPath = process.env.DB_PATH || './data/database.db';
const db = new sqlite3.Database(dbPath);

const ownerEmail = process.env.OWNER_EMAIL || 'admin@infinet.services';
const ownerPassword = process.env.OWNER_PASSWORD;
const ownerPlan = 'owner'; // Special plan for unlimited tokens

async function createOwnerAccount() {
    if (!ownerPassword) {
        console.error('❌ Error: OWNER_PASSWORD environment variable is required');
        console.error('   Please set OWNER_PASSWORD environment variable before running this script');
        process.exit(1);
    }
    
    console.log('🔐 Creating owner account...\n');
    
    // Check if account already exists
    db.get('SELECT id, email, plan FROM users WHERE email = ?', [ownerEmail], async (err, existingUser) => {
        if (err) {
            console.error('❌ Error checking for existing user:', err);
            db.close();
            process.exit(1);
        }
        
        if (existingUser) {
            console.log(`✅ Owner account already exists!`);
            console.log(`   User ID: ${existingUser.id}`);
            console.log(`   Email: ${existingUser.email}`);
            console.log(`   Plan: ${existingUser.plan}`);
            
            // Update to owner plan and password
            const hashedPassword = await bcrypt.hash(ownerPassword, 10);
            const updates = [];
            if (existingUser.plan !== 'owner') {
                updates.push('plan = ?');
            }
            updates.push('password = ?');
            
            const updateValues = [];
            if (existingUser.plan !== 'owner') {
                updateValues.push(ownerPlan);
            }
            updateValues.push(hashedPassword);
            updateValues.push(existingUser.id);
            
            db.run(
                `UPDATE users SET ${updates.join(', ')} WHERE id = ?`,
                updateValues,
                (updateErr) => {
                    if (updateErr) {
                        console.error('❌ Error updating account:', updateErr);
                    } else {
                        if (existingUser.plan !== 'owner') {
                            console.log('✅ Updated plan to "owner"');
                        }
                        console.log('✅ Password updated');
                    }
                    db.close();
                }
            );
            return;
        }
        
        // Create new owner account
        console.log('📝 Creating new owner account...');
        const hashedPassword = await bcrypt.hash(ownerPassword, 10);
        
        db.run(
            'INSERT INTO users (email, password, plan) VALUES (?, ?, ?)',
            [ownerEmail, hashedPassword, ownerPlan],
            function(insertErr) {
                if (insertErr) {
                    console.error('❌ Error creating owner account:', insertErr);
                    db.close();
                    process.exit(1);
                }
                
                const userId = this.lastID;
                console.log('✅ Owner account created successfully!');
                console.log(`   User ID: ${userId}`);
                console.log(`   Email: ${ownerEmail}`);
                console.log(`   Plan: ${ownerPlan} (unlimited tokens)`);
                console.log('\n🎉 Owner account is ready to use!');
                
                db.close();
            }
        );
    });
}

createOwnerAccount().catch(console.error);

