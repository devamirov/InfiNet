const express = require('express');
const cors = require('cors');
const multer = require('multer');
const sharp = require('sharp');
const fs = require('fs').promises;
const path = require('path');
const { exec } = require('child_process');
const { promisify } = require('util');
require('dotenv').config();

const execAsync = promisify(exec);

const app = express();
const PORT = process.env.PORT || 3001;

// Middleware
app.use(cors());
app.use(express.json({ limit: '100mb' }));
app.use(express.urlencoded({ extended: true, limit: '100mb' }));

// Create temp directory if it doesn't exist
const TEMP_DIR = path.join(__dirname, 'temp');
(async () => {
  try {
    await fs.mkdir(TEMP_DIR, { recursive: true });
  } catch (error) {
    console.error('Failed to create temp directory:', error);
  }
})();

// Configure multer for file uploads
const upload = multer({
  dest: TEMP_DIR,
  limits: {
    fileSize: 100 * 1024 * 1024 // 100MB limit
  }
});

// Helper: Clean up temp files
const cleanupFile = async (filePath) => {
  try {
    await fs.unlink(filePath);
  } catch (error) {
    console.warn('Failed to cleanup file:', filePath, error.message);
  }
};

// Helper: Get file extension
const getExtension = (filename) => {
  return path.extname(filename).toLowerCase().slice(1);
};

// Helper: Check if LibreOffice is installed
const checkLibreOffice = async () => {
  try {
    await execAsync('which libreoffice || which soffice');
    return true;
  } catch {
    return false;
  }
};

const toolCheckCache = {};

const hasBinary = async (binary) => {
  if (toolCheckCache[binary] !== undefined) {
    return toolCheckCache[binary];
  }
  try {
    await execAsync(`which ${binary}`);
    toolCheckCache[binary] = true;
  } catch {
    toolCheckCache[binary] = false;
  }
  return toolCheckCache[binary];
};

const naturalSort = (a, b) => a.localeCompare(b, undefined, { numeric: true, sensitivity: 'base' });

const tryPdfOcrFallback = async (inputPath, outputFormatLibre, outputPath) => {
  if (!['docx', 'doc'].includes(outputFormatLibre)) {
    return null;
  }

  const hasPdftoppm = await hasBinary('pdftoppm');
  const hasTesseract = await hasBinary('tesseract');

  if (!hasPdftoppm || !hasTesseract) {
    console.warn('OCR fallback skipped: pdftoppm or tesseract is not installed');
    return null;
  }

  try {
    return await convertPdfToDocWithOcr(inputPath, outputFormatLibre, outputPath);
  } catch (error) {
    console.error('OCR fallback conversion failed:', error);
    return null;
  }
};

const convertPdfToDocWithOcr = async (inputPath, outputFormatLibre, outputPath) => {
  console.log('Attempting OCR fallback for PDF conversion...');
  const tempDir = path.dirname(outputPath);
  const inputBaseName = path.basename(inputPath, path.extname(inputPath));
  const timestamp = Date.now();
  const imageBase = path.join(tempDir, `${inputBaseName}-ocr-${timestamp}`);

  try {
    await execAsync(`pdftoppm -png -r 300 "${inputPath}" "${imageBase}"`, {
      timeout: 120000,
      maxBuffer: 20 * 1024 * 1024
    });
  } catch (error) {
    console.error('pdftoppm failed to convert PDF to images:', error);
    throw new Error('OCR fallback failed: unable to rasterize PDF pages.');
  }

  let imageFiles = [];
  try {
    const files = await fs.readdir(tempDir);
    imageFiles = files
      .filter((file) => file.startsWith(path.basename(imageBase)) && file.endsWith('.png'))
      .map((file) => path.join(tempDir, file))
      .sort(naturalSort);
  } catch (error) {
    console.error('Failed to read temp directory for OCR images:', error);
    throw new Error('OCR fallback failed: unable to read generated images.');
  }

  if (imageFiles.length === 0) {
    throw new Error('OCR fallback failed: no images generated from PDF.');
  }

  const textChunks = [];

  for (const imagePath of imageFiles) {
    const outputBase = imagePath.replace(/\.png$/, '');
    try {
      await execAsync(`tesseract "${imagePath}" "${outputBase}" -l eng --psm 1`, {
        timeout: 120000,
        maxBuffer: 20 * 1024 * 1024
      });
      const txtPath = `${outputBase}.txt`;
      try {
        const text = await fs.readFile(txtPath, 'utf8');
        if (text && text.trim()) {
          textChunks.push(text.trim());
        }
      } catch (readError) {
        console.warn(`Failed to read OCR text output for ${imagePath}:`, readError.message);
      } finally {
        await cleanupFile(`${outputBase}.txt`).catch(() => {});
      }
    } catch (tesseractError) {
      console.warn('Tesseract failed for image:', imagePath, tesseractError.message);
    } finally {
      await cleanupFile(imagePath).catch(() => {});
    }
  }

  if (textChunks.length === 0) {
    throw new Error('OCR fallback failed: Tesseract did not extract any text.');
  }

  const combinedTextPath = path.join(tempDir, `${inputBaseName}-ocr-${timestamp}.txt`);
  await fs.writeFile(combinedTextPath, textChunks.join('\n\n'));

  const command = `timeout 120 libreoffice --headless --nodefault --nolockcheck --nologo --convert-to ${outputFormatLibre} --outdir "${tempDir}" "${combinedTextPath}"`;
  console.log('Converting OCR text to target format:', command);

  try {
    await execAsync(command, {
      timeout: 120000,
      maxBuffer: 10 * 1024 * 1024
    });
  } catch (error) {
    console.error('LibreOffice failed to convert OCR text:', error);
    throw new Error('OCR fallback failed: LibreOffice could not convert OCR result to target format.');
  }

  await new Promise((resolve) => setTimeout(resolve, 1000));

  const generatedBase = path.basename(combinedTextPath, path.extname(combinedTextPath));
  const possibleTargets = [
    path.join(tempDir, `${generatedBase}.${outputFormatLibre}`),
    path.join(tempDir, `${inputBaseName}.${outputFormatLibre}`),
    outputPath
  ];

  let finalPath = null;
  for (const candidate of possibleTargets) {
    try {
      await fs.access(candidate);
      const stats = await fs.stat(candidate);
      if (stats.size > 0) {
        finalPath = candidate;
        break;
      }
    } catch {
      continue;
    }
  }

  if (!finalPath) {
    throw new Error('OCR fallback failed: LibreOffice did not produce the target document.');
  }

  if (finalPath !== outputPath) {
    await fs.rename(finalPath, outputPath);
  }

  await cleanupFile(combinedTextPath).catch(() => {});
  console.log(`OCR fallback conversion successful: ${outputPath}`);
  return outputPath;
};

