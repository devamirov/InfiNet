const express = require('express');
const router = express.Router();

/**
 * POST /api/tools/business-names
 * Generate business name suggestions
 */
router.post('/', async (req, res) => {
  try {
    const { keywords } = req.body;

    if (!keywords || typeof keywords !== 'string') {
      return res.status(400).json({
        error: 'Keywords are required',
        status: 400
      });
    }

    const keywordTokens = keywords.split(/[\s,]+/)
      .map(k => k.trim())
      .filter(Boolean);

    const suffixes = ['Labs', 'Tech', 'Solutions', 'Systems', 'Studio', 'Co', 'Works', 'Hub', 'Platform', 'AI'];
    const prefixes = ['Nexus', 'Apex', 'Vertex', 'Pulse', 'Spark', 'Flux', 'Nova', 'Quantum', 'Hyper', 'Meta'];
    
    const names = [];
    
    const toTitleCase = (str) => {
      return str.charAt(0).toUpperCase() + str.slice(1).toLowerCase();
    };

    const randomFrom = (array) => {
      return array[Math.floor(Math.random() * array.length)];
    };

    for (let i = 0; i < 5; i++) {
      let name = '';
      
      if (keywordTokens.length > 0) {
        const keyword = keywordTokens[i % keywordTokens.length];
        const variation = i % 3;
        
        if (variation === 0) {
          name = `${toTitleCase(keyword)}${randomFrom(suffixes)}`;
        } else if (variation === 1) {
          name = `${randomFrom(prefixes)}${toTitleCase(keyword)}`;
        } else {
          name = `${toTitleCase(keyword)}${randomFrom(['Pro', 'Plus', 'Max', 'Elite'])}`;
        }
      } else {
        name = `${randomFrom(prefixes)}${randomFrom(suffixes)}`;
      }
      
      const domain = `${name.toLowerCase().replace(/\s+/g, '')}.com`;
      const availability = Math.random() > 0.3 ? 'Available' : 'Taken';
      
      names.push({
        name,
        availability,
        domain
      });
    }

    res.json({
      names,
      timestamp: new Date().toISOString()
    });

  } catch (error) {
    console.error('Business names generation error:', error);
    res.status(500).json({
      error: 'Failed to generate business names',
      status: 500
    });
  }
});

module.exports = router;

