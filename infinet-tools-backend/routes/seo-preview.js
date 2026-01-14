const express = require('express');
const router = express.Router();

/**
 * POST /api/tools/seo-preview
 * Generate SEO preview data
 */
router.post('/', async (req, res) => {
  try {
    const { title, description, url } = req.body;

    if (!title || typeof title !== 'string') {
      return res.status(400).json({
        error: 'Title is required',
        status: 400
      });
    }

    if (!description || typeof description !== 'string') {
      return res.status(400).json({
        error: 'Description is required',
        status: 400
      });
    }

    if (!url || typeof url !== 'string') {
      return res.status(400).json({
        error: 'URL is required',
        status: 400
      });
    }

    // Calculate SEO score (simple algorithm)
    let score = 0;
    
    // Title score (max 30 points)
    if (title.length >= 30 && title.length <= 60) {
      score += 30;
    } else if (title.length > 0) {
      score += Math.max(0, 30 - Math.abs(title.length - 45) * 2);
    }

    // Description score (max 40 points)
    if (description.length >= 120 && description.length <= 160) {
      score += 40;
    } else if (description.length > 0) {
      score += Math.max(0, 40 - Math.abs(description.length - 140) * 0.5);
    }

    // URL score (max 10 points)
    if (url.length <= 60) {
      score += 10;
    } else {
      score += Math.max(0, 10 - (url.length - 60) * 0.1);
    }

    // Keywords presence (max 20 points)
    const keywordsInTitle = title.toLowerCase().split(/\s+/).length;
    const keywordsInDescription = description.toLowerCase().split(/\s+/).length;
    score += Math.min(20, (keywordsInTitle + keywordsInDescription) * 0.5);

    // Ensure score is between 0 and 100
    score = Math.max(0, Math.min(100, Math.round(score)));

    const preview = {
      title: title.trim(),
      description: description.trim(),
      url: url.trim(),
      score: score
    };

    res.json({
      preview,
      timestamp: new Date().toISOString()
    });

  } catch (error) {
    console.error('SEO preview error:', error);
    res.status(500).json({
      error: 'Failed to generate SEO preview',
      status: 500
    });
  }
});

module.exports = router;