// Image conversion using Sharp
const convertImage = async (inputPath, outputFormat, outputPath) => {
  const format = outputFormat.toLowerCase();
  const supportedFormats = ['jpg', 'jpeg', 'png', 'webp', 'gif', 'bmp', 'tiff', 'avif'];

  if (!supportedFormats.includes(format)) {
    throw new Error(`Unsupported image format: ${format}`);
  }

  try {
    let sharpInstance = sharp(inputPath);

    // Handle format-specific options
    if (format === 'jpg' || format === 'jpeg') {
      sharpInstance = sharpInstance.jpeg({ quality: 90 });
    } else if (format === 'png') {
      sharpInstance = sharpInstance.png({ compressionLevel: 9 });
    } else if (format === 'webp') {
      sharpInstance = sharpInstance.webp({ quality: 90 });
    } else if (format === 'gif') {
      sharpInstance = sharpInstance.gif();
    } else if (format === 'tiff') {
      sharpInstance = sharpInstance.tiff({ compression: 'lzw' });
    } else if (format === 'bmp') {
      // BMP doesn't need special options, Sharp handles it automatically
      sharpInstance = sharpInstance;
    } else if (format === 'avif') {
      sharpInstance = sharpInstance.avif({ quality: 90 });
    }

    await sharpInstance.toFile(outputPath);
    
    // Verify output file exists
    try {
      await fs.access(outputPath);
    } catch {
      throw new Error(`Conversion completed but output file not found: ${outputPath}`);
    }
    
    return outputPath;
  } catch (error) {
    console.error(`Image conversion error (${outputFormat}):`, error);
    throw new Error(`Image conversion failed: ${error.message}`);
  }
};

