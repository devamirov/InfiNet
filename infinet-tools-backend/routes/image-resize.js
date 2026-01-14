const express = require('express');
const router = express.Router();
const multer = require('multer');
const sharp = require('sharp');
const path = require('path');
const fs = require('fs').promises;

// Configure multer for memory storage
const upload = multer({
  storage: multer.memoryStorage(),
  limits: {
    fileSize: 50 * 1024 * 1024 // 50MB limit
  },
  fileFilter: (req, file, cb) => {
    const allowedTypes = /jpeg|jpg|png|gif|webp|bmp|tiff/;
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
 * POST /api/tools/resize-image
 * Resize and compress images
 */
router.post('/', upload.single('image'), async (req, res) => {
  let tempFilePath = null;
  
  try {
    if (!req.file) {
      return res.status(400).json({
        error: 'Image file is required',
        status: 400
      });
    }

    const { width, height, maintainAspectRatio, quality } = req.body;
    
    const targetWidth = width ? parseInt(width, 10) : null;
    const targetHeight = height ? parseInt(height, 10) : null;
    const keepAspectRatio = maintainAspectRatio === 'true' || maintainAspectRatio === true;
    const compressionQuality = quality ? parseInt(quality, 10) : 80;

    if (targetWidth && (targetWidth < 1 || targetWidth > 10000)) {
      return res.status(400).json({
        error: 'Width must be between 1 and 10000',
        status: 400
      });
    }

    if (targetHeight && (targetHeight < 1 || targetHeight > 10000)) {
      return res.status(400).json({
        error: 'Height must be between 1 and 10000',
        status: 400
      });
    }

    if (compressionQuality < 1 || compressionQuality > 100) {
      return res.status(400).json({
        error: 'Quality must be between 1 and 100',
        status: 400
      });
    }

    // Get original image info
    const imageBuffer = req.file.buffer;
    const originalSize = imageBuffer.length;
    
    // Security: Validate image content using magic bytes (MIME type verification)
    const isValidImage = (
      // JPEG signature
      (imageBuffer[0] === 0xFF && imageBuffer[1] === 0xD8 && imageBuffer[2] === 0xFF) ||
      // PNG signature
      (imageBuffer[0] === 0x89 && imageBuffer[1] === 0x50 && imageBuffer[2] === 0x4E && imageBuffer[3] === 0x47) ||
      // GIF signature (GIF87a or GIF89a)
      (imageBuffer[0] === 0x47 && imageBuffer[1] === 0x49 && imageBuffer[2] === 0x46 && imageBuffer[3] === 0x38) ||
      // WebP RIFF signature
      (imageBuffer[0] === 0x52 && imageBuffer[1] === 0x49 && imageBuffer[2] === 0x46 && imageBuffer[3] === 0x46 && imageBuffer.length > 12 && imageBuffer[8] === 0x57 && imageBuffer[9] === 0x45 && imageBuffer[10] === 0x42 && imageBuffer[11] === 0x50) ||
      // BMP signature
      (imageBuffer[0] === 0x42 && imageBuffer[1] === 0x4D) ||
      // TIFF signature (little-endian or big-endian)
      (imageBuffer[0] === 0x49 && imageBuffer[1] === 0x49 && imageBuffer[2] === 0x2A && imageBuffer[3] === 0x00) ||
      (imageBuffer[0] === 0x4D && imageBuffer[1] === 0x4D && imageBuffer[2] === 0x00 && imageBuffer[3] === 0x2A)
    );
    
    if (!isValidImage) {
      return res.status(415).json({
        error: 'Invalid image file. File content does not match declared image type.',
        status: 415
      });
    }
    
    const originalMetadata = await sharp(imageBuffer).metadata();

    // Build Sharp pipeline
    let sharpInstance = sharp(imageBuffer);

    // Resize configuration
    if (targetWidth || targetHeight) {
      const resizeOptions = {
        withoutEnlargement: true
      };

      if (keepAspectRatio) {
        resizeOptions.fit = 'inside';
        resizeOptions.width = targetWidth || null;
        resizeOptions.height = targetHeight || null;
      } else {
        resizeOptions.fit = 'fill';
        resizeOptions.width = targetWidth || originalMetadata.width;
        resizeOptions.height = targetHeight || originalMetadata.height;
      }

      sharpInstance = sharpInstance.resize(resizeOptions);
    }

    // Apply compression based on output format
    const outputFormat = path.extname(req.file.originalname).toLowerCase().slice(1) || 'jpg';
    
    if (outputFormat === 'jpg' || outputFormat === 'jpeg') {
      sharpInstance = sharpInstance.jpeg({ quality: compressionQuality });
    } else if (outputFormat === 'png') {
      sharpInstance = sharpInstance.png({ compressionLevel: Math.floor((100 - compressionQuality) / 10) });
    } else if (outputFormat === 'webp') {
      sharpInstance = sharpInstance.webp({ quality: compressionQuality });
    }

    // Process image
    const processedBuffer = await sharpInstance.toBuffer();
    const processedSize = processedBuffer.length;

    // Convert to base64 for response
    const base64Image = processedBuffer.toString('base64');
    const dataUri = `data:image/${outputFormat};base64,${base64Image}`;

    res.json({
      uri: dataUri,
      size: processedSize,
      originalSize: originalSize,
      compressionRatio: ((1 - processedSize / originalSize) * 100).toFixed(1) + '%',
      dimensions: {
        width: targetWidth || originalMetadata.width,
        height: targetHeight || originalMetadata.height,
        original: {
          width: originalMetadata.width,
          height: originalMetadata.height
        }
      },
      timestamp: new Date().toISOString()
    });

  } catch (error) {
    console.error('Image resize error:', error);
    
    // Clean up temp file if exists
    if (tempFilePath) {
      try {
        await fs.unlink(tempFilePath);
      } catch (cleanupError) {
        // Ignore cleanup errors
      }
    }

    res.status(500).json({
      error: 'Failed to resize image',
      message: error.message || 'Image processing failed',
      status: 500
    });
  }
});

module.exports = router;

