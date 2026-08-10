const express = require('express');
const router = express.Router();

/**
 * POST /api/tools/color-palette
 * Generate color palette from base color(s)
 */
router.post('/', async (req, res) => {
  try {
    const { baseColor } = req.body;

    if (!baseColor || typeof baseColor !== 'string') {
      return res.status(400).json({
        error: 'Base color is required',
        status: 400
      });
    }

    // Helper to convert color name to hex
    const colorNameToHex = (name) => {
      const colorMap = {
        blue: '#0000FF',
        red: '#FF0000',
        green: '#00FF00',
        yellow: '#FFFF00',
        purple: '#8000FF',
        orange: '#FF8000',
        pink: '#FF00FF',
        cyan: '#00FFFF',
        white: '#FFFFFF',
        black: '#000000',
        grey: '#808080',
        gray: '#808080'
      };
      return colorMap[name.toLowerCase().trim()] || null;
    };

    // Helper to parse color input to hex
    const parseColorToHex = (input) => {
      const trimmed = input.trim();
      const hexMatch = trimmed.match(/#([0-9A-Fa-f]{6})/);
      if (hexMatch) {
        return `#${hexMatch[1].toUpperCase()}`;
      }
      return colorNameToHex(trimmed);
    };

    // Helper to mix two colors
    const mixColors = (color1, color2, weight1, weight2) => {
      const r = Math.round(parseInt(color1.slice(1, 3), 16) * weight1 + parseInt(color2.slice(1, 3), 16) * weight2);
      const g = Math.round(parseInt(color1.slice(3, 5), 16) * weight1 + parseInt(color2.slice(3, 5), 16) * weight2);
      const b = Math.round(parseInt(color1.slice(5, 7), 16) * weight1 + parseInt(color2.slice(5, 7), 16) * weight2);
      
      const toHex = (n) => Math.max(0, Math.min(255, n)).toString(16).padStart(2, '0').toUpperCase();
      return `#${toHex(r)}${toHex(g)}${toHex(b)}`;
    };

    // Helper to mix three colors
    const mixThreeColors = (colors, weights) => {
      const r = Math.round(
        parseInt(colors[0].slice(1, 3), 16) * weights[0] +
        parseInt(colors[1].slice(1, 3), 16) * weights[1] +
        parseInt(colors[2].slice(1, 3), 16) * weights[2]
      );
      const g = Math.round(
        parseInt(colors[0].slice(3, 5), 16) * weights[0] +
        parseInt(colors[1].slice(3, 5), 16) * weights[1] +
        parseInt(colors[2].slice(3, 5), 16) * weights[2]
      );
      const b = Math.round(
        parseInt(colors[0].slice(5, 7), 16) * weights[0] +
        parseInt(colors[1].slice(5, 7), 16) * weights[1] +
        parseInt(colors[2].slice(5, 7), 16) * weights[2]
      );
      
      const toHex = (n) => Math.max(0, Math.min(255, n)).toString(16).padStart(2, '0').toUpperCase();
      return `#${toHex(r)}${toHex(g)}${toHex(b)}`;
    };

    let baseHex = '#00F0FF'; // Default fallback
    const colorParts = baseColor.split(/\s+/).filter(part => part.trim().length > 0);

    let palette = [];

    if (colorParts.length >= 2) {
      // Multiple colors - mix them
      const colors = [];
      for (const part of colorParts) {
        const hex = parseColorToHex(part);
        if (hex) colors.push(hex);
      }

      if (colors.length > 3) {
        return res.status(400).json({
          error: 'Maximum 3 colors can be mixed. Please enter 1-3 colors separated by spaces.',
          status: 400
        });
      }

      if (colors.length === 3) {
        // Mix three colors
        const blends = [
          { weights: [0.33, 0.33, 0.34], label: '33% / 33% / 34%' },
          { weights: [0.25, 0.50, 0.25], label: '25% / 50% / 25%' },
          { weights: [0.50, 0.25, 0.25], label: '50% / 25% / 25%' },
          { weights: [0.20, 0.60, 0.20], label: '20% / 60% / 20%' },
          { weights: [0.40, 0.20, 0.40], label: '40% / 20% / 40%' }
        ];

        palette = blends.map((b, i) => ({
          hex: mixThreeColors(colors, b.weights),
          type: i === 0 ? 'Primary' : `Blend ${i + 1}`,
          percentages: b.label
        }));
      } else if (colors.length === 2) {
        // Mix two colors
        const blends = [
          { weight1: 0.5, weight2: 0.5, label: '50% / 50%' },
          { weight1: 0.25, weight2: 0.75, label: '25% / 75%' },
          { weight1: 0.3, weight2: 0.7, label: '30% / 70%' },
          { weight1: 0.6, weight2: 0.4, label: '60% / 40%' },
          { weight1: 0.2, weight2: 0.8, label: '20% / 80%' }
        ];

        palette = blends.map((b, i) => ({
          hex: mixColors(colors[0], colors[1], b.weight1, b.weight2),
          type: i === 0 ? 'Primary' : `Blend ${i + 1}`,
          percentages: b.label
        }));
      } else {
        baseHex = colors[0];
      }
    } else {
      // Single color
      const hexMatch = baseColor.match(/#([0-9A-Fa-f]{6})/);
      if (hexMatch) {
        baseHex = `#${hexMatch[1].toUpperCase()}`;
      } else {
        const colorHex = parseColorToHex(baseColor);
        if (colorHex) baseHex = colorHex;
      }
    }

    // Generate variations for single color
    if (palette.length === 0) {
      const r = parseInt(baseHex.slice(1, 3), 16);
      const g = parseInt(baseHex.slice(3, 5), 16);
      const b = parseInt(baseHex.slice(5, 7), 16);

      const toHex = (n) => Math.max(0, Math.min(255, n)).toString(16).padStart(2, '0').toUpperCase();

      // Special handling for white and black
      const isWhite = baseHex === '#FFFFFF';
      const isBlack = baseHex === '#000000';

      if (isWhite) {
        // For white, only generate darker shades
        const darker1 = `#${toHex(Math.max(0, r - 20))}${toHex(Math.max(0, g - 20))}${toHex(Math.max(0, b - 20))}`;
        const darker2 = `#${toHex(Math.max(0, r - 40))}${toHex(Math.max(0, g - 40))}${toHex(Math.max(0, b - 40))}`;
        palette = [
          { hex: baseHex, type: 'Primary' },
          { hex: darker1, type: 'Darker 1' },
          { hex: darker2, type: 'Darker 2' }
        ];
      } else if (isBlack) {
        // For black, only generate lighter shades
        const lighter1 = `#${toHex(Math.min(255, r + 40))}${toHex(Math.min(255, g + 40))}${toHex(Math.min(255, b + 40))}`;
        const lighter2 = `#${toHex(Math.min(255, r + 20))}${toHex(Math.min(255, g + 20))}${toHex(Math.min(255, b + 20))}`;
        palette = [
          { hex: baseHex, type: 'Primary' },
          { hex: lighter2, type: 'Lighter 1' },
          { hex: lighter1, type: 'Lighter 2' }
        ];
      } else {
        // For other colors, generate both lighter and darker shades
        const lighter1 = `#${toHex(Math.min(255, r + 40))}${toHex(Math.min(255, g + 40))}${toHex(Math.min(255, b + 40))}`;
        const lighter2 = `#${toHex(Math.min(255, r + 20))}${toHex(Math.min(255, g + 20))}${toHex(Math.min(255, b + 20))}`;
        const darker1 = `#${toHex(Math.max(0, r - 20))}${toHex(Math.max(0, g - 20))}${toHex(Math.max(0, b - 20))}`;
        const darker2 = `#${toHex(Math.max(0, r - 40))}${toHex(Math.max(0, g - 40))}${toHex(Math.max(0, b - 40))}`;

        palette = [
          { hex: baseHex, type: 'Primary' },
          { hex: lighter2, type: 'Lighter 1' },
          { hex: lighter1, type: 'Lighter 2' },
          { hex: darker1, type: 'Darker 1' },
          { hex: darker2, type: 'Darker 2' }
        ];
      }

      // Remove duplicates
      const uniqueColors = new Set();
      palette = palette.filter(color => {
        if (uniqueColors.has(color.hex)) return false;
        uniqueColors.add(color.hex);
        return true;
      }).slice(0, 6);
    }

    res.json({
      palette,
      timestamp: new Date().toISOString()
    });

  } catch (error) {
    console.error('Color palette generation error:', error);
    res.status(500).json({
      error: 'Failed to generate color palette',
      status: 500
    });
  }
});

module.exports = router;

