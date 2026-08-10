const express = require('express');
const router = express.Router();
const multer = require('multer');
const sharp = require('sharp');
const path = require('path');

// Configure multer for memory storage
const upload = multer({
  storage: multer.memoryStorage(),
  limits: {
    fileSize: 10 * 1024 * 1024 // 10MB limit
  },
  fileFilter: (req, file, cb) => {
    const allowedTypes = /jpeg|jpg|png|gif|webp/;
    const extname = allowedTypes.test(path.extname(file.originalname).toLowerCase());
    const mimetype = allowedTypes.test(file.mimetype);
    
    if (mimetype && extname) {
      return cb(null, true);
    } else {
      cb(new Error('Only image files are allowed'));
    }
  }
});

/**
 * POST /api/tools/generate-favicon
 * Generate favicon in multiple sizes
 */
router.post('/', upload.single('image'), async (req, res) => {
  try {
    if (!req.file) {
      return res.status(400).json({
        error: 'Image file is required',
        status: 400
      });
    }

    const imageBuffer = req.file.buffer;
    
    // Security: Validate image content using magic bytes (MIME type verification)
    const isValidImage = (
      // JPEG signature
      (imageBuffer[0] === 0xFF && imageBuffer[1] === 0xD8 && imageBuffer[2] === 0xFF) ||
      // PNG signature
      (imageBuffer[0] === 0x89 && imageBuffer[1] === 0x50 && imageBuffer[2] === 0x4E && imageBuffer[3] === 0x47) ||
      // GIF signature
      (imageBuffer[0] === 0x47 && imageBuffer[1] === 0x49 && imageBuffer[2] === 0x46 && imageBuffer[3] === 0x38) ||
      // WebP RIFF signature
      (imageBuffer[0] === 0x52 && imageBuffer[1] === 0x49 && imageBuffer[2] === 0x46 && imageBuffer[3] === 0x46 && imageBuffer.length > 12 && imageBuffer[8] === 0x57 && imageBuffer[9] === 0x45 && imageBuffer[10] === 0x42 && imageBuffer[11] === 0x50)
    );
    
    if (!isValidImage) {
      return res.status(415).json({
        error: 'Invalid image file. File content does not match declared image type.',
        status: 415
      });
    }
    
    // Favicon sizes to generate
    const sizes = [
      { size: '16x16', format: 'png' },
      { size: '32x32', format: 'png' },
      { size: '180x180', format: 'png' }, // Apple touch icon
      { size: '192x192', format: 'png' }, // Android
      { size: '512x512', format: 'png' }  // High-res
    ];

    const favicons = [];

    for (const faviconSize of sizes) {
      const dimensions = faviconSize.size.split('x').map(d => parseInt(d, 10));
      const width = dimensions[0];
      const height = dimensions[1];

      try {
        // Resize and process image
        const processedBuffer = await sharp(imageBuffer)
          .resize(width, height, {
            fit: 'contain',
            background: { r: 255, g: 255, b: 255, alpha: 0 }
          })
          .toFormat(faviconSize.format)
          .toBuffer();

        // Convert to base64
        const base64Image = processedBuffer.toString('base64');
        const dataUri = `data:image/${faviconSize.format};base64,${base64Image}`;

        favicons.push({
          size: faviconSize.size,
          uri: dataUri,
          format: faviconSize.format,
          fileName: `favicon-${faviconSize.size}.${faviconSize.format}`
        });

      } catch (error) {
        console.error(`Error generating ${faviconSize.size} favicon:`, error);
        // Continue with other sizes even if one fails
      }
    }

    if (favicons.length === 0) {
      return res.status(500).json({
        error: 'Failed to generate favicons',
        status: 500
      });
    }

    res.json({
      favicons,
      timestamp: new Date().toISOString()
    });

  } catch (error) {
    console.error('Favicon generation error:', error);
    res.status(500).json({
      error: 'Failed to generate favicon',
      message: error.message || 'Favicon generation failed',
      status: 500
    });
  }
});

module.exports = router;

