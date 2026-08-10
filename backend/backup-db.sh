#!/bin/bash
# Database Backup Script for InfiNet Backend
# This script creates a timestamped backup of the SQLite database

# Configuration
BACKUP_DIR="/var/www/infinet.services/backend/backups"
DB_PATH="/var/www/infinet.services/backend/bookings.db"
RETENTION_DAYS=30  # Keep backups for 30 days

# Create backup directory if it doesn't exist
mkdir -p "$BACKUP_DIR"

# Generate backup filename with timestamp
TIMESTAMP=$(date +%Y%m%d_%H%M%S)
BACKUP_FILE="$BACKUP_DIR/bookings_${TIMESTAMP}.db"

# Create backup
if [ -f "$DB_PATH" ]; then
    cp "$DB_PATH" "$BACKUP_FILE"
    
    # Compress the backup to save space
    gzip "$BACKUP_FILE"
    
    echo "✅ Database backup created: ${BACKUP_FILE}.gz"
    
    # Remove old backups (older than RETENTION_DAYS)
    find "$BACKUP_DIR" -name "bookings_*.db.gz" -type f -mtime +$RETENTION_DAYS -delete
    
    echo "✅ Old backups cleaned (kept last $RETENTION_DAYS days)"
else
    echo "❌ Error: Database file not found at $DB_PATH"
    exit 1
fi

