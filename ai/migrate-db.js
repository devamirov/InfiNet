const sqlite3 = require('sqlite3').verbose();
const path = require('path');

const dbPath = process.env.DB_PATH || './data/database.db';
const db = new sqlite3.Database(dbPath);

console.log('Starting database migration...');

db.serialize(() => {
    // Get current schema
    db.all("PRAGMA table_info(users)", (err, columns) => {
        if (err) {
            console.error('Error getting table info:', err);
            process.exit(1);
        }
        
        const columnNames = columns.map(col => col.name);
        console.log('Existing columns:', columnNames);
        
        // Add missing columns
        const columnsToAdd = [
            { name: 'profile_picture', sql: 'ALTER TABLE users ADD COLUMN profile_picture TEXT' },
            { name: 'display_name', sql: 'ALTER TABLE users ADD COLUMN display_name TEXT' },
            { name: 'bio', sql: 'ALTER TABLE users ADD COLUMN bio TEXT' },
            { name: 'email_verified', sql: 'ALTER TABLE users ADD COLUMN email_verified INTEGER DEFAULT 0' },
            { name: 'google_id', sql: 'ALTER TABLE users ADD COLUMN google_id TEXT UNIQUE' },
            { name: 'updated_at', sql: 'ALTER TABLE users ADD COLUMN updated_at DATETIME DEFAULT CURRENT_TIMESTAMP' }
        ];
        
        let added = 0;
        columnsToAdd.forEach(({ name, sql }) => {
            if (!columnNames.includes(name)) {
                db.run(sql, (err) => {
                    if (err) {
                        if (err.message.includes('duplicate column')) {
                            console.log(`Column ${name} already exists, skipping...`);
                        } else {
                            console.error(`Error adding column ${name}:`, err.message);
                        }
                    } else {
                        console.log(`✓ Added column: ${name}`);
                        added++;
                    }
                });
            } else {
                console.log(`- Column ${name} already exists`);
            }
        });
        
        setTimeout(() => {
            console.log(`\nMigration complete! Added ${added} columns.`);
            db.close();
            process.exit(0);
        }, 1000);
    });
});

