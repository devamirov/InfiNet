const sqlite3 = require('sqlite3').verbose();
const path = require('path');

// Use the same database file as server.js (bookings.db)
const DB_PATH = path.join(__dirname, 'bookings.db');

const db = new sqlite3.Database(DB_PATH, (err) => {
  if (err) {
    console.error('Error opening database:', err.message);
    process.exit(1);
  }
  console.log('Connected to database');
  
  // Check if columns exist
  db.all("PRAGMA table_info(users)", (err, rows) => {
    if (err) {
      console.error('Error checking table info:', err);
      db.close();
      process.exit(1);
    }
    
    const hasGoogleId = rows.some(row => row.name === 'google_id');
    const hasGoogleEmail = rows.some(row => row.name === 'google_email');
    
    console.log('Current columns:', rows.map(r => r.name).join(', '));
    console.log('Has google_id:', hasGoogleId);
    console.log('Has google_email:', hasGoogleEmail);
    
    if (hasGoogleId && hasGoogleEmail) {
      console.log('✅ Columns already exist');
      db.close();
      process.exit(0);
    }
    
    // Add columns if they don't exist
    if (!hasGoogleId) {
      db.run("ALTER TABLE users ADD COLUMN google_id TEXT", (err) => {
        if (err) {
          console.error('Error adding google_id:', err);
        } else {
          console.log('✅ Added google_id column');
          
          // Create unique index
          db.run("CREATE UNIQUE INDEX IF NOT EXISTS idx_users_google_id ON users(google_id) WHERE google_id IS NOT NULL", (err) => {
            if (err) {
              console.error('Error creating index:', err);
            } else {
              console.log('✅ Created unique index on google_id');
            }
          });
        }
      });
    }
    
    if (!hasGoogleEmail) {
      db.run("ALTER TABLE users ADD COLUMN google_email TEXT", (err) => {
        if (err) {
          console.error('Error adding google_email:', err);
        } else {
          console.log('✅ Added google_email column');
        }
        db.close();
        process.exit(0);
      });
    } else {
      db.close();
      process.exit(0);
    }
  });
});
