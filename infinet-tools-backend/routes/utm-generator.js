const express = require('express');
const router = express.Router();

/**
 * POST /api/tools/utm-generator
 * Generate UTM parameter URL
 */
router.post('/', async (req, res) => {
  try {
    const { url, source, medium, campaign, term, content } = req.body;

    if (!url || typeof url !== 'string') {
      return res.status(400).json({
        error: 'URL is required',
        status: 400
      });
    }

    if (!source || typeof source !== 'string') {
      return res.status(400).json({
        error: 'Source is required',
        status: 400
      });
    }

    if (!medium || typeof medium !== 'string') {
      return res.status(400).json({
        error: 'Medium is required',
        status: 400
      });
    }

    if (!campaign || typeof campaign !== 'string') {
      return res.status(400).json({
        error: 'Campaign is required',
        status: 400
      });
    }

    // Validate URL format
    try {
      new URL(url);
    } catch (error) {
      return res.status(400).json({
        error: 'Invalid URL format',
        status: 400
      });
    }

    // Build UTM parameters
    const params = new URLSearchParams();
    params.append('utm_source', source.trim());
    params.append('utm_medium', medium.trim());
    params.append('utm_campaign', campaign.trim());
    
    if (term && typeof term === 'string' && term.trim()) {
      params.append('utm_term', term.trim());
    }
    
    if (content && typeof content === 'string' && content.trim()) {
      params.append('utm_content', content.trim());
    }

    // Construct final URL
    const separator = url.includes('?') ? '&' : '?';
    const utmUrl = `${url}${separator}${params.toString()}`;

    res.json({
      url: utmUrl,
      timestamp: new Date().toISOString()
    });

  } catch (error) {
    console.error('UTM generator error:', error);
    res.status(500).json({
      error: 'Failed to generate UTM URL',
      status: 500
    });
  }
});

module.exports = router;

