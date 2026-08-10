const express = require('express');
const router = express.Router();
const { exec } = require('child_process');
const { promisify } = require('util');
const dns = require('dns').promises;
const { validateDomain } = require('../utils/validation');
const { badRequest, internalError, asyncHandler } = require('../utils/errors');

const execAsync = promisify(exec);

/**
 * POST /api/tools/domain-check
 * Check if a domain is available or taken
 */
router.post('/', asyncHandler(async (req, res) => {
  const { domain } = req.body;

  // Validate domain using utility
  const domainValidation = validateDomain(domain);
  if (!domainValidation.valid) {
    return res.status(400).json(badRequest(domainValidation.error, 'domain'));
  }

  const trimmedDomain = domainValidation.value;

    // Try DNS lookup first (fastest method)
    let isTaken = false;
    try {
      await dns.resolve4(trimmedDomain);
      isTaken = true;
    } catch (error) {
      try {
        await dns.resolve6(trimmedDomain);
        isTaken = true;
      } catch (error6) {
        // Domain might still exist even if no A/AAAA records
        // Try WHOIS lookup as fallback
        try {
          const { stdout } = await execAsync(`whois ${trimmedDomain}`, {
            timeout: 10000
          });
          const whoisText = stdout.toLowerCase();
          const whoisIndicatesRegistered =
            whoisText.includes('domain name:') ||
            whoisText.includes('registrar:') ||
            whoisText.includes('creation date:') ||
            whoisText.includes('updated date:') ||
            whoisText.includes('expiry date:') ||
            whoisText.includes('expiration date:') ||
            whoisText.includes('name server:') ||
            (whoisText.includes('domain status:') && !whoisText.includes('domain status: available'));
          const whoisIndicatesAvailable =
            whoisText.includes('no match') ||
            whoisText.includes('not found') ||
            whoisText.includes('no entries found') ||
            whoisText.includes('status: available') ||
            whoisText.includes('domain status: available') ||
            whoisText.includes('tld is not supported');
          
          if (whoisIndicatesRegistered) {
            isTaken = true;
          } else if (whoisIndicatesAvailable) {
            isTaken = false;
          } else {
            isTaken = false;
          }
        } catch (whoisError) {
          // Check if WHOIS error indicates invalid domain/TLD
          const errorMessage = (whoisError.message || '').toLowerCase();
          const errorStdout = (whoisError.stdout || '').toLowerCase();
          const errorStderr = (whoisError.stderr || '').toLowerCase();
          
          // Check for invalid domain/TLD indicators
          if (errorMessage.includes('invalid') || 
              errorMessage.includes('malformed') ||
              errorStderr.includes('invalid') ||
              errorStderr.includes('malformed') ||
              errorStdout.includes('invalid domain') ||
              errorStdout.includes('malformed domain') ||
              errorStdout.includes('tld is not supported') ||
              errorStdout.includes('no whois server')) {
            // Invalid domain format - return error
            return res.status(400).json(badRequest(
              'Invalid domain. The domain extension (TLD) is not recognized or the domain format is invalid.',
              'domain'
            ));
          }
          
          // If WHOIS fails for other reasons, we can't determine - default to available
          isTaken = false;
        }
      }
    }

    const status = isTaken ? 'taken' : 'available';

    res.json({
      status,
      domain: trimmedDomain,
      timestamp: new Date().toISOString()
    });

}));

module.exports = router;

