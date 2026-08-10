#!/usr/bin/env node
/**
 * One-off script: delete specific slugs from short_urls (no apt sqlite3 needed).
 * Run from backend folder: node delete-short-url-slugs.js
 * Usage: node delete-short-url-slugs.js [slug1] [slug2] ...
 *        node delete-short-url-slugs.js --list   (list all slugs, to see exact values in DB)
 * Default slugs if none given: InfiNet, Amir
 */
const sqlite3 = require('sqlite3').verbose();
const path = require('path');

const dbPath = path.join(__dirname, 'bookings.db');
const args = process.argv.slice(2);
const isList = args.includes('--list');
const defaultSlugs = ['InfiNet', 'Amir'];
const slugs = isList ? [] : (args.filter(a => a !== '--list').length > 0 ? args.filter(a => a !== '--list') : defaultSlugs);

const db = new sqlite3.Database(dbPath, (err) => {
  if (err) {
    console.error('Error opening database:', err.message);
    process.exit(1);
  }
});

if (isList) {
  db.all('SELECT slug, original_url, created_at FROM short_urls ORDER BY slug', [], (err, rows) => {
    if (err) {
      console.error('Error listing:', err.message);
      db.close();
      process.exit(1);
    }
    console.log('Slugs in DB (exact as stored):');
    console.log(rows.length ? rows.map(r => `  "${r.slug}" -> ${r.original_url}`).join('\n') : '  (none)');
    db.close();
  });
  return;
}

function runDelete(slug, cb) {
  db.run('DELETE FROM short_urls WHERE LOWER(slug) = LOWER(?)', [slug], function (err) {
    if (err) {
      console.error(`Error deleting slug "${slug}":`, err.message);
      return cb(err);
    }
    console.log(`Deleted slug "${slug}": ${this.changes} row(s)`);
    cb();
  });
}

let done = 0;
slugs.forEach((slug) => {
  runDelete(slug, () => {
    done++;
    if (done === slugs.length) {
      db.close();
      console.log('Done.');
    }
  });
});
