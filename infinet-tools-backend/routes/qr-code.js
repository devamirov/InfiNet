const express = require('express');
const router = express.Router();
const QRCode = require('qrcode');
const { validateUrl } = require('../utils/validation');
const { badRequest, internalError, asyncHandler } = require('../utils/errors');

/**
 * POST /api/tools/qr
 * Generate QR code for a URL
 */
router.post('/', asyncHandler(async (req, res) => {
  const { url, label } = req.body;

  // Validate URL using utility
  const urlValidation = validateUrl(url);
  if (!urlValidation.valid) {
    return res.status(400).json(badRequest(urlValidation.error, 'url'));
  }

  const trimmedUrl = urlValidation.value;

  // Generate QR code as SVG string
  try {
    const qrSvg = await QRCode.toString(trimmedUrl, {
      type: 'svg',
      width: 300,
      margin: 2,
      color: {
        dark: '#05233B',
        light: '#FFFFFF'
      }
    });

    res.json({
      qrData: {
        svgValue: trimmedUrl,
        label: label || 'InfiNet QR'
      },
      svg: qrSvg,
      timestamp: new Date().toISOString()
    });

  } catch (error) {
    // QR code generation failed
    throw internalError(
      'Failed to generate QR code. The URL may be too long or contain invalid characters.',
      error
    );
  }
}));

module.exports = router;

