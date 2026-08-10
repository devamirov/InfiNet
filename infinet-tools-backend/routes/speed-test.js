const express = require('express');
const router = express.Router();
const puppeteer = require('puppeteer');

/**
 * POST /api/tools/speed-test
 * Test website loading speed
 */
router.post('/', async (req, res) => {
  let browser = null;
  
  try {
    const { url } = req.body;

    if (!url || typeof url !== 'string') {
      return res.status(400).json({
        error: 'URL is required',
        status: 400
      });
    }

    const trimmedUrl = url.trim();
    let normalizedUrl = trimmedUrl;
    
    // Track original protocol before normalization
    let originalProtocol = 'unknown';
    if (trimmedUrl.startsWith('http://')) {
      originalProtocol = 'http';
    } else if (trimmedUrl.startsWith('https://')) {
      originalProtocol = 'https';
    }
    
    // Normalize URL (add protocol if missing - prefer HTTPS but track original)
    if (!normalizedUrl.startsWith('http://') && !normalizedUrl.startsWith('https://')) {
      normalizedUrl = `https://${normalizedUrl}`;
      originalProtocol = 'none'; // User didn't specify protocol
    }

    // Validate URL format
    try {
      new URL(normalizedUrl);
    } catch (error) {
      return res.status(400).json({
        error: 'Invalid URL format',
        status: 400
      });
    }

    // Launch headless browser
    // Launch headless browser with optimized settings
    const launchOptions = {
      headless: 'new', // Use new headless mode for better reliability
      args: [
        '--no-sandbox',
        '--disable-setuid-sandbox',
        '--disable-dev-shm-usage',
        '--disable-accelerated-2d-canvas',
        '--disable-gpu',
        '--disable-web-security',
        '--disable-features=IsolateOrigins,site-per-process',
        '--disable-extensions',
        '--disable-background-networking',
        '--disable-background-timer-throttling',
        '--disable-renderer-backgrounding',
        '--disable-backgrounding-occluded-windows'
      ],
      timeout: 60000 // 60 second launch timeout
    };
    
    // Try to use system Chromium if available (for snap installations)
    try {
      const { execSync } = require('child_process');
      // Check for snap chromium first, then regular chromium
      let chromiumPath = null;
      try {
        chromiumPath = execSync('which chromium 2>/dev/null', { encoding: 'utf8' }).trim();
      } catch (e) {
        try {
          chromiumPath = execSync('which chromium-browser 2>/dev/null', { encoding: 'utf8' }).trim();
        } catch (e2) {
          try {
            chromiumPath = execSync('which google-chrome 2>/dev/null', { encoding: 'utf8' }).trim();
          } catch (e3) {
            // No system chromium found, use bundled
          }
        }
      }
      
      if (chromiumPath) {
        launchOptions.executablePath = chromiumPath;
        console.log(`Using system Chromium at: ${chromiumPath}`);
      }
    } catch (e) {
      // Use bundled Chromium if system one not found or error
      console.log('Using bundled Chromium');
    }
    
    browser = await puppeteer.launch(launchOptions);

    const page = await browser.newPage();
    
    // Set viewport
    await page.setViewport({ width: 1920, height: 1080 });

    const startTime = Date.now();
    
    // Track response headers for security analysis
    let responseHeaders = {};
    let finalUrl = normalizedUrl;
    let mainResponse = null;
    
    // Set up response listener to capture main document response
    page.on('response', (response) => {
      // Capture the main frame response (first response that matches our URL)
      if (!mainResponse && (response.url() === normalizedUrl || response.url().startsWith(normalizedUrl.split('?')[0]))) {
        mainResponse = response;
        responseHeaders = response.headers();
      }
    });
    
    // Navigate to URL and wait for load
    try {
      const response = await page.goto(normalizedUrl, {
        waitUntil: 'domcontentloaded', // Changed from networkidle2 to domcontentloaded for faster/more reliable loading
        timeout: 45000 // Increased timeout to 45 seconds
      });
      
      // Get final URL after navigation (handles redirects)
      finalUrl = page.url();
      
      // Capture headers from the main document response
      // Use the response from goto() if available, otherwise use the one from listener
      if (response) {
        responseHeaders = response.headers();
        mainResponse = response;
      } else if (mainResponse) {
        // Use headers captured from response listener
        responseHeaders = mainResponse.headers();
      }
    } catch (navigationError) {
      await browser.close();
      
      // Provide more specific error messages
      let errorMessage = 'Website took too long to load or is unreachable';
      if (navigationError.message.includes('net::ERR_NAME_NOT_RESOLVED') || 
          navigationError.message.includes('DNS_PROBE_FINISHED_NXDOMAIN')) {
        errorMessage = 'Domain name could not be resolved. Please check the URL.';
      } else if (navigationError.message.includes('net::ERR_CONNECTION_REFUSED')) {
        errorMessage = 'Connection refused. The website may be down or blocking requests.';
      } else if (navigationError.message.includes('net::ERR_SSL_PROTOCOL_ERROR') ||
                 navigationError.message.includes('net::ERR_CERT')) {
        errorMessage = 'SSL/HTTPS error. The website may have certificate issues.';
      } else if (navigationError.message.includes('Timeout')) {
        errorMessage = 'Website took too long to load. Try again later.';
      }
      
      return res.status(408).json({
        error: errorMessage,
        status: 408,
        details: navigationError.message
      });
    }

    const loadTime = Date.now() - startTime;

    // Get performance metrics
    const metrics = await page.metrics();
    const performanceTiming = JSON.parse(
      await page.evaluate(() => JSON.stringify(window.performance.timing))
    );

    // Calculate various metrics
    const domContentLoaded = performanceTiming.domContentLoadedEventEnd - performanceTiming.navigationStart;
    const loadComplete = performanceTiming.loadEventEnd - performanceTiming.navigationStart;
    const firstByte = performanceTiming.responseStart - performanceTiming.requestStart;

    // Get page info and calculate scores
    const title = await page.title();
    const pageInfo = await page.evaluate(() => {
      const scripts = Array.from(document.querySelectorAll('script')).length;
      const images = Array.from(document.querySelectorAll('img')).length;
      const links = Array.from(document.querySelectorAll('link')).length;
      
      // Calculate performance score (0-100) based on load time
      const perfScore = Math.max(0, Math.min(100, Math.round(100 - (performance.timing.loadEventEnd - performance.timing.navigationStart) / 100)));
      
      // Calculate accessibility score (basic checks)
      const hasTitle = document.title && document.title.length > 0;
      const hasLang = document.documentElement.lang;
      const imagesWithAlt = Array.from(document.querySelectorAll('img')).filter(img => img.alt).length;
      const totalImages = Array.from(document.querySelectorAll('img')).length;
      const altRatio = totalImages > 0 ? (imagesWithAlt / totalImages) : 1;
      const accessibilityScore = Math.round((hasTitle ? 30 : 0) + (hasLang ? 20 : 0) + (altRatio * 50));
      
      return { 
        scripts, 
        images, 
        links,
        hasTitle,
        hasLang,
        altRatio,
        accessibilityScore,
        perfScore
      };
    });
    
    // Calculate security score based on protocol and headers
    const finalProtocol = finalUrl.startsWith('https://') ? 'https' : 'http';
    const hasHttps = finalProtocol === 'https';
    const redirectedToHttps = originalProtocol === 'http' && finalProtocol === 'https';
    
    // Check security headers (case-insensitive)
    const getHeader = (name) => {
      const lowerName = name.toLowerCase();
      for (const [key, value] of Object.entries(responseHeaders)) {
        if (key.toLowerCase() === lowerName) {
          return value;
        }
      }
      return null;
    };
    
    const hasHsts = !!getHeader('strict-transport-security');
    const hasCsp = !!getHeader('content-security-policy');
    const hasXFrameOptions = !!getHeader('x-frame-options');
    const hasXContentTypeOptions = !!getHeader('x-content-type-options');
    const hasReferrerPolicy = !!getHeader('referrer-policy');
    
    // Calculate security score breakdown
    let securityScore = 0;
    const scoreBreakdown = {
      https: 0,
      hsts: 0,
      csp: 0,
      xFrameOptions: 0,
      xContentTypeOptions: 0,
      referrerPolicy: 0
    };
    
    // HTTPS is fundamental (40 points)
    if (hasHttps) {
      securityScore += 40;
      scoreBreakdown.https = 40;
    }
    
    // HSTS header (20 points) - only if HTTPS
    if (hasHttps && hasHsts) {
      securityScore += 20;
      scoreBreakdown.hsts = 20;
    }
    
    // CSP header (15 points)
    if (hasCsp) {
      securityScore += 15;
      scoreBreakdown.csp = 15;
    }
    
    // X-Frame-Options (10 points)
    if (hasXFrameOptions) {
      securityScore += 10;
      scoreBreakdown.xFrameOptions = 10;
    }
    
    // X-Content-Type-Options (8 points)
    if (hasXContentTypeOptions) {
      securityScore += 8;
      scoreBreakdown.xContentTypeOptions = 8;
    }
    
    // Referrer-Policy (7 points)
    if (hasReferrerPolicy) {
      securityScore += 7;
      scoreBreakdown.referrerPolicy = 7;
    }
    
    // Ensure score is between 0 and 100
    securityScore = Math.min(100, securityScore);
    
    // Build security details object
    const securityDetails = {
      hasHttps,
      originalProtocol: originalProtocol === 'none' ? 'not specified' : originalProtocol,
      finalProtocol,
      redirectedToHttps,
      hasHsts,
      hasCsp,
      hasXFrameOptions,
      hasXContentTypeOptions,
      hasReferrerPolicy,
      scoreBreakdown
    };
    
    // Add warning if HTTP redirects to HTTPS without HSTS
    if (redirectedToHttps && !hasHsts) {
      securityDetails.warning = 'Site redirects to HTTPS but doesn\'t enforce it with HSTS';
    }
    
    // Calculate overall performance score based on metrics
    const perfScore = pageInfo.perfScore;
    const accessibilityScore = pageInfo.accessibilityScore;
    
    // Calculate status (overall score)
    const overallScore = Math.round((perfScore * 0.4) + (accessibilityScore * 0.3) + (securityScore * 0.3));
    let status = 'Poor';
    if (overallScore >= 90) status = 'Excellent';
    else if (overallScore >= 75) status = 'Good';
    else if (overallScore >= 50) status = 'Fair';

    await browser.close();

    const result = {
      url: finalUrl, // Use final URL (after redirects)
      loadTime: `${(loadTime / 1000).toFixed(2)}s`,
      domContentLoaded: `${(domContentLoaded / 1000).toFixed(2)}s`,
      loadComplete: `${(loadComplete / 1000).toFixed(2)}s`,
      firstByte: `${(firstByte / 1000).toFixed(2)}s`,
      title: title || 'N/A',
      resources: {
        scripts: pageInfo.scripts,
        images: pageInfo.images,
        links: pageInfo.links
      },
      securityScore: securityScore,
      securityDetails: securityDetails,
      performance: perfScore,
      accessibility: accessibilityScore,
      status: status,
      timestamp: new Date().toISOString()
    };

    res.json({
      metrics: result,
      timestamp: new Date().toISOString()
    });

  } catch (error) {
    if (browser) {
      await browser.close().catch(() => {});
    }
    console.error('Speed test error:', error);
    res.status(500).json({
      error: 'Failed to perform speed test',
      message: error.message || 'Speed test failed',
      status: 500
    });
  }
});

module.exports = router;

