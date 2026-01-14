const sqlite3 = require('sqlite3').verbose();

const dbPath = process.env.DB_PATH || './data/database.db';
const db = new sqlite3.Database(dbPath);

console.log('Fixing password column to allow NULL...');

db.serialize(() => {
    // SQLite doesn't support ALTER COLUMN, so we need to recreate the table
    // First, check current schema
    db.all("PRAGMA table_info(users)", (err, columns) => {
        if (err) {
            console.error('Error:', err);
            db.close();
            process.exit(1);
        }
        
        const passwordCol = columns.find(col => col.name === 'password');
        if (passwordCol && passwordCol.notnull === 1) {
            console.log('Password column has NOT NULL constraint, need to fix...');
            
            // Create backup table
            db.run(`CREATE TABLE users_backup AS SELECT * FROM users`, (err) => {
                if (err) {
                    console.error('Error creating backup:', err);
                    db.close();
                    process.exit(1);
                }
                
                console.log('✓ Created backup table');
                
                // Drop old table
                db.run(`DROP TABLE users`, (err) => {
                    if (err) {
                        console.error('Error dropping table:', err);
                        db.close();
                        process.exit(1);
                    }
                    
                    console.log('✓ Dropped old table');
                    
                    // Create new table with NULL allowed for password
                    db.run(`CREATE TABLE users (
                        id INTEGER PRIMARY KEY AUTOINCREMENT,
                        email TEXT UNIQUE NOT NULL,
                        password TEXT,
                        plan TEXT DEFAULT 'free',
                        profile_picture TEXT,
                        display_name TEXT,
                        bio TEXT,
                        email_verified INTEGER DEFAULT 0,
                        google_id TEXT,
                        created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
                        updated_at DATETIME DEFAULT CURRENT_TIMESTAMP
                    )`, (err) => {
                        if (err) {
                            console.error('Error creating new table:', err);
                            db.close();
                            process.exit(1);
                        }
                        
                        console.log('✓ Created new table with NULL password');
                        
                        // Copy data back
                        db.run(`INSERT INTO users SELECT * FROM users_backup`, (err) => {
                            if (err) {
                                console.error('Error copying data:', err);
                                db.close();
                                process.exit(1);
                            }
                            
                            console.log('✓ Copied data back');
                            
                            // Drop backup
                            db.run(`DROP TABLE users_backup`, (err) => {
                                if (err) {
                                    console.error('Error dropping backup:', err);
                                } else {
                                    console.log('✓ Dropped backup table');
                                }
                                
                                // Recreate unique index
                                db.run(`CREATE UNIQUE INDEX IF NOT EXISTS idx_users_google_id ON users(google_id)`, (err) => {
                                    if (err) {
                                        console.error('Error creating index:', err);
                                    } else {
                                        console.log('✓ Recreated unique index');
                                    }
                                    
                                    console.log('\n✅ Migration complete! Password column now allows NULL.');
                                    db.close();
                                    process.exit(0);
                                });
                            });
                        });
                    });
                });
            });
        } else {
            console.log('Password column already allows NULL, no changes needed.');
            db.close();
            process.exit(0);
        }
    });
});

