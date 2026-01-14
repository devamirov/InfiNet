const path = require('path');
const fs = require('fs');
const Database = require('better-sqlite3');

const DB_DIR = process.env.TOOL_HISTORY_DB_DIR || path.join(__dirname, '../data');
const DB_PATH = process.env.TOOL_HISTORY_DB || path.join(DB_DIR, 'tool-history.db');

fs.mkdirSync(DB_DIR, { recursive: true });

const db = new Database(DB_PATH);
db.pragma('journal_mode = WAL');

db.exec(`
  CREATE TABLE IF NOT EXISTS tool_history (
    id TEXT PRIMARY KEY,
    userId TEXT,
    source TEXT,
    tool TEXT NOT NULL,
    summary TEXT,
    input_json TEXT,
    output_json TEXT,
    timestamp TEXT NOT NULL
  )
`);

db.exec(`
  CREATE INDEX IF NOT EXISTS idx_tool_history_userId ON tool_history(userId)
`);

db.exec(`
  CREATE INDEX IF NOT EXISTS idx_tool_history_timestamp ON tool_history(timestamp DESC)
`);

const INSERT_ENTRY = db.prepare(`
  INSERT OR REPLACE INTO tool_history (id, userId, source, tool, summary, input_json, output_json, timestamp)
  VALUES (@id, @userId, @source, @tool, @summary, @input_json, @output_json, @timestamp)
`);

const SELECT_HISTORY = db.prepare(`
  SELECT id, userId, source, tool, summary, input_json, output_json, timestamp
  FROM tool_history
  WHERE
    (@userId IS NOT NULL AND userId = @userId)
    OR (@userId IS NULL AND userId IS NULL)
  ORDER BY datetime(timestamp) DESC
  LIMIT @limit
`);

const SELECT_HISTORY_WITH_GUESTS = db.prepare(`
  SELECT id, userId, source, tool, summary, input_json, output_json, timestamp
  FROM tool_history
  WHERE
    (userId = @userId)
    OR (@includeGuests = 1 AND userId IS NULL)
  ORDER BY datetime(timestamp) DESC
  LIMIT @limit
`);

function serializeEntry(entry) {
  return {
    id: entry.id,
    userId: entry.userId || null,
    source: entry.source || null,
    tool: entry.tool,
    summary: entry.summary || null,
    input_json: JSON.stringify(entry.input || {}),
    output_json: JSON.stringify(entry.output || {}),
    timestamp: entry.timestamp || new Date().toISOString()
  };
}

function saveEntry(entry) {
  const record = serializeEntry(entry);
  INSERT_ENTRY.run(record);
}

function parseRow(row) {
  return {
    id: row.id,
    userId: row.userId || undefined,
    source: row.source || undefined,
    tool: row.tool,
    summary: row.summary || undefined,
    input: row.input_json ? JSON.parse(row.input_json) : {},
    output: row.output_json ? JSON.parse(row.output_json) : {},
    timestamp: row.timestamp
  };
}

function getHistory(options = {}) {
  const {
    userId = null,
    limit = 25,
    includeGuests = false
  } = options;

  const sanitizedLimit = Math.min(Math.max(parseInt(limit, 10) || 25, 1), 100);

  if (userId) {
    const rows = SELECT_HISTORY_WITH_GUESTS.all({
      userId,
      includeGuests: includeGuests ? 1 : 0,
      limit: sanitizedLimit
    });
    return rows.map(parseRow);
  }

  const rows = SELECT_HISTORY.all({
    userId: null,
    limit: sanitizedLimit
  });
  return rows.map(parseRow);
}

module.exports = {
  saveEntry,
  getHistory
};




















