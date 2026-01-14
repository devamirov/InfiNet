const express = require('express');
const router = express.Router();
const crypto = require('crypto');
const { validateUrl, validateSlug } = require('../utils/validation');
const { badRequest, conflict, notFound, internalError, asyncHandler } = require('../utils/errors');

// In-memory storage for shortened URLs (in production, use a database)
const urlDatabase = new Map();

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
  let slug = customSlug?.trim() || crypto.randomBytes(4).toString('hex');
  
  // Validate slug format if custom slug provided
  if (customSlug) {
    const slugValidation = validateSlug(customSlug);
    if (!slugValidation.valid) {
      return res.status(400).json(badRequest(slugValidation.error, 'customSlug'));
    }
    slug = slugValidation.value;
  }

  // Check if slug already exists
  if (urlDatabase.has(slug)) {
    return res.status(409).json(conflict(
      `The custom slug "${slug}" is already in use. Please choose a different one.`
    ));
  }

    // Store the URL
    urlDatabase.set(slug, {
      originalUrl: trimmedUrl,
      slug: slug,
      createdAt: new Date().toISOString(),
      clicks: 0
    });

    // Generate short URL
    const shortUrl = `https://infi.live/${slug}`;

  res.json({
    shortUrl: shortUrl,
    originalUrl: trimmedUrl,
    slug: slug,
    timestamp: new Date().toISOString()
  });
}));

/**
 * GET /api/tools/shorten-url/:slug
 * Redirect to original URL (for the shortener service)
 */
router.get('/:slug', asyncHandler(async (req, res) => {
  const { slug } = req.params;
  
  const entry = urlDatabase.get(slug);
  
  if (!entry) {
    return res.status(404).json(notFound('Short URL'));
  }

  // Increment click count
  entry.clicks++;
  urlDatabase.set(slug, entry);

  // Redirect to original URL
  res.redirect(302, entry.originalUrl);
}));

module.exports = router;