// Text file conversion (MD, JSON, CSV, TXT, HTML)
const convertText = async (inputPath, outputFormat, outputPath) => {
  // Read input file as text (UTF-8)
  let content;
  try {
    content = await fs.readFile(inputPath, 'utf8');
  } catch (error) {
    // If UTF-8 fails, try reading as buffer and converting
    const buffer = await fs.readFile(inputPath);
    content = buffer.toString('utf8');
  }
  const inputExt = getExtension(inputPath);
  const outputExt = outputFormat.toLowerCase();
  
  // Helper: Convert JSON to CSV
  const jsonToCsv = (data) => {
    if (!Array.isArray(data) || data.length === 0 || typeof data[0] !== 'object') {
      return null;
    }
    const firstRow = data[0];
    const headers = Object.keys(firstRow);
    const rows = data.map((row) =>
      headers
        .map((header) => {
          const value = row[header];
          if (value === null || value === undefined) {
            return '';
          }
          const cell = String(value).replace(/"/g, '""');
          return cell.includes(',') || cell.includes('\n') || cell.includes('"') ? `"${cell}"` : cell;
        })
        .join(',')
    );
    return [headers.join(','), ...rows].join('\n');
  };
  
  // Helper: Escape HTML
  const escapeHtml = (value) =>
    value.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
  
  // Helper: Parse CSV to JSON
  const csvToJson = (csvContent) => {
    const lines = csvContent.trim().split('\n');
    if (lines.length === 0) return [];
    
    const headers = lines[0].split(',').map(h => h.trim().replace(/^"|"$/g, ''));
    const rows = [];
    
    for (let i = 1; i < lines.length; i++) {
      const line = lines[i];
      if (!line.trim()) continue;
      
      // Simple CSV parsing (handles quoted values)
      const values = [];
      let current = '';
      let inQuotes = false;
      
      for (let j = 0; j < line.length; j++) {
        const char = line[j];
        if (char === '"') {
          if (inQuotes && line[j + 1] === '"') {
            current += '"';
            j++;
          } else {
            inQuotes = !inQuotes;
          }
        } else if (char === ',' && !inQuotes) {
          values.push(current.trim());
          current = '';
        } else {
          current += char;
        }
      }
      values.push(current.trim());
      
      const row = {};
      headers.forEach((header, index) => {
        row[header] = values[index] || '';
      });
      rows.push(row);
    }
    
    return rows;
  };
  
  let convertedContent = content;
  
  // Convert based on output format
  switch (outputExt) {
    case 'json': {
      try {
        // If input is CSV, convert to JSON
        if (inputExt === 'csv') {
          const jsonData = csvToJson(content);
          convertedContent = JSON.stringify(jsonData, null, 2);
        } else if (inputExt === 'json') {
          // Pretty print JSON
          const parsed = JSON.parse(content);
          convertedContent = JSON.stringify(parsed, null, 2);
        } else {
          // Convert text to JSON object
          convertedContent = JSON.stringify({ content }, null, 2);
        }
      } catch (error) {
        // If parsing fails, wrap content in JSON
        convertedContent = JSON.stringify({ content }, null, 2);
      }
      break;
    }
    
    case 'csv': {
      try {
        // If input is JSON, convert to CSV
        if (inputExt === 'json') {
          const parsed = JSON.parse(content);
          const csv = jsonToCsv(parsed);
          convertedContent = csv || content;
        } else {
          // For other formats, keep as-is (or convert to CSV format)
          convertedContent = content;
        }
      } catch (error) {
        convertedContent = content;
      }
      break;
    }
    
    case 'html': {
      // Convert any text to HTML
      convertedContent = `<!DOCTYPE html>\n<html><head><meta charset="utf-8" /></head><body><pre>${escapeHtml(content)}</pre></body></html>`;
      break;
    }
    
    case 'md':
    case 'txt':
    default: {
      // For MD and TXT, just return content as-is
      // If input is JSON, pretty print it
      if (inputExt === 'json') {
        try {
          const parsed = JSON.parse(content);
          convertedContent = JSON.stringify(parsed, null, 2);
        } catch {
          convertedContent = content;
        }
      } else {
        convertedContent = content;
      }
      break;
    }
  }
  
  // Write converted content to output file
  await fs.writeFile(outputPath, convertedContent, 'utf8');
  return outputPath;
};

// Office/PDF conversion using LibreOffice
const convertDocument = async (inputPath, outputFormat, outputPath) => {
  const hasLibreOffice = await checkLibreOffice();
  if (!hasLibreOffice) {
    throw new Error('LibreOffice is not installed. Please install it to convert Office/PDF files.');
  }

  const formatMap = {
    'pdf': 'pdf',
    'docx': 'docx',
    'doc': 'doc',
    'xlsx': 'xlsx',
    'xls': 'xls',
    'pptx': 'pptx',
    'ppt': 'ppt',
    'odt': 'odt',
    'ods': 'ods',
    'odp': 'odp',
    'txt': 'txt',
    'html': 'html',
    'rtf': 'rtf'
  };

  const outputFormatLibre = formatMap[outputFormat.toLowerCase()];
  if (!outputFormatLibre) {
    throw new Error(`Unsupported document format: ${outputFormat}`);
  }

  // Special handling for PDF to DOCX/DOC - LibreOffice doesn't support direct conversion
  const inputExt = getExtension(inputPath);
  if (inputExt === 'pdf' && (outputFormatLibre === 'docx' || outputFormatLibre === 'doc')) {
    const targetFormat = outputFormatLibre === 'docx' ? 'DOCX' : 'DOC';
    console.log(`PDF to ${targetFormat} conversion - LibreOffice requires two-step conversion (PDF -> ODT -> ${targetFormat})`);
    // LibreOffice cannot directly convert PDF to DOCX/DOC, so we convert to ODT first, then to target format
    
    try {
      // Step 1: Convert PDF to ODT
      const odtCommand = `timeout 120 libreoffice --headless --nodefault --nolockcheck --nologo --convert-to odt --outdir "${path.dirname(outputPath)}" "${inputPath}"`;
      console.log(`Step 1: Converting PDF to ODT: ${odtCommand}`);
      let odtStdout = '';
      let odtStderr = '';
      let libreOfficeError = false;
      
      try {
        const result = await execAsync(odtCommand, {
          timeout: 120000,
          maxBuffer: 10 * 1024 * 1024
        });
        odtStdout = result.stdout || '';
        odtStderr = result.stderr || '';
      } catch (execError) {
        odtStdout = execError.stdout || '';
        odtStderr = execError.stderr || '';
        libreOfficeError = true;
        console.warn('LibreOffice command exited with error:', execError.code, execError.message);
      }
      
      // Log all output for debugging
      if (odtStdout) console.log('LibreOffice stdout:', odtStdout);
      if (odtStderr) console.warn('LibreOffice stderr:', odtStderr);
      
      // Check for known error patterns
      const errorPatterns = [
        'no export filter',
        'aborting',
        'Error:',
        'failed',
        'cannot',
        'unsupported'
      ];
      
      const hasError = errorPatterns.some(pattern => 
        (odtStdout && odtStdout.toLowerCase().includes(pattern)) ||
        (odtStderr && odtStderr.toLowerCase().includes(pattern))
      );
      
      if (hasError && !odtStderr.includes('Overwriting') && !odtStderr.includes('convert')) {
        console.error('LibreOffice conversion error detected');
      }
      
      // Wait for file system sync (longer wait for PDF conversions)
      await new Promise(resolve => setTimeout(resolve, 2000));
      
      // Find the generated ODT file
      const inputBaseName = path.basename(inputPath, path.extname(inputPath));
      const generatedOdt = path.join(path.dirname(outputPath), `${inputBaseName}.odt`);
      
      // Check if ODT file exists - try multiple possible locations and patterns
      let odtFile = null;
      const possibleOdtPaths = [
        generatedOdt,
        path.join(path.dirname(outputPath), `${path.basename(inputPath, '.pdf')}.odt`),
        path.join(path.dirname(outputPath), `${path.basename(inputPath, path.extname(inputPath))}.odt`),
        path.join(path.dirname(outputPath), `upload-${Date.now()}.odt`)
      ];
      
      // Also check all .odt files in the directory
      try {
        const files = await fs.readdir(path.dirname(outputPath));
        const odtFiles = files.filter(f => f.toLowerCase().endsWith('.odt'));
        if (odtFiles.length > 0) {
          possibleOdtPaths.push(...odtFiles.map(f => path.join(path.dirname(outputPath), f)));
        }
      } catch {}
      
      for (const odtPath of possibleOdtPaths) {
        try {
          await fs.access(odtPath);
          const stats = await fs.stat(odtPath);
          // Make sure it's not an empty file
          if (stats.size > 0) {
            odtFile = odtPath;
            console.log(`Found ODT file at: ${odtFile} (${stats.size} bytes)`);
            break;
          }
        } catch {
          continue;
        }
      }
      
      if (!odtFile) {
        // List files in directory to help debug
        try {
          const files = await fs.readdir(path.dirname(outputPath));
          console.error('Files in output directory after PDF to ODT conversion:', files);
        } catch {}

        const ocrFallbackResult = await tryPdfOcrFallback(inputPath, outputFormatLibre, outputPath);
        if (ocrFallbackResult) {
          return ocrFallbackResult;
        }
        
        // Provide more helpful error message
        const errorDetails = [];
        if (libreOfficeError) errorDetails.push('LibreOffice command failed');
        if (odtStderr) errorDetails.push(`stderr: ${odtStderr.substring(0, 200)}`);
        if (odtStdout && !odtStdout.includes('convert')) errorDetails.push(`stdout: ${odtStdout.substring(0, 200)}`);
        
        throw new Error(
          'PDF to ODT conversion failed. LibreOffice cannot convert this PDF format. ' +
          'This usually happens with:\n' +
          '• Scanned PDFs (image-based documents)\n' +
          '• PDFs with complex layouts or embedded images\n' +
          '• Password-protected or encrypted PDFs\n\n' +
          'Please try:\n' +
          '• Converting the PDF to an image format first (PNG/JPG), then to DOCX\n' +
          '• Using OCR software if the PDF is scanned\n' +
          '• Converting to a different format\n' +
          (errorDetails.length > 0 ? '\nDetails: ' + errorDetails.join('; ') : '')
        );
      }
      
      // Use the found ODT file
      const odtToUse = odtFile;
      
      // Step 2: Convert ODT to DOCX or DOC
      const targetCommand = `timeout 120 libreoffice --headless --nodefault --nolockcheck --nologo --convert-to ${outputFormatLibre} --outdir "${path.dirname(outputPath)}" "${odtToUse}"`;
      console.log(`Step 2: Converting ODT to ${targetFormat}: ${targetCommand}`);
      const { stdout: targetStdout, stderr: targetStderr } = await execAsync(targetCommand, {
        timeout: 120000,
        maxBuffer: 10 * 1024 * 1024
      });
      
      if (targetStderr && !targetStderr.includes('Overwriting') && !targetStderr.includes('convert')) {
        console.warn(`LibreOffice ${targetFormat} conversion stderr:`, targetStderr);
      }
      
      // Wait for file system sync
      await new Promise(resolve => setTimeout(resolve, 1000));
      
      // Find the generated DOCX/DOC file
      const generatedTarget = path.join(path.dirname(outputPath), `${inputBaseName}.${outputFormatLibre}`);
      
      // Check if target file exists
      try {
        await fs.access(generatedTarget);
        console.log(`Found ${targetFormat} file at: ${generatedTarget}`);
        
        // Rename to desired output path if different
        if (generatedTarget !== outputPath) {
          await fs.rename(generatedTarget, outputPath);
        }
        
        // Cleanup intermediate ODT file
        await cleanupFile(odtToUse).catch(() => {});
        
        // Verify final file
        const stats = await fs.stat(outputPath);
        if (stats.size === 0) {
          throw new Error('Converted file is empty. The conversion may have failed.');
        }
        console.log(`PDF to ${targetFormat} conversion successful: ${outputPath} (${stats.size} bytes)`);
        return outputPath;
      } catch (targetError) {
        // Cleanup intermediate ODT file
        if (odtToUse) {
          await cleanupFile(odtToUse).catch(() => {});
        }
        throw new Error(`ODT to ${targetFormat} conversion failed: ${targetError.message}`);
      }
    } catch (pdfError) {
      console.error(`PDF to ${targetFormat} conversion error:`, pdfError);
      throw new Error(`PDF to ${targetFormat} conversion failed: ${pdfError.message}. LibreOffice may not support converting this PDF format.`);
    }
  }
  
  // For PDF to XLSX/ODS, LibreOffice doesn't support direct conversion - use workaround
  if (inputExt === 'pdf' && (outputFormatLibre === 'xlsx' || outputFormatLibre === 'ods')) {
    console.log(`PDF to ${outputFormatLibre.toUpperCase()} - LibreOffice doesn't support direct conversion, using workaround: PDF → DOCX → ${outputFormatLibre.toUpperCase()}`);
    try {
      // Step 1: Convert PDF to DOCX (uses two-step process that's more reliable)
      const tempDocxPath = path.join(path.dirname(outputPath), `temp-${Date.now()}.docx`);
      const docxPath = await convertDocument(inputPath, 'docx', tempDocxPath);
      console.log(`PDF → DOCX successful: ${docxPath}`);
      
      // Step 2: Convert DOCX to XLSX/ODS
      // Note: DOCX to XLSX/ODS also has limitations - LibreOffice can't convert word docs to spreadsheets
      // We'll try, but it may fail
      try {
        const finalPath = await convertDocument(docxPath, outputFormatLibre, outputPath);
        console.log(`DOCX → ${outputFormatLibre.toUpperCase()} successful: ${finalPath}`);
        
        // Cleanup intermediate DOCX file
        await cleanupFile(docxPath).catch(() => {});
        
        return outputPath;
      } catch (docxToXlsxError) {
        console.error(`DOCX → ${outputFormatLibre.toUpperCase()} failed:`, docxToXlsxError);
        await cleanupFile(docxPath).catch(() => {});
        throw new Error(
          `PDF to ${outputFormatLibre.toUpperCase()} conversion is not supported.\n\n` +
          `LibreOffice cannot convert PDF documents to spreadsheet formats (XLSX/ODS).\n\n` +
          `This is because:\n` +
          `• PDFs don't have a table structure that can be extracted\n` +
          `• Word documents (DOCX) cannot be converted to spreadsheets\n\n` +
          `Please try:\n` +
          `• Converting PDF → DOCX or PDF → ODT (text formats)\n` +
          `• Using specialized PDF table extraction tools\n` +
          `• Manually copying data from PDF to spreadsheet`
        );
      }
    } catch (workaroundError) {
      console.error(`PDF → DOCX → ${outputFormatLibre.toUpperCase()} workaround failed:`, workaroundError);
      throw new Error(
        `PDF to ${outputFormatLibre.toUpperCase()} conversion failed.\n\n` +
        `LibreOffice cannot convert PDF documents to spreadsheet formats.\n\n` +
        `Please try converting to a text format (DOCX, ODT, TXT) instead.`
      );
    }
  }
  
  // LibreOffice command with timeout and better error handling
  const command = `timeout 120 libreoffice --headless --nodefault --nolockcheck --nologo --convert-to ${outputFormatLibre} --outdir "${path.dirname(outputPath)}" "${inputPath}"`;
  
  try {
    console.log(`Executing LibreOffice command: ${command}`);
    const { stdout, stderr } = await execAsync(command, {
      timeout: 120000, // 120 seconds timeout
      maxBuffer: 10 * 1024 * 1024 // 10MB buffer
    });
    
    if (stderr && !stderr.includes('Overwriting') && !stderr.includes('convert')) {
      console.warn('LibreOffice stderr:', stderr);
      // Check if it's a critical error
      if (stderr.includes('no export filter') || stderr.includes('aborting')) {
        throw new Error(`LibreOffice conversion failed: ${stderr}. This conversion may not be supported.`);
      }
    }
    
    // Wait a moment for file system to sync (longer for PDF conversions)
    const waitTime = inputExt === 'pdf' ? 2000 : 1000; // Increased wait time for PDF
    await new Promise(resolve => setTimeout(resolve, waitTime));
    
    // LibreOffice creates file with same name but different extension
    const inputBaseName = path.basename(inputPath, path.extname(inputPath));
    const expectedPath = path.join(path.dirname(outputPath), `${inputBaseName}.${outputFormatLibre}`);
    
    // Check if file exists - try multiple strategies
    let foundPath = null;
    
    // Strategy 1: Expected path based on input filename
    try {
      await fs.access(expectedPath);
      const stats = await fs.stat(expectedPath);
      if (stats.size > 0) {
        foundPath = expectedPath;
        console.log(`Found converted file at: ${expectedPath} (${stats.size} bytes)`);
      }
    } catch {}
    
    // Strategy 2: Search for any file with the target extension in the output directory
    if (!foundPath) {
      try {
        const files = await fs.readdir(path.dirname(outputPath));
        const targetExt = outputFormatLibre.toLowerCase();
        const matchingFiles = files.filter(f => 
          f.toLowerCase().endsWith(`.${targetExt}`) && 
          f !== path.basename(inputPath) // Exclude input file
        );
        
        // Sort by modification time (newest first) and check each one
        for (const file of matchingFiles) {
          const filePath = path.join(path.dirname(outputPath), file);
          try {
            const stats = await fs.stat(filePath);
            // Check if file was modified recently (within last 10 seconds)
            const fileAge = Date.now() - stats.mtimeMs;
            if (stats.size > 0 && fileAge < 10000) {
              foundPath = filePath;
              console.log(`Found converted file by scanning directory: ${filePath} (${stats.size} bytes, ${fileAge}ms old)`);
              break;
            }
          } catch {}
        }
      } catch (dirError) {
        console.warn('Failed to scan output directory:', dirError);
      }
    }
    
    // Strategy 3: Try alternative naming patterns
    if (!foundPath) {
      const altPaths = [
        path.join(path.dirname(outputPath), `${path.basename(inputPath, path.extname(inputPath))}.${outputFormatLibre}`),
        path.join(path.dirname(outputPath), `${path.basename(inputPath, '.pdf')}.${outputFormatLibre}`),
        outputPath
      ];
      
      for (const altPath of altPaths) {
        try {
          await fs.access(altPath);
          const stats = await fs.stat(altPath);
          if (stats.size > 0) {
            foundPath = altPath;
            console.log(`Found converted file at alternative path: ${altPath} (${stats.size} bytes)`);
            break;
          }
        } catch {
          continue;
        }
      }
    }
    
    if (!foundPath) {
      // List files in output directory for debugging
      try {
        const files = await fs.readdir(path.dirname(outputPath));
        console.error('Files in output directory:', files);
        // Also check LibreOffice stderr for clues
        if (stderr) {
          console.error('LibreOffice stderr:', stderr);
        }
        if (stdout) {
          console.error('LibreOffice stdout:', stdout);
        }
      } catch {}
      
      // For PDF to ODT, try workaround: PDF → DOCX → ODT
      if (inputExt === 'pdf' && outputFormatLibre === 'odt') {
        console.log('PDF to ODT direct conversion failed, trying workaround: PDF → DOCX → ODT');
        try {
          // Step 1: Convert PDF to DOCX (uses two-step process that's more reliable)
          const tempDocxPath = path.join(path.dirname(outputPath), `temp-${Date.now()}.docx`);
          const docxPath = await convertDocument(inputPath, 'docx', tempDocxPath);
          console.log(`PDF → DOCX successful: ${docxPath}`);
          
          // Step 2: Convert DOCX to ODT
          const odtPath = await convertDocument(docxPath, 'odt', outputPath);
          console.log(`DOCX → ODT successful: ${odtPath}`);
          
          // Cleanup intermediate DOCX file
          await cleanupFile(docxPath).catch(() => {});
          
          return outputPath;
        } catch (workaroundError) {
          console.error('PDF → DOCX → ODT workaround failed:', workaroundError);
          throw new Error(
            'PDF to ODT conversion failed. LibreOffice cannot convert this PDF format.\n\n' +
            'This usually happens with:\n' +
            '• Scanned PDFs (image-based documents)\n' +
            '• PDFs with complex layouts or embedded images\n' +
            '• Password-protected or encrypted PDFs\n\n' +
            'Please try:\n' +
            '• Converting the PDF to an image format first (PNG/JPG), then to ODT\n' +
            '• Using OCR software if the PDF is scanned\n' +
            '• Converting to a different format (e.g., PDF → DOCX)'
          );
        }
      }
      
      throw new Error(`Conversion completed but output file not found. LibreOffice may have failed silently. Expected: ${expectedPath}`);
    }
    
    // Use the found path
    const generatedPath = foundPath;
    
    // Rename to desired output path if different
    if (generatedPath !== outputPath) {
      try {
        await fs.rename(generatedPath, outputPath);
        console.log(`Renamed converted file from ${generatedPath} to ${outputPath}`);
      } catch (renameError) {
        // If rename fails, check if outputPath already exists
        try {
          await fs.access(outputPath);
          console.log('Output file already exists at target path');
        } catch {
          throw new Error(`Failed to rename converted file: ${renameError.message}`);
        }
      }
    }
    
    // Final verification
    try {
      await fs.access(outputPath);
      const stats = await fs.stat(outputPath);
      if (stats.size === 0) {
        throw new Error('Converted file is empty. The conversion may have failed.');
      }
      console.log(`Conversion successful: ${outputPath} (${stats.size} bytes)`);
    } catch (verifyError) {
      throw new Error(`Output file verification failed: ${verifyError.message}`);
    }
    
    return outputPath;
  } catch (error) {
    console.error(`Document conversion error (${inputExt} -> ${outputFormatLibre}):`, error);
    if (error.code === 'ETIMEDOUT' || error.signal === 'SIGTERM') {
      throw new Error('Conversion timed out after 120 seconds. The file may be too large or complex.');
    }
    if (error.message && error.message.includes('not found')) {
      throw error;
    }
    throw new Error(`Document conversion failed: ${error.message || 'Unknown error'}`);
  }
};

// Main conversion endpoint - supports both FormData and JSON (base64)
app.post('/api/convert', async (req, res) => {
  let inputPath = null;
  let outputPath = null;

  try {
    let originalName = 'file';
    let targetFormat;
    let inputExt = '';
    
    // Check if request is JSON (base64) or FormData
    if (req.body.file && typeof req.body.file === 'string') {
      // JSON request with base64 file
      console.log('Received JSON request with base64 file');
      const fileBase64 = req.body.file;
      originalName = req.body.fileName || 'file';
      targetFormat = req.body.format?.toLowerCase();
      
      if (!targetFormat) {
        return res.status(400).json({ error: 'Target format is required' });
      }
      
      // Write base64 to temp file
      const timestamp = Date.now();
      inputExt = getExtension(originalName) || 'txt';
      inputPath = path.join(TEMP_DIR, `upload-${timestamp}.${inputExt}`);
      
      // Decode base64 and write to file
      // For text files, we need to handle encoding properly
      const textFormats = ['txt', 'md', 'json', 'csv', 'html'];
      const isTextFile = textFormats.includes(inputExt);
      
      if (isTextFile) {
        // For text files, decode as UTF-8 string
        const textContent = Buffer.from(fileBase64, 'base64').toString('utf8');
        await fs.writeFile(inputPath, textContent, 'utf8');
        console.log(`Text file written to ${inputPath}, size: ${textContent.length} chars`);
      } else {
        // For binary files (images, PDFs, etc.), write as buffer
        const fileBuffer = Buffer.from(fileBase64, 'base64');
        await fs.writeFile(inputPath, fileBuffer);
        console.log(`Binary file written to ${inputPath}, size: ${fileBuffer.length} bytes`);
      }
    } else {
      // FormData request (multer) - use middleware
      upload.single('file')(req, res, async (err) => {
        if (err) {
          return res.status(400).json({ error: `Upload error: ${err.message}` });
        }
        
        if (!req.file) {
          return res.status(400).json({ error: 'No file uploaded' });
        }
        
        inputPath = req.file.path;
        originalName = req.file.originalname || 'file';
        targetFormat = req.body.format?.toLowerCase();
        
        if (!targetFormat) {
          await cleanupFile(inputPath);
          return res.status(400).json({ error: 'Target format is required' });
        }
        
        inputExt = getExtension(originalName);
        
        // If no extension found, try to detect from mime type
        if (!inputExt && req.file.mimetype) {
          const mimeMap = {
            'text/plain': 'txt',
            'text/html': 'html',
            'application/pdf': 'pdf',
            'application/msword': 'doc',
            'application/vnd.openxmlformats-officedocument.wordprocessingml.document': 'docx',
            'application/vnd.ms-excel': 'xls',
            'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet': 'xlsx',
            'application/vnd.ms-powerpoint': 'ppt',
            'application/vnd.openxmlformats-officedocument.presentationml.presentation': 'pptx',
            'image/jpeg': 'jpg',
            'image/png': 'png',
            'image/gif': 'gif',
            'image/webp': 'webp'
          };
          inputExt = mimeMap[req.file.mimetype] || '';
        }
        
        // If still no extension, default to txt for text files
        if (!inputExt) {
          inputExt = 'txt';
        }
        
        // Continue with conversion...
        await performConversion();
      });
      return; // multer handles the response
    }
    
    // For JSON requests, continue here
    if (!inputExt) {
      inputExt = getExtension(originalName) || 'txt';
    }
    
    // Perform conversion (shared logic for both JSON and FormData)
    async function performConversion() {
    const outputExt = targetFormat;

    // Determine conversion type
    const imageFormats = ['jpg', 'jpeg', 'png', 'webp', 'gif', 'bmp', 'tiff', 'avif'];
    const textFormats = ['txt', 'md', 'json', 'csv', 'html'];
    const documentFormats = ['pdf', 'docx', 'doc', 'xlsx', 'xls', 'pptx', 'ppt', 'odt', 'ods', 'odp', 'rtf'];

    const isImageInput = imageFormats.includes(inputExt);
    const isImageOutput = imageFormats.includes(outputExt);
    const isTextInput = textFormats.includes(inputExt);
    const isTextOutput = textFormats.includes(outputExt);
    const isDocumentInput = documentFormats.includes(inputExt);
    const isDocumentOutput = documentFormats.includes(outputExt);

    // Generate output path
    const timestamp = Date.now();
    const baseName = path.basename(originalName, path.extname(originalName));
    outputPath = path.join(TEMP_DIR, `${baseName}-${timestamp}.${outputExt}`);

    let convertedPath;

    // Log conversion attempt
    console.log(`Converting: ${originalName} (${inputExt}) -> ${outputExt}`);

    // Perform conversion
    if (isTextInput && isTextOutput) {
      // Text to text (MD, JSON, CSV, TXT, HTML)
      convertedPath = await convertText(inputPath, outputExt, outputPath);
    } else if (isImageInput && isImageOutput) {
      // Image to image
      convertedPath = await convertImage(inputPath, outputExt, outputPath);
    } else if (isDocumentInput && isDocumentOutput) {
      // Document to document
      convertedPath = await convertDocument(inputPath, outputExt, outputPath);
    } else if (isTextInput && isDocumentOutput && outputExt === 'pdf') {
      // Text to PDF - convert text to HTML first, then use LibreOffice
      const tempHtml = path.join(TEMP_DIR, `${baseName}-temp-${timestamp}.html`);
      await convertText(inputPath, 'html', tempHtml);
      convertedPath = await convertDocument(tempHtml, 'pdf', outputPath);
      await cleanupFile(tempHtml).catch(() => {});
    } else if (isImageInput && isDocumentOutput && outputExt === 'pdf') {
      // Image to PDF (convert image first, then to PDF)
      const tempPdf = path.join(TEMP_DIR, `${baseName}-temp-${timestamp}.pdf`);
      await convertImage(inputPath, 'png', path.join(TEMP_DIR, `${baseName}-temp-${timestamp}.png`));
      // Use imagemagick or sharp to convert PNG to PDF
      convertedPath = await convertDocument(path.join(TEMP_DIR, `${baseName}-temp-${timestamp}.png`), 'pdf', outputPath);
    } else if (inputExt === 'pdf' && isImageOutput) {
      // PDF to image - use sharp to convert PDF pages to images
      // First convert PDF to PNG using imagemagick or poppler-utils
      try {
        // Try using pdftoppm (from poppler-utils) if available
        const { stdout } = await execAsync(`which pdftoppm`);
        if (stdout.trim()) {
          // Extract first page as image
          const tempImage = path.join(TEMP_DIR, `${baseName}-page-1`);
          await execAsync(`pdftoppm -png -f 1 -l 1 "${inputPath}" "${tempImage}"`, {
            timeout: 60000
          });
          const generatedImage = `${tempImage}-1.png`;
          // Convert to desired format if not PNG
          if (outputExt !== 'png') {
            convertedPath = await convertImage(generatedImage, outputExt, outputPath);
            await cleanupFile(generatedImage);
          } else {
            if (generatedImage !== outputPath) {
              await fs.rename(generatedImage, outputPath);
            }
            convertedPath = outputPath;
          }
        } else {
          throw new Error('pdftoppm not available');
        }
      } catch (pdfError) {
        // Fallback: try using LibreOffice to convert PDF to image
        console.log('PDF to image: trying LibreOffice fallback');
        // Convert PDF to PNG first using LibreOffice
        const tempPng = path.join(TEMP_DIR, `${baseName}-temp-${timestamp}.png`);
        const loCommand = `timeout 60 libreoffice --headless --nodefault --nolockcheck --nologo --convert-to png --outdir "${path.dirname(tempPng)}" "${inputPath}"`;
        await execAsync(loCommand, { timeout: 60000 });
        await new Promise(resolve => setTimeout(resolve, 500));
        const inputBaseName = path.basename(inputPath, path.extname(inputPath));
        const generatedPng = path.join(path.dirname(tempPng), `${inputBaseName}.png`);
        // Check if file exists
        try {
          await fs.access(generatedPng);
          // Convert to desired format if not PNG
          if (outputExt !== 'png') {
            convertedPath = await convertImage(generatedPng, outputExt, outputPath);
            await cleanupFile(generatedPng);
          } else {
            if (generatedPng !== outputPath) {
              await fs.rename(generatedPng, outputPath);
            }
            convertedPath = outputPath;
          }
        } catch {
          throw new Error('PDF to image conversion failed. Please ensure poppler-utils or LibreOffice is installed.');
        }
      }
    } else {
      console.error(`Unsupported conversion: ${inputExt} -> ${outputExt}`);
      if (inputPath) await cleanupFile(inputPath);
      return res.status(400).json({ 
        error: `Conversion from ${inputExt || 'unknown'} to ${outputExt} is not supported. Input file type: ${inputExt || 'unknown'}` 
      });
    }

    // Read converted file
    const fileBuffer = await fs.readFile(convertedPath);
    const fileBase64 = fileBuffer.toString('base64');

    // Cleanup
    await cleanupFile(inputPath);
    await cleanupFile(convertedPath);

    // Send response
    res.json({
      success: true,
      filename: `${baseName}.${outputExt}`,
      format: outputExt,
      data: fileBase64,
      mimeType: getMimeType(outputExt)
    });
    }
    
    // Call performConversion for JSON requests
    await performConversion();

  } catch (error) {
    console.error('Conversion error:', error);
    
    // Cleanup on error
    if (inputPath) await cleanupFile(inputPath).catch(() => {});
    if (outputPath) await cleanupFile(outputPath).catch(() => {});

    res.status(500).json({ 
      error: error.message || 'Conversion failed' 
    });
  }
});

// Helper: Get MIME type
const getMimeType = (ext) => {
  const mimeTypes = {
    'jpg': 'image/jpeg',
    'jpeg': 'image/jpeg',
    'png': 'image/png',
    'webp': 'image/webp',
    'gif': 'image/gif',
    'bmp': 'image/bmp',
    'tiff': 'image/tiff',
    'avif': 'image/avif',
    'pdf': 'application/pdf',
    'docx': 'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
    'doc': 'application/msword',
    'xlsx': 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
    'xls': 'application/vnd.ms-excel',
    'pptx': 'application/vnd.openxmlformats-officedocument.presentationml.presentation',
    'ppt': 'application/vnd.ms-powerpoint',
    'odt': 'application/vnd.oasis.opendocument.text',
    'ods': 'application/vnd.oasis.opendocument.spreadsheet',
    'odp': 'application/vnd.oasis.opendocument.presentation',
    'txt': 'text/plain',
    'html': 'text/html',
    'rtf': 'application/rtf'
  };
  return mimeTypes[ext.toLowerCase()] || 'application/octet-stream';
};

// Health check endpoint
app.get('/api/health', async (req, res) => {
  const hasLibreOffice = await checkLibreOffice();
  res.json({
    status: 'ok',
    libreOffice: hasLibreOffice,
    timestamp: new Date().toISOString()
  });
});

// Start server
app.listen(PORT, () => {
  console.log(`File Converter Service running on port ${PORT}`);
  console.log(`Health check: http://localhost:${PORT}/api/health`);
});

