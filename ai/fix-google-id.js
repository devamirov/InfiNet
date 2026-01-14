const sqlite3 = require('sqlite3').verbose();
const path = require('path');

const dbPath = process.env.DB_PATH || './data/database.db';
const db = new sqlite3.Database(dbPath);

console.log('Fixing google_id column...');

db.serialize(() => {
    // Check if google_id column exists
    db.all("PRAGMA table_info(users)", (err, columns) => {
        if (err) {
            console.error('Error:', err);
            db.close();
            process.exit(1);
        }
        
        const columnNames = columns.map(col => col.name);
        
        if (!columnNames.includes('google_id')) {
            // Add google_id column without UNIQUE constraint first
            db.run('ALTER TABLE users ADD COLUMN google_id TEXT', (err) => {
                if (err) {
                    console.error('Error adding google_id:', err.message);
                } else {
                    console.log('✓ Added google_id column');
                    
                    // Create unique index
                    db.run('CREATE UNIQUE INDEX IF NOT EXISTS idx_users_google_id ON users(google_id)', (err) => {
                        if (err) {
                            console.error('Error creating index:', err.message);
                        } else {
                            console.log('✓ Created unique index on google_id');
                        }
                        db.close();
                        process.exit(0);
                    });
                }
            });
        } else {
            console.log('google_id column already exists');
            
            // Ensure unique index exists
            db.run('CREATE UNIQUE INDEX IF NOT EXISTS idx_users_google_id ON users(google_id)', (err) => {
                if (err) {
                    console.error('Error creating index:', err.message);
                } else {
                    console.log('✓ Unique index on google_id is ready');
                }
                db.close();
                process.exit(0);
            });
        }
    });
});

