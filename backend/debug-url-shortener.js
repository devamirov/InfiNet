#!/usr/bin/env node

/**
 * Debug script for URL Shortener
 * This script checks the database to see if short URLs are being stored correctly
 */

const sqlite3 = require('sqlite3').verbose();
const path = require('path');

const dbPath = path.join(__dirname, 'bookings.db');

console.log('🔍 URL Shortener Debug Tool');
console.log('============================\n');

const db = new sqlite3.Database(dbPath, (err) => {
    if (err) {
        console.error('❌ Error opening database:', err.message);
        process.exit(1);
    }
    console.log('✅ Connected to database:', dbPath);
});

// Get slug from command line argument
const slug = process.argv[2];

if (!slug) {
    console.log('Usage: node debug-url-shortener.js <slug>');
    console.log('Example: node debug-url-shortener.js 67e2b731\n');
    
    // Show all short URLs in database
    console.log('📋 All short URLs in database:');
    db.all('SELECT slug, original_url, created_at, click_count FROM short_urls ORDER BY created_at DESC LIMIT 20', (err, rows) => {
        if (err) {
            console.error('❌ Error querying database:', err.message);
            db.close();
            process.exit(1);
        }
        
        if (rows.length === 0) {
            console.log('   No short URLs found in database.\n');
        } else {
            console.log(`   Found ${rows.length} short URL(s):\n`);
            rows.forEach((row, index) => {
                console.log(`   ${index + 1}. Slug: ${row.slug}`);
                console.log(`      Original: ${row.original_url}`);
                console.log(`      Created: ${row.created_at}`);
                console.log(`      Clicks: ${row.click_count}`);
                console.log(`      Short URL: https://infi.live/${row.slug}\n`);
            });
        }
        
        db.close();
    });
} else {
    // Check specific slug
    console.log(`🔎 Looking up slug: "${slug}"\n`);
    
    db.get('SELECT * FROM short_urls WHERE slug = ?', [slug], (err, row) => {
        if (err) {
            console.error('❌ Error querying database:', err.message);
            db.close();
            process.exit(1);
        }
        
        if (!row) {
            console.log('❌ Slug not found in database!\n');
            
            // Try case-insensitive search
            console.log('🔍 Trying case-insensitive search...');
            db.all('SELECT slug, original_url FROM short_urls', (err, allRows) => {
                if (err) {
                    console.error('❌ Error querying database:', err.message);
                    db.close();
                    process.exit(1);
                }
                
                const matches = allRows.filter(r => r.slug.toLowerCase() === slug.toLowerCase());
                if (matches.length > 0) {
                    console.log(`\n⚠️  Found similar slug(s) with different case:`);
                    matches.forEach(r => {
                        console.log(`   - "${r.slug}" (original: ${r.original_url})`);
                    });
                    console.log('\n💡 This suggests a case-sensitivity issue in the database query.');
                } else {
                    console.log('   No similar slugs found.\n');
                }
                
                db.close();
            });
        } else {
            console.log('✅ Slug found!\n');
            console.log('📋 Details:');
            console.log(`   Slug: ${row.slug}`);
            console.log(`   Original URL: ${row.original_url}`);
            console.log(`   Custom Slug: ${row.custom_slug === 1 ? 'Yes' : 'No'}`);
            console.log(`   Click Count: ${row.click_count}`);
            console.log(`   Created At: ${row.created_at}`);
            console.log(`   Short URL: https://infi.live/${row.slug}`);
            console.log('\n✅ This slug should work! If it doesn\'t, check:');
            console.log('   1. Apache reverse proxy configuration');
            console.log('   2. Node.js backend is running on port 3000');
            console.log('   3. Route order in server.js (/:slug should be after API routes)\n');
            
            db.close();
        }
    });
}

