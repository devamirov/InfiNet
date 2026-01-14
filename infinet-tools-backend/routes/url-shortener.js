const express = require('express');
const router = express.Router();
const crypto = require('crypto');
const sqlite3 = require('sqlite3').verbose();
const path = require('path');
const { validateUrl, validateSlug } = require('../utils/validation');
const { badRequest, conflict, notFound, internalError, asyncHandler } = require('../utils/errors');

// Use the same database as the main backend
const dbPath = path.join(__dirname, '../../backend/bookings.db');
const db = new sqlite3.Database(dbPath, (err) => {
  if (err) {
    console.error('❌ Error connecting to database:', err.message);
  } else {
    console.log('✅ URL Shortener connected to database:', dbPath);
  }
});

/**
 * POST /api/tools/shorten-url
 * Shorten a URL
 */
router.post('/', asyncHandler(async (req, res) => {
  const { url, customSlug } = req.body;

  // Validate URL using utility
  const urlValidation = validateUrl(url);
  if (!urlValidation.valid) {
    return res.status(400).json(badRequest(urlValidation.error, 'url'));
  }

  const trimmedUrl = urlValidation.value;

  // Generate or use custom slug
  const generateSlug = () => {
    return Math.random().toString(36).substring(2, 9);
  };
  
  let slug = customSlug?.trim() || generateSlug();
  
  // Validate slug format if custom slug provided
  if (customSlug) {
    const slugValidation = validateSlug(customSlug);
    if (!slugValidation.valid) {
      return res.status(400).json(badRequest(slugValidation.error, 'customSlug'));
    }
    slug = slugValidation.value;
  }

  // Validate slug format (alphanumeric and hyphens only, 3-20 chars)
  if (!/^[a-zA-Z0-9_-]{3,20}$/.test(slug)) {
    return res.status(400).json(badRequest('Invalid slug format. Use 3-20 alphanumeric characters, hyphens, or underscores.', 'slug'));
  }

  // Check if slug already exists in database
  return new Promise((resolve, reject) => {
    db.get('SELECT * FROM short_urls WHERE slug = ?', [slug], (err, existing) => {
      if (err) {
        console.error('❌ Database error checking slug:', err.message);
        return reject(internalError('Database error'));
      }
      
      if (existing) {
        if (customSlug) {
          return resolve(res.status(409).json(conflict('This custom slug is already taken')));
        } else {
          // Retry with new slug if auto-generated one exists
          slug = generateSlug();
          return createShortUrl(slug, trimmedUrl, customSlug, res, resolve, reject);
        }
      }
      
      createShortUrl(slug, trimmedUrl, customSlug, res, resolve, reject);
    });
  });
}));

function createShortUrl(slug, url, customSlug, res, resolve, reject) {
  console.log(`📝 Creating short URL: slug="${slug}", url="${url}", customSlug=${customSlug ? 1 : 0}`);
  
  db.run(
    'INSERT INTO short_urls (slug, original_url, custom_slug) VALUES (?, ?, ?)',
    [slug, url, customSlug ? 1 : 0],
    function(err) {
      if (err) {
        console.error(`❌ Database INSERT error for slug "${slug}":`, err.message);
        if (err.message.includes('UNIQUE constraint')) {
          return resolve(res.status(409).json(conflict('This slug is already taken')));
        }
        return reject(internalError('Failed to create short URL'));
      }
      
      console.log(`✅ Short URL created successfully: slug="${slug}", rowId=${this.lastID}`);
      
      const shortUrl = `https://infi.live/${slug}`;
      return resolve(res.status(201).json({
        shortUrl: shortUrl,
        originalUrl: url,
        slug: slug,
        timestamp: new Date().toISOString()
      }));
    }
  );
}

/**
 * GET /api/tools/shorten-url/:slug
 * Redirect to original URL (for the shortener service)
 * NOTE: This route is not actually used - redirects are handled by main backend's /:slug route
 */
router.get('/:slug', asyncHandler(async (req, res) => {
  const { slug } = req.params;
  
  db.get('SELECT * FROM short_urls WHERE slug = ?', [slug], (err, row) => {
    if (err) {
      console.error('❌ Database error looking up slug:', err.message);
      return res.status(500).json(internalError('Database error'));
    }
    
    if (!row) {
      return res.status(404).json(notFound('Short URL'));
    }

    // Update click count
    db.run('UPDATE short_urls SET click_count = click_count + 1 WHERE slug = ?', [slug], (err) => {
      if (err) console.error('Error updating click count:', err);
    });

    // Redirect to original URL
    res.redirect(301, row.original_url);
  });
}));

module.exports = router;
