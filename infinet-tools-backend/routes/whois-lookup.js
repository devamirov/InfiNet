const express = require('express');
const router = express.Router();
const { validateDomain } = require('../utils/validation');
const { badRequest } = require('../utils/errors');
const { exec } = require('child_process');
const { promisify } = require('util');
const axios = require('axios');
const puppeteer = require('puppeteer');

const execAsync = promisify(exec);

const fetchRdapData = async (domain) => {
  const rdapEndpoints = [
    `https://rdap.org/domain/${domain}`,
    `https://rdap.verisignlabs.com/tld/domain/${domain}`,
    `https://rdap.nic.services/domain/${domain}`,
    `https://rdap.nic.live/domain/${domain}`
  ];
  
  for (const url of rdapEndpoints) {
    try {
      const response = await axios.get(url, { timeout: 6000 });
      if (response.data && !response.data.errorCode && !response.data.error) {
        return response.data;
      }
    } catch (err) {
      console.error('RDAP fetch error:', url, err.message);
    }
  }
  return null;
};

/**
 * POST /api/tools/whois-lookup
 * Perform WHOIS lookup for a domain
 */
router.post('/', async (req, res) => {
  try {
    const { domain } = req.body;

    // Validate domain using utility
    const domainValidation = validateDomain(domain);
    if (!domainValidation.valid) {
      return res.status(400).json(badRequest(domainValidation.error, 'domain'));
    }

    const trimmedDomain = domainValidation.value;

    // Execute WHOIS lookup - Use multiple methods for global coverage
    let rawWhois = '';
    let whoisData = null;
    let whoisError = null;
    
    // FIRST: Try DNS lookup immediately to confirm domain exists
    let dnsResolved = false;
    let dnsError = null;
    try {
      const dns = require('dns').promises;
      try {
        await dns.resolve4(trimmedDomain);
        dnsResolved = true;
      } catch (e) {
        dnsError = e;
        try {
          await dns.resolve6(trimmedDomain);
          dnsResolved = true;
          dnsError = null;
        } catch (e2) {
          dnsError = e2;
          dnsResolved = false;
        }
      }
    } catch (dnsErr) {
      dnsError = dnsErr;
      dnsResolved = false;
    }
    
    // Check if DNS error indicates invalid domain format
    if (!dnsResolved && dnsError) {
      const errorCode = dnsError.code;
      const errorMessage = (dnsError.message || '').toLowerCase();
      
      // DNS errors that indicate invalid domain format
      if (errorCode === 'ENOTFOUND' || errorCode === 'ENODATA') {
        // These are normal for unregistered domains, continue with WHOIS
      } else if (errorCode === 'EINVAL' || errorMessage.includes('invalid') || errorMessage.includes('malformed')) {
        // Invalid domain format
        return res.status(400).json(badRequest(
          'Invalid domain format. Please check the domain name and try again.',
          'domain'
        ));
      }
    }
    
    // If DNS resolves, domain is definitely registered - initialize with registered status
    if (dnsResolved) {
      whoisData = {
        parsed: {
          isRegistered: true,
          registrar: null,
          registrarName: null,
          registrarUrl: null,
          registrarEmail: null,
          registrarPhone: null,
          registrarIanaId: null,
          creationDate: null,
          expiryDate: null,
          updatedDate: null,
          nameServers: [],
          registrantName: null,
          registrantEmail: null,
          registrantPhone: null,
          registrantFax: null,
          registrantOrganization: null,
          registrantAddress: null,
          registrantCity: null,
          registrantState: null,
          registrantZip: null,
          registrantCountry: null,
          adminName: null,
          adminEmail: null,
          adminPhone: null,
          adminOrganization: null,
          adminAddress: null,
          adminCity: null,
          adminState: null,
          adminZip: null,
          adminCountry: null,
          techName: null,
          techEmail: null,
          techPhone: null,
          techOrganization: null,
          techAddress: null,
          techCity: null,
          techState: null,
          techZip: null,
          techCountry: null,
          status: []
        }
      };
      
      // Try to get name servers from DNS
      try {
        const dns = require('dns').promises;
        const nsRecords = await dns.resolveNs(trimmedDomain);
        whoisData.parsed.nameServers = nsRecords;
      } catch (e) {
        // Ignore NS lookup errors
      }
    }
    
    // SECOND: Try standard whois command (with shorter timeout for speed)
    // If DNS already resolved, we know it's registered - just try to get more data
    try {
      let whoisCommand = `whois ${trimmedDomain}`;
      
      // For .services domains, try Identity Digital WHOIS server directly
      if (trimmedDomain.endsWith('.services')) {
        try {
          const { stdout } = await execAsync(`whois -h whois.identity.digital ${trimmedDomain}`, {
            timeout: 5000, // Shorter timeout for speed
            maxBuffer: 1024 * 1024 * 2
          });
          rawWhois = stdout || '';
          const parsed = parseWhoisData(rawWhois, trimmedDomain);
          // Merge parsed data with existing data
          if (whoisData) {
            Object.assign(whoisData.parsed, parsed.parsed);
            // Ensure registered status is preserved if DNS resolved
            if (dnsResolved) {
              whoisData.parsed.isRegistered = true;
            }
          } else {
            whoisData = parsed;
            if (dnsResolved) {
              whoisData.parsed.isRegistered = true;
            }
          }
        } catch (identityError) {
          // Fall back to standard whois
          const { stdout, stderr } = await execAsync(whoisCommand, {
            timeout: 5000, // Shorter timeout for speed
            maxBuffer: 1024 * 1024 * 2
          });
          rawWhois = stdout || '';
          const parsed = parseWhoisData(rawWhois, trimmedDomain);
          if (whoisData) {
            Object.assign(whoisData.parsed, parsed.parsed);
            if (dnsResolved) {
              whoisData.parsed.isRegistered = true;
            }
          } else {
            whoisData = parsed;
            if (dnsResolved) {
              whoisData.parsed.isRegistered = true;
            }
          }
        }
      } else {
        const { stdout, stderr } = await execAsync(whoisCommand, {
          timeout: 8000, // Shorter timeout for speed
          maxBuffer: 1024 * 1024 * 2
        });
        rawWhois = stdout || '';
        const parsed = parseWhoisData(rawWhois, trimmedDomain);
        if (whoisData) {
          Object.assign(whoisData.parsed, parsed.parsed);
          if (dnsResolved) {
            whoisData.parsed.isRegistered = true;
          }
        } else {
          whoisData = parsed;
          if (dnsResolved) {
            whoisData.parsed.isRegistered = true;
          }
        }
      }
      
    } catch (error) {
      console.error('WHOIS command error:', error);
      whoisError = error;
      // Continue with API fallbacks even if whois command fails
      rawWhois = error.stdout || '';
      if (!whoisData) {
        whoisData = parseWhoisData(rawWhois, trimmedDomain);
      }
    }
    
    // CRITICAL: Ensure isRegistered is ALWAYS set correctly
    // If DNS resolved, domain is definitely registered - override any other status
    if (dnsResolved) {
      if (!whoisData) {
        whoisData = {
          parsed: {
            isRegistered: true,
            registrar: null,
            registrarName: null,
            registrarUrl: null,
            registrarEmail: null,
            registrarPhone: null,
            registrarIanaId: null,
            creationDate: null,
            expiryDate: null,
            updatedDate: null,
            nameServers: [],
            registrantName: null,
            registrantEmail: null,
            registrantPhone: null,
            registrantFax: null,
            registrantOrganization: null,
            registrantAddress: null,
            registrantCity: null,
            registrantState: null,
            registrantZip: null,
            registrantCountry: null,
            adminName: null,
            adminEmail: null,
            adminPhone: null,
            adminOrganization: null,
            adminAddress: null,
            adminCity: null,
            adminState: null,
            adminZip: null,
            adminCountry: null,
            techName: null,
            techEmail: null,
            techPhone: null,
            techOrganization: null,
            techAddress: null,
            techCity: null,
            techState: null,
            techZip: null,
            techCountry: null,
            status: []
          }
        };
      } else {
        whoisData.parsed.isRegistered = true; // Always override if DNS resolved
      }
    }
    
    // If TLD not supported or no clear indicators, try alternative WHOIS API
    const tldNotSupported = rawWhois.toLowerCase().includes('tld is not supported') || 
                           rawWhois.toLowerCase().includes('no whois server is known') ||
                           rawWhois.toLowerCase().includes('invalid domain') ||
                           rawWhois.toLowerCase().includes('malformed domain');
    const hasWhoisError = whoisError && (whoisError.code === 1 || whoisError.code === 'ENOENT');
    
    // Check if WHOIS error indicates invalid domain (only if DNS didn't resolve)
    if (whoisError && !dnsResolved && (tldNotSupported || hasWhoisError)) {
      const errorMessage = (whoisError.message || '').toLowerCase();
      const errorStderr = (whoisError.stderr || '').toLowerCase();
      const errorStdout = (whoisError.stdout || rawWhois || '').toLowerCase();
      
      // Check for invalid domain indicators
      if (errorMessage.includes('invalid') || 
          errorMessage.includes('malformed') ||
          errorStderr.includes('invalid') ||
          errorStderr.includes('malformed') ||
          errorStdout.includes('invalid domain') ||
          errorStdout.includes('malformed domain') ||
          errorStdout.includes('tld is not supported') ||
          errorStdout.includes('no whois server')) {
        return res.status(400).json(badRequest(
          'Invalid domain. The domain extension (TLD) is not recognized or the domain format is invalid.',
          'domain'
        ));
      }
    }
    
    // Helper function to check if value is privacy policy text or REDACTED (not real data)
    const isPrivacyPolicyText = (val) => {
      if (!val || typeof val !== 'string') return false;
      const lowerVal = val.toLowerCase().trim();
      
      // Check for REDACTED (exact match or in context)
      if (lowerVal === 'redacted' || lowerVal === '[redacted]' || lowerVal === '(redacted)') {
        return true;
      }
      
      // Check for privacy policy text
      if (lowerVal.length < 10) return false;
      return lowerVal.includes('access to non-public data') ||
             lowerVal.includes('layered access') ||
             lowerVal.includes('identity digital inc.') ||
             lowerVal.includes('upon request') ||
             lowerVal.includes('legitimate interest') ||
             lowerVal.includes('legal basis') ||
             lowerVal.includes('withheld data') ||
             lowerVal.includes('url listed above') ||
             lowerVal.includes('reserve the right to modify') ||
             lowerVal.includes('by submitting this query') ||
             lowerVal.includes('may be provided, upon request') ||
             lowerVal.includes('withheld for privacy') ||
             lowerVal.includes('privacy service provided') ||
             lowerVal.length > 200; // Very long values are likely privacy policy text
    };
    
    const isRedactedValue = (val) => {
      if (!val || typeof val !== 'string') return false;
      const lowerVal = val.toLowerCase().trim();
      if (!lowerVal) return false;
      if (
        lowerVal === 'redacted' ||
        lowerVal === '[redacted]' ||
        lowerVal === '(redacted)' ||
        lowerVal === '{redacted}' ||
        lowerVal === '<redacted>' ||
        lowerVal === 'redacted for privacy'
      ) {
        return true;
      }
      return lowerVal.includes('redacted');
    };
    
    // Clean up privacy policy text from registrar fields BEFORE storing originals
    if (whoisData.parsed.registrarName && isPrivacyPolicyText(whoisData.parsed.registrarName)) {
      whoisData.parsed.registrarName = null;
      whoisData.parsed.registrar = null;
    }
    if (whoisData.parsed.registrarUrl && isPrivacyPolicyText(whoisData.parsed.registrarUrl)) {
      whoisData.parsed.registrarUrl = null;
    }
    if (whoisData.parsed.registrarEmail && isPrivacyPolicyText(whoisData.parsed.registrarEmail)) {
      whoisData.parsed.registrarEmail = null;
    }
    
    // Store original parsed data to preserve registrar/dates from standard WHOIS
    const originalRegistrarName = whoisData.parsed.registrarName;
    const originalRegistrarUrl = whoisData.parsed.registrarUrl;
    const originalCreationDate = whoisData.parsed.creationDate;
    const originalExpiryDate = whoisData.parsed.expiryDate;
    const originalUpdatedDate = whoisData.parsed.updatedDate;
    const originalNameServers = [...(whoisData.parsed.nameServers || [])];
    const originalIsRegistered = whoisData.parsed.isRegistered; // Preserve registration status
    
    // Check if it's a GoDaddy domain (by name servers or registrar) - check BEFORE API calls
    const isGoDaddyDomain = (originalRegistrarName && originalRegistrarName.toLowerCase().includes('godaddy')) ||
                            (originalRegistrarUrl && originalRegistrarUrl.toLowerCase().includes('godaddy')) ||
                            (originalNameServers && originalNameServers.some(ns => ns.toLowerCase().includes('godaddy') || ns.toLowerCase().includes('domaincontrol'))) ||
                            (whoisData.parsed.nameServers && whoisData.parsed.nameServers.some(ns => ns.toLowerCase().includes('godaddy') || ns.toLowerCase().includes('domaincontrol')));
    
    // For .services domains, always try Puppeteer/APIs since WHOIS often returns privacy policy text
    const isServicesDomain = trimmedDomain.endsWith('.services');
    
    // Skip Puppeteer if DNS didn't resolve (domain doesn't exist) - saves time
    // Use Puppeteer for GoDaddy/.services domains that need registrant info OR have privacy policy text
    const needsRegistrantInfo = !whoisData.parsed.registrantName || !whoisData.parsed.registrantEmail;
    const hasPrivacyPolicyText = isPrivacyPolicyText(originalRegistrarName) || 
                                 isPrivacyPolicyText(originalRegistrarUrl) ||
                                 !originalRegistrarName || !originalCreationDate;
    const whoisFailed = tldNotSupported || hasWhoisError;
    
    // Use Puppeteer if:
    // 1. DNS resolved (domain exists)
    // 2. It's a GoDaddy/.services domain OR we're missing dates/name servers
    // 3. We need registrant info OR registrar info is missing/privacy policy text OR missing dates/name servers
    const missingDatesOrNS = !whoisData.parsed.creationDate || !whoisData.parsed.expiryDate || 
                             !whoisData.parsed.nameServers || whoisData.parsed.nameServers.length === 0;
    
    if (dnsResolved && (isGoDaddyDomain || isServicesDomain || missingDatesOrNS) && 
        (needsRegistrantInfo || hasPrivacyPolicyText || missingDatesOrNS)) {
      let browser = null;
      try {
        // Use Puppeteer to scrape GoDaddy's public WHOIS page (JavaScript-rendered)
        browser = await puppeteer.launch({
          headless: true,
          args: ['--no-sandbox', '--disable-setuid-sandbox']
        });
        const page = await browser.newPage();
        await page.setUserAgent('Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36');
        
        const godaddyWhoisUrl = `https://www.godaddy.com/whois/results.aspx?domain=${trimmedDomain}`;
        await page.goto(godaddyWhoisUrl, { waitUntil: 'networkidle2', timeout: 10000 });
        
        // Wait for WHOIS data to load - wait longer for dynamic content
        await page.waitForTimeout(3000);
        
        // Try to wait for specific elements that contain registrant info
        try {
          await page.waitForSelector('body', { timeout: 10000 });
        } catch (e) {
          // Continue even if selector doesn't appear
        }
        
        // Extract ALL information from the page (registrant, registrar, dates, name servers)
        const allData = await page.evaluate(() => {
          const data = {};
          
          // Get all text content from the page
          const allText = document.body.innerText || document.body.textContent || '';
          
          // Helper function to check if value is privacy policy text
          const isPrivacyPolicyText = (val) => {
            if (!val || val.length < 10) return false;
            const lowerVal = val.toLowerCase();
            return lowerVal.includes('access to non-public data') ||
                   lowerVal.includes('layered access') ||
                   lowerVal.includes('identity digital inc.') ||
                   lowerVal.includes('upon request') ||
                   lowerVal.includes('legitimate interest') ||
                   lowerVal.includes('legal basis') ||
                   lowerVal.includes('withheld data') ||
                   lowerVal.includes('url listed above') ||
                   lowerVal.includes('reserve the right to modify') ||
                   lowerVal.includes('by submitting this query') ||
                   lowerVal.includes('may be provided, upon request') ||
                   lowerVal.length > 200;
          };
          
          // Parse registrar information FIRST - but filter out privacy policy text
          const registrarMatch = allText.match(/Registrar[:\s]+([^\n]+)/i);
          if (registrarMatch) {
            const registrarName = registrarMatch[1].trim();
            // Only store if it's not privacy policy text and looks like a real registrar name
            if (!isPrivacyPolicyText(registrarName) && 
                registrarName.length < 100 && 
                !registrarName.toLowerCase().includes('access to non-public') &&
                (registrarName.toLowerCase().includes('godaddy') || registrarName.toLowerCase().includes('llc') || registrarName.toLowerCase().includes('inc.') || registrarName.length < 50)) {
              data.registrarName = registrarName;
            }
          }
          
          const registrarUrlMatch = allText.match(/Registrar\s+(?:URL|Website|Whois)[:\s]+([^\n]+)/i);
          if (registrarUrlMatch) {
            const registrarUrl = registrarUrlMatch[1].trim();
            // Only store if it's a valid URL and not privacy policy text
            if (!isPrivacyPolicyText(registrarUrl) && 
                (registrarUrl.startsWith('http') || registrarUrl.includes('.com') || registrarUrl.includes('.net')) &&
                !registrarUrl.toLowerCase().includes('access to non-public')) {
              data.registrarUrl = registrarUrl;
            }
          }
          
          // Also try to find registrar from name servers (common pattern: "nsXX.domaincontrol.com" = GoDaddy)
          if (!data.registrarName) {
            if (allText.match(/domaincontrol\.com/i)) {
              data.registrarName = 'GoDaddy.com, LLC';
              data.registrarUrl = 'https://www.godaddy.com';
            }
          }
          
          // Parse dates - try multiple patterns for better extraction
          const datePatterns = {
            created: [
              /Created[:\s]+([^\n\r]+)/i,
              /Creation[:\s]+Date[:\s]+([^\n\r]+)/i,
              /Domain[:\s]+Created[:\s]+([^\n\r]+)/i,
              /Registration[:\s]+Date[:\s]+([^\n\r]+)/i,
              /Created\s+On[:\s]+([^\n\r]+)/i
            ],
            expires: [
              /Expires?[:\s]+([^\n\r]+)/i,
              /Expiration[:\s]+Date[:\s]+([^\n\r]+)/i,
              /Expiry[:\s]+Date[:\s]+([^\n\r]+)/i,
              /Domain[:\s]+Expires?[:\s]+([^\n\r]+)/i,
              /Expires\s+On[:\s]+([^\n\r]+)/i,
              /Registry[:\s]+Expiry[:\s]+Date[:\s]+([^\n\r]+)/i
            ],
            updated: [
              /Updated[:\s]+([^\n\r]+)/i,
              /Last[:\s]+Updated[:\s]+([^\n\r]+)/i,
              /Modification[:\s]+Date[:\s]+([^\n\r]+)/i,
              /Updated\s+On[:\s]+([^\n\r]+)/i
            ]
          };
          
          // Try all patterns for creation date
          for (const pattern of datePatterns.created) {
            const match = allText.match(pattern);
            if (match) {
              const date = match[1].trim();
              if (date && date.length > 5 && date.length < 100) {
                data.creationDate = date;
                break;
              }
            }
          }
          
          // Try all patterns for expiry date
          for (const pattern of datePatterns.expires) {
            const match = allText.match(pattern);
            if (match) {
              const date = match[1].trim();
              if (date && date.length > 5 && date.length < 100) {
                data.expiryDate = date;
                break;
              }
            }
          }
          
          // Try all patterns for updated date
          for (const pattern of datePatterns.updated) {
            const match = allText.match(pattern);
            if (match) {
              const date = match[1].trim();
              if (date && date.length > 5 && date.length < 100) {
                data.updatedDate = date;
                break;
              }
            }
          }
          
          // Parse name servers - try multiple patterns for better extraction
          let nsList = [];
          
          // Pattern 1: "Name Server:" or "Name Server " followed by domain
          const nsMatches1 = allText.match(/Name\s+Server[:\s]+([^\n\r]+)/gi);
          if (nsMatches1) {
            nsMatches1.forEach(ns => {
              const match = ns.match(/Name\s+Server[:\s]+(.+)/i);
              if (match) {
                const nsValue = match[1].trim();
                if (nsValue && nsValue.length > 0 && nsValue.match(/[a-z0-9]+\.[a-z0-9.]+/i) && nsValue.length < 255) {
                  nsList.push(nsValue);
                }
              }
            });
          }
          
          // Pattern 2: Look for common DNS patterns (ns1.domain.com, ns2.domain.com, etc.) in lines
          if (nsList.length === 0) {
            const lines = allText.split(/\n|\r/);
            for (const line of lines) {
              const trimmed = line.trim();
              // Look for lines that start with "ns" or contain ".domaincontrol." or similar patterns
              if (trimmed.match(/^(ns\d*\.?[a-z0-9.-]+\.[a-z]{2,})/i) ||
                  trimmed.match(/domaincontrol\.com/i) ||
                  (trimmed.match(/[a-z0-9-]+\.[a-z0-9.-]+\.[a-z]{2,}/i) && trimmed.length > 5 && trimmed.length < 255)) {
                if (!trimmed.toLowerCase().includes('name server') && 
                    !trimmed.toLowerCase().includes('nameserver') &&
                    !trimmed.toLowerCase().includes('registrar') &&
                    trimmed.match(/[a-z0-9]+\.[a-z0-9.]+/i)) {
                  if (!nsList.includes(trimmed)) {
                    nsList.push(trimmed);
                  }
                }
              }
            }
          }
          
          // Pattern 3: Extract from "Name Servers:" section if found
          const nsSectionMatch = allText.match(/Name\s+Server[s]?[:\s]*\n?([^\n]+(?:\n[^\n]+)*?)(?=\n\s*(?:Admin|Tech|Registrant|Registrar|Domain|Status|$))/i);
          if (nsSectionMatch && nsList.length === 0) {
            const nsSection = nsSectionMatch[1];
            const nsLines = nsSection.split(/\n|\r/);
            for (const line of nsLines) {
              const trimmed = line.trim();
              if (trimmed.match(/[a-z0-9]+\.[a-z0-9.]+/i) && trimmed.length > 5 && trimmed.length < 255) {
                if (!nsList.includes(trimmed)) {
                  nsList.push(trimmed);
                }
              }
            }
          }
          
          // Remove duplicates and filter invalid entries
          nsList = [...new Set(nsList)].filter(ns => 
            ns && ns.length > 0 && ns.match(/[a-z0-9]+\.[a-z0-9.]+/i) && ns.length < 255
          );
          
          if (nsList.length > 0) {
            data.nameServers = nsList;
          }
          
          // Try multiple patterns to find registrant section
          let sectionText = allText;
          const registrantSectionPatterns = [
            /Registrant\s+Contact[:\s]*([\s\S]*?)(?=Admin|Tech|Name Server|Registrar|Domain Status|$)/i,
            /REGISTRANT\s+CONTACT[:\s]*([\s\S]*?)(?=ADMIN|TECH|NAME SERVER|REGISTRAR|DOMAIN STATUS|$)/i,
            /Registrant[:\s]*([\s\S]*?)(?=Admin|Tech|Name Server|Registrar|Domain Status|$)/i
          ];
          
          for (const pattern of registrantSectionPatterns) {
            const match = allText.match(pattern);
            if (match && match[1] && match[1].trim().length > 10) {
              sectionText = match[1];
              break;
            }
          }
          
          // If no clear section found, try to find by looking for field patterns
          if (sectionText === allText || sectionText.length < 20) {
            // Split into lines and find registrant section
            const lines = allText.split('\n');
            let startIdx = -1;
            let endIdx = lines.length;
            
            for (let i = 0; i < lines.length; i++) {
              const line = lines[i].toLowerCase().trim();
              if ((line.includes('registrant') && (line.includes('contact') || line.includes('name') || line.includes('email'))) ||
                  (line === 'registrant contact:' || line === 'registrant:')) {
                startIdx = i;
                break;
              }
            }
            
            if (startIdx >= 0) {
              // Find end of registrant section
              for (let i = startIdx + 1; i < lines.length; i++) {
                const line = lines[i].toLowerCase().trim();
                if ((line.includes('admin') || line.includes('tech') || line.includes('name server') || 
                     line.includes('domain status') || line.includes('registrar')) && i > startIdx + 3) {
                  endIdx = i;
                  break;
                }
              }
              sectionText = lines.slice(startIdx, endIdx).join('\n');
            }
          }
          
          // Parse registrant name - be very strict to avoid false matches
          // Look for "Name:" or "Name." followed by actual name (not domain, not email, not organization)
          const namePatterns = [
            /^name[:\s\.]+\s*([^\n]+?)(?=\s+Organization|\s+Phone|\s+Email|\s+Mailing|$)/im,
            /registrant\s+contact\s+name[:\s\.]+\s*([^\n]+)/i,
            /registrant\s+name[:\s\.]+\s*([^\n]+)/i
          ];
          
          for (const pattern of namePatterns) {
            const nameMatch = sectionText.match(pattern);
            if (nameMatch) {
              let name = nameMatch[1].trim();
              // Clean up - remove leading dots, colons, spaces
              name = name.replace(/^[:\s\.]+|[:\s\.]+$/g, '').trim();
              
              // Validate name - must be a real person/company name
              if (name && name.length > 2 && name.length < 100 &&
                  !name.match(/^[a-z0-9.-]+\.[a-z]{2,}$/i) && // Not a domain
                  !name.includes('@') && // Not an email
                  !name.match(/^tel:/i) && // Not a phone
                  !name.match(/^\+?\d+[\d\s\-().]*$/) && // Not just a phone number
                  !name.toLowerCase().includes('privacy') && 
                  !name.toLowerCase().includes('proxy') && 
                  !name.toLowerCase().includes('domains by proxy') &&
                  !name.toLowerCase().includes('whois') &&
                  !name.toLowerCase().includes('registrar') &&
                  name.match(/[a-zA-Z]/)) { // Must contain at least one letter
                data.name = name;
                break;
              }
            }
          }
          
          // If no name found with patterns, try to find it by position (but be more strict)
          if (!data.name) {
            const lines = sectionText.split('\n');
            for (let i = 0; i < Math.min(15, lines.length); i++) {
              const line = lines[i].trim();
              const lowerLine = line.toLowerCase();
              
              // Skip if it's clearly not a name
              if (line.match(/@/) || 
                  line.match(/tel:|phone|email|organization|org|mailing|address|country|city|state|zip/i) ||
                  line.match(/^[a-z0-9.-]+\.[a-z]{2,}$/i) ||
                  line.match(/^\+?\d+[\d\s\-().]*$/) ||
                  lowerLine.includes('privacy') ||
                  lowerLine.includes('proxy') ||
                  lowerLine.includes('registrar') ||
                  line.length < 3 ||
                  line.length > 100 ||
                  !line.match(/[a-zA-Z]/)) {
                continue;
              }
              
              // Check if previous line mentions "name" or "registrant contact"
              if (i > 0) {
                const prevLine = lines[i-1].toLowerCase().trim();
                if (prevLine.includes('name') || prevLine.includes('registrant contact') || prevLine === 'registrant contact:') {
                  // Additional validation - must look like a name
                  if (line.match(/^[A-Z][a-zA-Z\s]+[a-zA-Z]$/) || // "First Last" format
                      line.match(/^[A-Z][a-zA-Z\s]+[a-zA-Z]\s+[A-Z][a-zA-Z]+$/) || // "First Last Middle" format
                      (line.split(' ').length >= 2 && line.split(' ').length <= 5)) { // 2-5 words
                    data.name = line.replace(/^[:\s\.]+/, '').trim();
                    break;
                  }
                }
              }
            }
          }
          
          // Parse email - look for email addresses in registrant section
          const emailRegex = /([a-zA-Z0-9._%+-]+@[a-zA-Z0-9.-]+\.[a-zA-Z]{2,})/g;
          const emailMatches = sectionText.match(emailRegex);
          
          if (emailMatches && emailMatches.length > 0) {
            // Filter out privacy/proxy emails
            for (const email of emailMatches) {
              if (!email.toLowerCase().includes('privacy') && 
                  !email.toLowerCase().includes('proxy') && 
                  !email.toLowerCase().includes('domainsbyproxy') &&
                  !email.toLowerCase().includes('whois') &&
                  !email.toLowerCase().includes('abuse') &&
                  !email.toLowerCase().includes('registrar')) {
                data.email = email.trim();
                break;
              }
            }
          }
          
          // If still no email, try patterns with various formats
          if (!data.email) {
            const emailPatterns = [
              /email[:\s\.]+([a-zA-Z0-9._%+-]+@[a-zA-Z0-9.-]+\.[a-zA-Z]{2,})/i,
              /registrant\s+email[:\s\.]+([a-zA-Z0-9._%+-]+@[a-zA-Z0-9.-]+\.[a-zA-Z]{2,})/i,
              /e-mail[:\s\.]+([a-zA-Z0-9._%+-]+@[a-zA-Z0-9.-]+\.[a-zA-Z]{2,})/i
            ];
            
            for (const pattern of emailPatterns) {
              const emailMatch = sectionText.match(pattern);
              if (emailMatch) {
                const email = emailMatch[1].trim();
                if (email && !email.toLowerCase().includes('privacy') && !email.toLowerCase().includes('proxy') && !email.toLowerCase().includes('domainsbyproxy')) {
                  data.email = email;
                  break;
                }
              }
            }
          }
          
          // Last resort: search entire page text for email if section didn't have it
          if (!data.email) {
            const allEmailMatches = allText.match(emailRegex);
            if (allEmailMatches && allEmailMatches.length > 0) {
              for (const email of allEmailMatches) {
                if (!email.toLowerCase().includes('privacy') && 
                    !email.toLowerCase().includes('proxy') && 
                    !email.toLowerCase().includes('domainsbyproxy') &&
                    !email.toLowerCase().includes('whois') &&
                    !email.toLowerCase().includes('abuse') &&
                    !email.toLowerCase().includes('registrar') &&
                    email.toLowerCase().includes('@')) {
                  data.email = email.trim();
                  break;
                }
              }
            }
          }
          
          // Parse phone
          const phonePatterns = [
            /phone[:\s\.]+([+\d\s\-().:]+)/i,
            /registrant\s+phone[:\s\.]+([+\d\s\-().:]+)/i,
            /tel[:\s\.]+([+\d\s\-().:]+)/i,
            /telephone[:\s\.]+([+\d\s\-().:]+)/i
          ];
          
          for (const pattern of phonePatterns) {
            const phoneMatch = sectionText.match(pattern);
            if (phoneMatch) {
              let phone = phoneMatch[1].trim();
              phone = phone.replace(/^[:\s\.]+/, '').trim();
              if (phone && phone.length > 0 && phone.match(/\d/)) {
                if (!phone.toLowerCase().startsWith('tel:')) {
                  phone = 'tel:' + phone.replace(/^tel:?\s*/i, '');
                }
                data.phone = phone;
                break;
              }
            }
          }
          
          // Parse organization
          const orgPatterns = [
            /organization[:\s\.]+([^\n]+?)(?=\s+Phone|\s+Email|\s+Mailing|$)/i,
            /registrant\s+organization[:\s\.]+([^\n]+)/i,
            /org[:\s\.]+([^\n]+)/i,
            /company[:\s\.]+([^\n]+)/i
          ];
          
          for (const pattern of orgPatterns) {
            const orgMatch = sectionText.match(pattern);
            if (orgMatch) {
              let org = orgMatch[1].trim();
              org = org.replace(/^[:\s\.]+|[:\s\.]+$/g, '').trim();
              if (org && org.length > 0 && 
                  !org.toLowerCase().includes('privacy') && 
                  !org.toLowerCase().includes('proxy') && 
                  !org.toLowerCase().includes('domains by proxy') &&
                  org.length < 200) {
                data.organization = org;
                break;
              }
            }
          }
          
          // Parse mailing address
          const addressPatterns = [
            /mailing\s+address[:\s\.]+([^\n]+)/i,
            /address[:\s\.]+([^\n]+)/i
          ];
          
          for (const pattern of addressPatterns) {
            const addrMatch = sectionText.match(pattern);
            if (addrMatch) {
              let addr = addrMatch[1].trim();
              addr = addr.replace(/^[:\s\.]+/, '').trim();
              if (addr && addr.length > 0) {
                data.address = addr;
                break;
              }
            }
          }
          
          return data;
        });
        
        // Update parsed data with scraped information
        // If WHOIS failed, use ALL data from Puppeteer
        // Otherwise, only update missing registrant fields
        
        // If WHOIS failed OR we have privacy policy text, use all Puppeteer data
        if (whoisFailed || hasPrivacyPolicyText || !originalCreationDate || !originalExpiryDate) {
          // WHOIS failed or has privacy policy - use all Puppeteer data
          if (allData.registrarName && (!whoisData.parsed.registrarName || isPrivacyPolicyText(whoisData.parsed.registrarName))) {
            whoisData.parsed.registrarName = allData.registrarName;
            whoisData.parsed.registrar = allData.registrarName;
          }
          if (allData.registrarUrl && (!whoisData.parsed.registrarUrl || isPrivacyPolicyText(whoisData.parsed.registrarUrl))) {
            whoisData.parsed.registrarUrl = allData.registrarUrl;
          }
          if (allData.creationDate && (!whoisData.parsed.creationDate || isPrivacyPolicyText(whoisData.parsed.creationDate))) {
            whoisData.parsed.creationDate = allData.creationDate;
          }
          if (allData.expiryDate && (!whoisData.parsed.expiryDate || isPrivacyPolicyText(whoisData.parsed.expiryDate))) {
            whoisData.parsed.expiryDate = allData.expiryDate;
          }
          if (allData.updatedDate && (!whoisData.parsed.updatedDate || isPrivacyPolicyText(whoisData.parsed.updatedDate))) {
            whoisData.parsed.updatedDate = allData.updatedDate;
          }
          if (allData.nameServers && allData.nameServers.length > 0 && (!whoisData.parsed.nameServers || whoisData.parsed.nameServers.length === 0)) {
            whoisData.parsed.nameServers = allData.nameServers;
          }
          // ALWAYS mark as registered if we got ANY data from Puppeteer (domain exists on GoDaddy)
          whoisData.parsed.isRegistered = true;
        } else {
          // WHOIS succeeded - but if we have privacy policy text, we need to get dates/name servers from Puppeteer
          const needsDatesFromPuppeteer = hasPrivacyPolicyText || !originalCreationDate || !originalExpiryDate;
          
          // Preserve registrar (already filtered for privacy policy text)
          if (originalRegistrarName && !isPrivacyPolicyText(originalRegistrarName)) {
            whoisData.parsed.registrarName = originalRegistrarName;
            whoisData.parsed.registrar = originalRegistrarName;
          }
          if (originalRegistrarUrl && !isPrivacyPolicyText(originalRegistrarUrl)) {
            whoisData.parsed.registrarUrl = originalRegistrarUrl;
          }
          
          // Always prefer Puppeteer dates if available (more accurate)
          // Only use original dates if Puppeteer doesn't have them AND they're valid
          if (allData.creationDate) {
            whoisData.parsed.creationDate = allData.creationDate;
          } else if (originalCreationDate && !isPrivacyPolicyText(originalCreationDate)) {
            whoisData.parsed.creationDate = originalCreationDate;
          }
          
          if (allData.expiryDate) {
            whoisData.parsed.expiryDate = allData.expiryDate;
          } else if (originalExpiryDate && !isPrivacyPolicyText(originalExpiryDate)) {
            whoisData.parsed.expiryDate = originalExpiryDate;
          }
          
          if (allData.updatedDate) {
            whoisData.parsed.updatedDate = allData.updatedDate;
          } else if (originalUpdatedDate && !isPrivacyPolicyText(originalUpdatedDate)) {
            whoisData.parsed.updatedDate = originalUpdatedDate;
          }
          
          // Always prefer Puppeteer name servers if available
          if (allData.nameServers && allData.nameServers.length > 0) {
            whoisData.parsed.nameServers = allData.nameServers;
          } else if (originalNameServers.length > 0) {
            whoisData.parsed.nameServers = originalNameServers;
          }
          
          // CRITICAL: Restore original isRegistered status (never mark registered domains as available)
          if (originalIsRegistered !== undefined && originalIsRegistered !== null) {
            whoisData.parsed.isRegistered = originalIsRegistered;
          }
        }
        
        // Always update registrant fields if found
        if (allData.name && !whoisData.parsed.registrantName) {
          whoisData.parsed.registrantName = allData.name;
        }
        if (allData.email && !whoisData.parsed.registrantEmail) {
          whoisData.parsed.registrantEmail = allData.email;
        }
        if (allData.phone && !whoisData.parsed.registrantPhone) {
          whoisData.parsed.registrantPhone = allData.phone;
        }
        if (allData.organization && !whoisData.parsed.registrantOrganization) {
          whoisData.parsed.registrantOrganization = allData.organization;
        }
        if (allData.address && !whoisData.parsed.registrantAddress) {
          whoisData.parsed.registrantAddress = allData.address;
        }
        
        await browser.close();
      } catch (scrapeError) {
        console.error('GoDaddy WHOIS Puppeteer scrape error:', scrapeError.message);
        if (browser) {
          try {
            await browser.close();
          } catch (e) {}
        }
        // Continue - don't fail if Puppeteer fails
      }
    }
    
    // Try alternative WHOIS APIs - ALWAYS try APIs for ALL domains when missing critical data
    // This ensures global coverage for ALL TLDs (.services, .life, .com, etc.)
    const hasValidRegistrar = originalRegistrarName && !isPrivacyPolicyText(originalRegistrarName);
    const hasDates = whoisData.parsed.creationDate && whoisData.parsed.expiryDate;
    const hasNameServers = whoisData.parsed.nameServers && whoisData.parsed.nameServers.length > 0;
    
    // ALWAYS try APIs for ALL domains - maximum coverage and dates for all TLDs
    // This ensures dates are ALWAYS fetched for ALL domains
    const shouldTryAPIs = true; // Always call APIs - they have better global coverage
    
    // ALWAYS try APIs for ALL domains - maximum coverage
    if (true) { // Always call APIs - they have better global coverage
      try {
        // Try multiple WHOIS APIs as fallback
        // 1. Try ipwhois.app (free, no API key needed) - works globally
        try {
          const ipwhoisUrl = `https://ipwhois.app/json/${trimmedDomain}`;
          const ipwhoisResponse = await axios.get(ipwhoisUrl, { timeout: 5000 });
          if (ipwhoisResponse.data && ipwhoisResponse.data.success !== false) {
            const data = ipwhoisResponse.data;
            const pickDateValue = (...candidates) => {
              for (const candidate of candidates) {
                if (candidate && typeof candidate === 'string') {
                  const trimmed = candidate.trim();
                  if (trimmed && !isPrivacyPolicyText(trimmed) && !isRedactedValue(trimmed)) {
                    return trimmed;
                  }
                }
              }
              return null;
            };
            // Only update if we don't already have the data
            if (data.registrar && !whoisData.parsed.registrarName) {
              whoisData.parsed.registrarName = data.registrar;
              whoisData.parsed.registrar = data.registrar;
            }
            if (data.registrar_url && !whoisData.parsed.registrarUrl) {
              whoisData.parsed.registrarUrl = data.registrar_url;
            }
            // ALWAYS update dates from APIs - APIs have better global coverage and more accurate dates
            // Prefer API dates over WHOIS dates
            const creationValue = pickDateValue(
              data.creation_date,
              data.create_date,
              data.created,
              data.registration_date,
              data.domain_created,
              data.registry_created_at
            );
            if (creationValue) {
              whoisData.parsed.creationDate = creationValue;
            }
            const expiryValue = pickDateValue(
              data.expiry_date,
              data.expiration_date,
              data.expires,
              data.domain_expiration,
              data.registry_expire_at,
              data.expire_date
            );
            if (expiryValue) {
              whoisData.parsed.expiryDate = expiryValue;
            }
            const updatedValue = pickDateValue(
              data.updated_date,
              data.last_updated,
              data.domain_updated,
              data.registry_updated_at,
              data.update_date
            );
            if (updatedValue) {
              whoisData.parsed.updatedDate = updatedValue;
            }
            // Always update name servers if missing
            if (data.name_servers && Array.isArray(data.name_servers) && data.name_servers.length > 0) {
              if (!whoisData.parsed.nameServers || whoisData.parsed.nameServers.length === 0) {
                whoisData.parsed.nameServers = data.name_servers;
              } else {
                // Merge name servers if we have some but not all
                const existingNS = new Set(whoisData.parsed.nameServers.map(ns => ns.toLowerCase()));
                const newNS = data.name_servers.filter(ns => !existingNS.has(ns.toLowerCase()));
                if (newNS.length > 0) {
                  whoisData.parsed.nameServers = [...whoisData.parsed.nameServers, ...newNS];
                }
              }
            }
            // Only update registrant fields if they're not REDACTED or privacy-protected
            if (data.registrant_name && !whoisData.parsed.registrantName && !isRedactedValue(data.registrant_name)) {
              whoisData.parsed.registrantName = data.registrant_name;
            }
            if (data.registrant_email && !whoisData.parsed.registrantEmail && !isRedactedValue(data.registrant_email)) {
              whoisData.parsed.registrantEmail = data.registrant_email;
            }
            if (data.registrant_phone && !whoisData.parsed.registrantPhone && !isRedactedValue(data.registrant_phone)) {
              whoisData.parsed.registrantPhone = data.registrant_phone;
            }
            if (data.registrant_organization && !whoisData.parsed.registrantOrganization && !isRedactedValue(data.registrant_organization)) {
              whoisData.parsed.registrantOrganization = data.registrant_organization;
            }
            if (data.registrant_address && !whoisData.parsed.registrantAddress) whoisData.parsed.registrantAddress = data.registrant_address;
            if (data.registrant_city && !whoisData.parsed.registrantCity) whoisData.parsed.registrantCity = data.registrant_city;
            if (data.registrant_state && !whoisData.parsed.registrantState) whoisData.parsed.registrantState = data.registrant_state;
            if (data.registrant_postal_code && !whoisData.parsed.registrantZip) whoisData.parsed.registrantZip = data.registrant_postal_code;
            if (data.registrant_country && !whoisData.parsed.registrantCountry) whoisData.parsed.registrantCountry = data.registrant_country;
            if (data.name_servers && Array.isArray(data.name_servers) && (!whoisData.parsed.nameServers || whoisData.parsed.nameServers.length === 0)) {
              whoisData.parsed.nameServers = data.name_servers;
            }
            whoisData.parsed.isRegistered = true;
            if (!rawWhois || rawWhois.length < 100) {
              rawWhois = JSON.stringify(data, null, 2);
            }
          }
        } catch (ipwhoisError) {
          console.error('ipwhois.app API error:', ipwhoisError.message);
          // Try next API
        }
        
        // 2. Try GoDaddy public WHOIS page scraping with Puppeteer ONLY for registrant info
        // Only use Puppeteer if we're missing registrant info AND it's a GoDaddy domain
        const isGoDaddyDomain = (whoisData.parsed.registrarName && whoisData.parsed.registrarName.toLowerCase().includes('godaddy')) ||
                                (whoisData.parsed.registrarUrl && whoisData.parsed.registrarUrl.toLowerCase().includes('godaddy')) ||
                                (whoisData.parsed.nameServers && whoisData.parsed.nameServers.some(ns => ns.toLowerCase().includes('godaddy') || ns.toLowerCase().includes('domaincontrol')));
        
        // Only use Puppeteer if:
        // 1. We're missing registrant info AND
        // 2. It's a GoDaddy domain OR .services domain AND
        // 3. Standard WHOIS already has registrar/dates (so we don't break working domains)
        const hasRegistrarInfo = whoisData.parsed.registrarName || whoisData.parsed.registrarUrl;
        const hasDates = whoisData.parsed.creationDate || whoisData.parsed.expiryDate;
        const needsRegistrantInfo = !whoisData.parsed.registrantName || !whoisData.parsed.registrantEmail;
        
        if (needsRegistrantInfo && (isGoDaddyDomain || trimmedDomain.endsWith('.services')) && (hasRegistrarInfo || hasDates || !tldNotSupported)) {
          let browser = null;
          try {
            // Use Puppeteer to scrape GoDaddy's public WHOIS page (JavaScript-rendered)
            browser = await puppeteer.launch({
              headless: true,
              args: ['--no-sandbox', '--disable-setuid-sandbox']
            });
            const page = await browser.newPage();
            await page.setUserAgent('Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36');
            
            const godaddyWhoisUrl = `https://www.godaddy.com/whois/results.aspx?domain=${trimmedDomain}`;
            await page.goto(godaddyWhoisUrl, { waitUntil: 'networkidle2', timeout: 10000 });
            
            // Wait for WHOIS data to load - wait longer for dynamic content
            await page.waitForTimeout(3000);
            
            // Try to wait for specific elements that contain registrant info
            try {
              await page.waitForSelector('body', { timeout: 10000 });
            } catch (e) {
              // Continue even if selector doesn't appear
            }
            
            // Extract registrant information from the page
            const registrantData = await page.evaluate(() => {
              const data = {};
              
              // Get all text content from the page
              const allText = document.body.innerText || document.body.textContent || '';
              
              // Try multiple patterns to find registrant section
              let sectionText = allText;
              const registrantSectionPatterns = [
                /Registrant\s+Contact[:\s]*([\s\S]*?)(?=Admin|Tech|Name Server|Registrar|Domain Status|$)/i,
                /REGISTRANT\s+CONTACT[:\s]*([\s\S]*?)(?=ADMIN|TECH|NAME SERVER|REGISTRAR|DOMAIN STATUS|$)/i,
                /Registrant[:\s]*([\s\S]*?)(?=Admin|Tech|Name Server|Registrar|Domain Status|$)/i
              ];
              
              for (const pattern of registrantSectionPatterns) {
                const match = allText.match(pattern);
                if (match && match[1] && match[1].trim().length > 10) {
                  sectionText = match[1];
                  break;
                }
              }
              
              // If no clear section found, try to find by looking for field patterns
              if (sectionText === allText || sectionText.length < 20) {
                // Split into lines and find registrant section
                const lines = allText.split('\n');
                let startIdx = -1;
                let endIdx = lines.length;
                
                for (let i = 0; i < lines.length; i++) {
                  const line = lines[i].toLowerCase().trim();
                  if ((line.includes('registrant') && (line.includes('contact') || line.includes('name') || line.includes('email'))) ||
                      (line === 'registrant contact:' || line === 'registrant:')) {
                    startIdx = i;
                    break;
                  }
                }
                
                if (startIdx >= 0) {
                  // Find end of registrant section
                  for (let i = startIdx + 1; i < lines.length; i++) {
                    const line = lines[i].toLowerCase().trim();
                    if ((line.includes('admin') || line.includes('tech') || line.includes('name server') || 
                         line.includes('domain status') || line.includes('registrar')) && i > startIdx + 3) {
                      endIdx = i;
                      break;
                    }
                  }
                  sectionText = lines.slice(startIdx, endIdx).join('\n');
                }
              }
              
              // Parse registrant name - try multiple patterns, but exclude domain names
              const namePatterns = [
                /name[:\s\.]+([^\n]+?)(?=\s+Organization|\s+Phone|\s+Email|\s+Mailing|$)/i,
                /registrant\s+name[:\s\.]+([^\n]+)/i,
                /owner\s+name[:\s\.]+([^\n]+)/i,
                /contact\s+name[:\s\.]+([^\n]+)/i
              ];
              
              for (const pattern of namePatterns) {
                const nameMatch = sectionText.match(pattern);
                if (nameMatch) {
                  let name = nameMatch[1].trim();
                  // Clean up name - remove extra whitespace, dots, etc.
                  name = name.replace(/^[:\s\.]+|[:\s\.]+$/g, '').trim();
                  // Exclude if it looks like a domain name, email, or privacy service
                  if (name && name.length > 0 && 
                      !name.match(/^[a-z0-9.-]+\.[a-z]{2,}$/i) && // Not a domain
                      !name.includes('@') && // Not an email
                      !name.toLowerCase().includes('privacy') && 
                      !name.toLowerCase().includes('proxy') && 
                      !name.toLowerCase().includes('domains by proxy') &&
                      name.length < 100 && // Reasonable length
                      name.length > 2) { // At least 3 characters
                    data.name = name;
                    break;
                  }
                }
              }
              
              // If no name found with patterns, try to find it by position (usually first field after "Registrant Contact")
              if (!data.name) {
                const lines = sectionText.split('\n');
                for (let i = 0; i < Math.min(10, lines.length); i++) {
                  const line = lines[i].trim();
                  // Look for lines that might be the name (not email, phone, organization)
                  if (line && !line.match(/@/) && !line.match(/tel:|phone|email|organization|org|mailing|address|country|city|state|zip/i) &&
                      line.length > 2 && line.length < 100 && !line.match(/^[a-z0-9.-]+\.[a-z]{2,}$/i)) {
                    // Check if previous line mentions "name" or "registrant"
                    if (i > 0 && (lines[i-1].toLowerCase().includes('name') || lines[i-1].toLowerCase().includes('registrant'))) {
                      data.name = line.replace(/^[:\s\.]+/, '').trim();
                      break;
                    }
                  }
                }
              }
              
              // Parse email - look for email addresses in registrant section
              // First, try to find all email addresses in the section
              const emailRegex = /([a-zA-Z0-9._%+-]+@[a-zA-Z0-9.-]+\.[a-zA-Z]{2,})/g;
              const emailMatches = sectionText.match(emailRegex);
              
              if (emailMatches && emailMatches.length > 0) {
                // Filter out privacy/proxy emails
                for (const email of emailMatches) {
                  if (!email.toLowerCase().includes('privacy') && 
                      !email.toLowerCase().includes('proxy') && 
                      !email.toLowerCase().includes('domainsbyproxy') &&
                      !email.toLowerCase().includes('whois') &&
                      !email.toLowerCase().includes('abuse') &&
                      !email.toLowerCase().includes('registrar')) {
                    data.email = email.trim();
                    break;
                  }
                }
              }
              
              // If still no email, try patterns with various formats
              if (!data.email) {
                const emailPatterns = [
                  /email[:\s\.]+([a-zA-Z0-9._%+-]+@[a-zA-Z0-9.-]+\.[a-zA-Z]{2,})/i,
                  /registrant\s+email[:\s\.]+([a-zA-Z0-9._%+-]+@[a-zA-Z0-9.-]+\.[a-zA-Z]{2,})/i,
                  /e-mail[:\s\.]+([a-zA-Z0-9._%+-]+@[a-zA-Z0-9.-]+\.[a-zA-Z]{2,})/i
                ];
                
                for (const pattern of emailPatterns) {
                  const emailMatch = sectionText.match(pattern);
                  if (emailMatch) {
                    const email = emailMatch[1].trim();
                    if (email && !email.toLowerCase().includes('privacy') && !email.toLowerCase().includes('proxy') && !email.toLowerCase().includes('domainsbyproxy')) {
                      data.email = email;
                      break;
                    }
                  }
                }
              }
              
              // Last resort: search entire page text for email if section didn't have it
              if (!data.email) {
                const allEmailMatches = allText.match(emailRegex);
                if (allEmailMatches && allEmailMatches.length > 0) {
                  for (const email of allEmailMatches) {
                    if (!email.toLowerCase().includes('privacy') && 
                        !email.toLowerCase().includes('proxy') && 
                        !email.toLowerCase().includes('domainsbyproxy') &&
                        !email.toLowerCase().includes('whois') &&
                        !email.toLowerCase().includes('abuse') &&
                        !email.toLowerCase().includes('registrar') &&
                        email.toLowerCase().includes('@')) {
                      data.email = email.trim();
                      break;
                    }
                  }
                }
              }
              
              // Parse phone - look for phone numbers (including tel: prefix)
              const phonePatterns = [
                /phone[:\s\.]+([+\d\s\-().:]+)/i,
                /registrant\s+phone[:\s\.]+([+\d\s\-().:]+)/i,
                /tel[:\s\.]+([+\d\s\-().:]+)/i,
                /telephone[:\s\.]+([+\d\s\-().:]+)/i
              ];
              
              for (const pattern of phonePatterns) {
                const phoneMatch = sectionText.match(pattern);
                if (phoneMatch) {
                  let phone = phoneMatch[1].trim();
                  phone = phone.replace(/^[:\s\.]+/, '').trim();
                  // Ensure tel: prefix if not present
                  if (phone && phone.length > 0 && phone.match(/\d/)) {
                    if (!phone.toLowerCase().startsWith('tel:')) {
                      phone = 'tel:' + phone.replace(/^tel:?\s*/i, '');
                    }
                    data.phone = phone;
                    break;
                  }
                }
              }
              
              // Also try to find phone without explicit "phone" label
              if (!data.phone) {
                const telMatch = sectionText.match(/(tel:[+\d\s\-().]+)/i);
                if (telMatch) {
                  data.phone = telMatch[1].trim();
                }
              }
              
              // Parse organization
              const orgPatterns = [
                /organization[:\s\.]+([^\n]+?)(?=\s+Phone|\s+Email|\s+Mailing|$)/i,
                /registrant\s+organization[:\s\.]+([^\n]+)/i,
                /org[:\s\.]+([^\n]+)/i,
                /company[:\s\.]+([^\n]+)/i
              ];
              
              for (const pattern of orgPatterns) {
                const orgMatch = sectionText.match(pattern);
                if (orgMatch) {
                  let org = orgMatch[1].trim();
                  org = org.replace(/^[:\s\.]+|[:\s\.]+$/g, '').trim();
                  if (org && org.length > 0 && 
                      !org.toLowerCase().includes('privacy') && 
                      !org.toLowerCase().includes('proxy') && 
                      !org.toLowerCase().includes('domains by proxy') &&
                      org.length < 200) {
                    data.organization = org;
                    break;
                  }
                }
              }
              
              // Parse mailing address - look for address, city, state, zip, country
              const addressPatterns = [
                /mailing\s+address[:\s\.]+([^\n]+)/i,
                /address[:\s\.]+([^\n]+)/i
              ];
              
              for (const pattern of addressPatterns) {
                const addrMatch = sectionText.match(pattern);
                if (addrMatch) {
                  let addr = addrMatch[1].trim();
                  addr = addr.replace(/^[:\s\.]+/, '').trim();
                  if (addr && addr.length > 0) {
                    data.address = addr;
                    break;
                  }
                }
              }
              
              // Parse city
              const cityMatch = sectionText.match(/city[:\s\.]+([^\n]+)/i);
              if (cityMatch) {
                data.city = cityMatch[1].trim().replace(/^[:\s\.]+/, '');
              }
              
              // Parse state
              const stateMatch = sectionText.match(/state[:\s\.]+([^\n]+)/i);
              if (stateMatch) {
                data.state = stateMatch[1].trim().replace(/^[:\s\.]+/, '');
              }
              
              // Parse zip/postal code
              const zipMatch = sectionText.match(/(?:zip|postal\s+code)[:\s\.]+([^\n]+)/i);
              if (zipMatch) {
                data.zip = zipMatch[1].trim().replace(/^[:\s\.]+/, '');
              }
              
              // Parse country
              const countryPatterns = [
                /country[:\s\.]+([A-Z]{2})/i,
                /registrant\s+country[:\s\.]+([A-Z]{2})/i
              ];
              
              for (const pattern of countryPatterns) {
                const countryMatch = sectionText.match(pattern);
                if (countryMatch) {
                  data.country = countryMatch[1].trim();
                  break;
                }
              }
              
              // Build full mailing address if we have components
              if (!data.address && (data.city || data.state || data.zip || data.country)) {
                const addrParts = [];
                if (data.city) addrParts.push(data.city);
                if (data.state) addrParts.push(data.state);
                if (data.zip) addrParts.push(data.zip);
                if (data.country) addrParts.push(data.country);
                if (addrParts.length > 0) {
                  data.address = addrParts.join(', ');
                }
              }
              
              return data;
            });
            
            // Update parsed data with scraped information - ONLY registrant fields
            // DO NOT overwrite registrar, dates, or name servers that were already parsed from standard WHOIS
            if (registrantData.name && !whoisData.parsed.registrantName) {
              whoisData.parsed.registrantName = registrantData.name;
            }
            if (registrantData.email && !whoisData.parsed.registrantEmail) {
              whoisData.parsed.registrantEmail = registrantData.email;
            }
            if (registrantData.phone && !whoisData.parsed.registrantPhone) {
              whoisData.parsed.registrantPhone = registrantData.phone;
            }
            if (registrantData.organization && !whoisData.parsed.registrantOrganization) {
              whoisData.parsed.registrantOrganization = registrantData.organization;
            }
            if (registrantData.address && !whoisData.parsed.registrantAddress) {
              whoisData.parsed.registrantAddress = registrantData.address;
            }
            if (registrantData.city && !whoisData.parsed.registrantCity) {
              whoisData.parsed.registrantCity = registrantData.city;
            }
            if (registrantData.state && !whoisData.parsed.registrantState) {
              whoisData.parsed.registrantState = registrantData.state;
            }
            if (registrantData.zip && !whoisData.parsed.registrantZip) {
              whoisData.parsed.registrantZip = registrantData.zip;
            }
            if (registrantData.country && !whoisData.parsed.registrantCountry) {
              whoisData.parsed.registrantCountry = registrantData.country;
            }
            
            // Restore original registrar/dates/name servers if they were overwritten
            if (originalRegistrarName && !whoisData.parsed.registrarName) {
              whoisData.parsed.registrarName = originalRegistrarName;
              whoisData.parsed.registrar = originalRegistrarName;
            }
            if (originalRegistrarUrl && !whoisData.parsed.registrarUrl) {
              whoisData.parsed.registrarUrl = originalRegistrarUrl;
            }
            if (originalCreationDate && !whoisData.parsed.creationDate) {
              whoisData.parsed.creationDate = originalCreationDate;
            }
            if (originalExpiryDate && !whoisData.parsed.expiryDate) {
              whoisData.parsed.expiryDate = originalExpiryDate;
            }
            if (originalUpdatedDate && !whoisData.parsed.updatedDate) {
              whoisData.parsed.updatedDate = originalUpdatedDate;
            }
            if (originalNameServers.length > 0 && (!whoisData.parsed.nameServers || whoisData.parsed.nameServers.length === 0)) {
              whoisData.parsed.nameServers = originalNameServers;
            }
            
            await browser.close();
          } catch (scrapeError) {
            console.error('GoDaddy WHOIS Puppeteer scrape error:', scrapeError.message);
            if (browser) {
              try {
                await browser.close();
              } catch (e) {}
            }
            // Continue to next API
          }
        }
        
        // 3. Try whoisxmlapi.com for comprehensive global coverage (requires valid API key)
        // Try this API if we're missing critical data OR if DNS resolved (domain exists)
        const needsMoreData = !whoisData.parsed.registrantName || 
                             !whoisData.parsed.registrantEmail ||
                             !whoisData.parsed.registrarName ||
                             !whoisData.parsed.creationDate ||
                             dnsResolved;
        
        if (needsMoreData) {
          try {
            const whoisApiKey = process.env.WHOISXMLAPI_API_KEY || 'YOUR_WHOISXMLAPI_API_KEY';
            const whoisApiUrl = `https://www.whoisxmlapi.com/whoisserver/WhoisService?apiKey=${whoisApiKey}&domainName=${trimmedDomain}&outputFormat=JSON`;
            const apiResponse = await axios.get(whoisApiUrl, { timeout: 5000 });
            if (apiResponse.data && apiResponse.data.WhoisRecord) {
              const record = apiResponse.data.WhoisRecord;
              // Only update if we don't already have the data
              if (record.registrarName && !whoisData.parsed.registrarName) {
                whoisData.parsed.registrarName = record.registrarName;
                whoisData.parsed.registrar = record.registrarName;
              }
              if (record.registrarURL && !whoisData.parsed.registrarUrl) {
                whoisData.parsed.registrarUrl = record.registrarURL;
              }
              // ALWAYS update dates from whoisxmlapi - they have comprehensive data
              // Prefer API dates over WHOIS dates (more accurate)
              if (record.createdDate) {
                whoisData.parsed.creationDate = record.createdDate;
              }
              if (record.expiresDate) {
                whoisData.parsed.expiryDate = record.expiresDate;
              }
              if (record.updatedDate) {
                whoisData.parsed.updatedDate = record.updatedDate;
              }
              
              // Update name servers if missing
              if (record.nameServers && record.nameServers.hostNames && Array.isArray(record.nameServers.hostNames)) {
                if (!whoisData.parsed.nameServers || whoisData.parsed.nameServers.length === 0) {
                  whoisData.parsed.nameServers = record.nameServers.hostNames;
                }
              } else if (record.nameServers && Array.isArray(record.nameServers) && (!whoisData.parsed.nameServers || whoisData.parsed.nameServers.length === 0)) {
                whoisData.parsed.nameServers = record.nameServers.map(ns => ns.hostName || ns);
              }
              
              // Filter REDACTED values from registrant info BEFORE storing
              
              if (record.registrant) {
                if (record.registrant.name && !whoisData.parsed.registrantName && !isRedactedValue(record.registrant.name)) {
                  whoisData.parsed.registrantName = record.registrant.name;
                }
                if (record.registrant.email && !whoisData.parsed.registrantEmail && !isRedactedValue(record.registrant.email)) {
                  whoisData.parsed.registrantEmail = record.registrant.email;
                }
                if (record.registrant.telephone && !whoisData.parsed.registrantPhone && !isRedactedValue(record.registrant.telephone)) {
                  whoisData.parsed.registrantPhone = record.registrant.telephone;
                }
                if (record.registrant.fax && !whoisData.parsed.registrantFax && !isRedactedValue(record.registrant.fax)) {
                  whoisData.parsed.registrantFax = record.registrant.fax;
                }
                if (record.registrant.organization && !whoisData.parsed.registrantOrganization && !isRedactedValue(record.registrant.organization)) {
                  whoisData.parsed.registrantOrganization = record.registrant.organization;
                }
                if (record.registrant.street1 && !whoisData.parsed.registrantAddress) {
                  whoisData.parsed.registrantAddress = record.registrant.street1;
                }
                if (record.registrant.city && !whoisData.parsed.registrantCity) {
                  whoisData.parsed.registrantCity = record.registrant.city;
                }
                if (record.registrant.state && !whoisData.parsed.registrantState) {
                  whoisData.parsed.registrantState = record.registrant.state;
                }
                if (record.registrant.postalCode && !whoisData.parsed.registrantZip) {
                  whoisData.parsed.registrantZip = record.registrant.postalCode;
                }
                if (record.registrant.country && !whoisData.parsed.registrantCountry) {
                  whoisData.parsed.registrantCountry = record.registrant.country;
                }
              }
              if (record.nameServers && record.nameServers.hostNames) {
                whoisData.parsed.nameServers = Array.isArray(record.nameServers.hostNames) 
                  ? record.nameServers.hostNames 
                  : [record.nameServers.hostNames];
              }
              
              const registryData = record.registryData || {};
              const auditData = record.audit || {};
              const pickDateValue = (...candidates) => {
                for (const candidate of candidates) {
                  if (candidate && typeof candidate === 'string') {
                    const trimmed = candidate.trim();
                    if (trimmed && !isPrivacyPolicyText(trimmed) && !isRedactedValue(trimmed)) {
                      return trimmed;
                    }
                  }
                }
                return null;
              };
              
              const creationValue = pickDateValue(
                record.createdDate,
                record.createdDateNormalized,
                registryData.createdDate,
                registryData.createdDateNormalized,
                auditData.createdDate,
                auditData.createdDateNormalized
              );
              if (creationValue) {
                whoisData.parsed.creationDate = creationValue;
              }
              
              const expiryValue = pickDateValue(
                record.expiresDate,
                record.expiresDateNormalized,
                registryData.expiresDate,
                registryData.expiresDateNormalized,
                auditData.expiresDate,
                auditData.expiresDateNormalized
              );
              if (expiryValue) {
                whoisData.parsed.expiryDate = expiryValue;
              }
              
              const updatedValue = pickDateValue(
                record.updatedDate,
                record.updatedDateNormalized,
                registryData.updatedDate,
                registryData.updatedDateNormalized,
                auditData.updatedDate,
                auditData.updatedDateNormalized
              );
              if (updatedValue) {
                whoisData.parsed.updatedDate = updatedValue;
              }
              
              if (registryData.nameServers) {
                const registryNameServers = Array.isArray(registryData.nameServers.hostNames)
                  ? registryData.nameServers.hostNames
                  : Array.isArray(registryData.nameServers)
                    ? registryData.nameServers.map(ns => ns.hostName || ns)
                    : typeof registryData.nameServers === 'string'
                      ? registryData.nameServers.split(/\s+/).filter(Boolean)
                      : [];
                if (registryNameServers.length > 0) {
                  whoisData.parsed.nameServers = registryNameServers;
                }
              }
              
              if (registryData.registrant) {
                const registrant = registryData.registrant;
                if (registrant.name && !whoisData.parsed.registrantName && !isRedactedValue(registrant.name)) {
                  whoisData.parsed.registrantName = registrant.name;
                }
                if (registrant.email && !whoisData.parsed.registrantEmail && !isRedactedValue(registrant.email)) {
                  whoisData.parsed.registrantEmail = registrant.email;
                }
                if (registrant.telephone && !whoisData.parsed.registrantPhone && !isRedactedValue(registrant.telephone)) {
                  whoisData.parsed.registrantPhone = registrant.telephone;
                }
                if (registrant.fax && !whoisData.parsed.registrantFax && !isRedactedValue(registrant.fax)) {
                  whoisData.parsed.registrantFax = registrant.fax;
                }
                if (registrant.organization && !whoisData.parsed.registrantOrganization && !isRedactedValue(registrant.organization)) {
                  whoisData.parsed.registrantOrganization = registrant.organization;
                }
                if (registrant.street1 && !whoisData.parsed.registrantAddress && !isRedactedValue(registrant.street1)) {
                  whoisData.parsed.registrantAddress = registrant.street1;
                }
                if (registrant.city && !whoisData.parsed.registrantCity && !isRedactedValue(registrant.city)) {
                  whoisData.parsed.registrantCity = registrant.city;
                }
                if (registrant.state && !whoisData.parsed.registrantState && !isRedactedValue(registrant.state)) {
                  whoisData.parsed.registrantState = registrant.state;
                }
                if (registrant.postalCode && !whoisData.parsed.registrantZip && !isRedactedValue(registrant.postalCode)) {
                  whoisData.parsed.registrantZip = registrant.postalCode;
                }
                if (registrant.country && !whoisData.parsed.registrantCountry && !isRedactedValue(registrant.country)) {
                  whoisData.parsed.registrantCountry = registrant.country;
                }
              }
              whoisData.parsed.isRegistered = true;
              rawWhois = JSON.stringify(apiResponse.data, null, 2);
            }
          } catch (apiError) {
            console.error('Alternative WHOIS API error:', apiError.message);
            // Fall back to DNS lookup
          }
        }
      } catch (e) {
        console.error('WHOIS API fallback error:', e.message);
        // Ignore API errors, continue with DNS fallback
      }
    }
    
    const needsRdapData =
      !whoisData.parsed.creationDate ||
      !whoisData.parsed.expiryDate ||
      !whoisData.parsed.updatedDate ||
      !whoisData.parsed.nameServers ||
      whoisData.parsed.nameServers.length === 0 ||
      trimmedDomain.endsWith('.services') ||
      trimmedDomain.endsWith('.live');
    
    if (needsRdapData) {
      try {
        const rdapData = await fetchRdapData(trimmedDomain);
        if (rdapData) {
          const events = Array.isArray(rdapData.events) ? rdapData.events : [];
          const pickEventDate = (...actions) => {
            for (const action of actions) {
              const evt = events.find(
                (e) =>
                  e.eventAction &&
                  e.eventAction.toLowerCase() === action.toLowerCase() &&
                  e.eventDate
              );
              if (evt && evt.eventDate) {
                return evt.eventDate;
              }
            }
            return null;
          };
          
          const rdapCreation = pickEventDate('registration', 'domain registration', 'created');
          const rdapExpiry = pickEventDate('expiration', 'expiry', 'domain expiration', 'expiration date');
          const rdapUpdated = pickEventDate('last changed', 'last update', 'last updated', 'modified');
          
          if (
            rdapCreation &&
            (!whoisData.parsed.creationDate || isPrivacyPolicyText(whoisData.parsed.creationDate))
          ) {
            whoisData.parsed.creationDate = rdapCreation;
          }
          if (
            rdapExpiry &&
            (!whoisData.parsed.expiryDate || isPrivacyPolicyText(whoisData.parsed.expiryDate))
          ) {
            whoisData.parsed.expiryDate = rdapExpiry;
          }
          if (
            rdapUpdated &&
            (!whoisData.parsed.updatedDate || isPrivacyPolicyText(whoisData.parsed.updatedDate))
          ) {
            whoisData.parsed.updatedDate = rdapUpdated;
          }
          
          if (
            rdapData.nameservers &&
            Array.isArray(rdapData.nameservers) &&
            rdapData.nameservers.length > 0
          ) {
            const rdapNameServers = rdapData.nameservers
              .map((ns) => {
                if (!ns) return null;
                if (typeof ns === 'string') return ns;
                if (ns.ldhName) return ns.ldhName;
                if (ns.unicodeName) return ns.unicodeName;
                return null;
              })
              .filter(Boolean);
            
            if (rdapNameServers.length > 0) {
              whoisData.parsed.nameServers = rdapNameServers;
            }
          }
        }
      } catch (rdapError) {
        console.error('WHOIS RDAP enrichment error:', rdapError.message);
      }
    }
    
    // DNS lookup as final confirmation - Check for ANY registration indicators (including from Puppeteer and APIs)
    // If DNS already resolved, we already confirmed registration
    // Otherwise, do a final DNS check if needed
    if (!dnsResolved) {
      try {
        const dns = require('dns').promises;
        try {
          await dns.resolve4(trimmedDomain);
          dnsResolved = true;
          whoisData.parsed.isRegistered = true;
          
          // Try to get more info from DNS
          if (!whoisData.parsed.nameServers || whoisData.parsed.nameServers.length === 0) {
            try {
              const nsRecords = await dns.resolveNs(trimmedDomain);
              whoisData.parsed.nameServers = nsRecords;
            } catch (e) {
              // Ignore NS lookup errors
            }
          }
        } catch (dnsError) {
          // IPv4 failed, try IPv6
          try {
            await dns.resolve6(trimmedDomain);
            dnsResolved = true;
            whoisData.parsed.isRegistered = true;
          } catch (dns6Error) {
            // Both IPv4 and IPv6 failed
            dnsResolved = false;
          }
        }
      } catch (dnsErr) {
        dnsResolved = false;
      }
    }
    
    // Restore original registrar/dates/name servers if they were lost during API calls
    // BUT NEVER restore privacy policy text - only restore valid registrar data
    if (originalRegistrarName && !whoisData.parsed.registrarName && !isPrivacyPolicyText(originalRegistrarName)) {
      whoisData.parsed.registrarName = originalRegistrarName;
      whoisData.parsed.registrar = originalRegistrarName;
    }
    if (originalRegistrarUrl && !whoisData.parsed.registrarUrl && !isPrivacyPolicyText(originalRegistrarUrl)) {
      whoisData.parsed.registrarUrl = originalRegistrarUrl;
    }
    
    // FINAL cleanup: Remove any privacy policy text that might have slipped through at any point
    if (whoisData.parsed.registrarName && isPrivacyPolicyText(whoisData.parsed.registrarName)) {
      whoisData.parsed.registrarName = null;
      whoisData.parsed.registrar = null;
    }
    if (whoisData.parsed.registrarUrl && isPrivacyPolicyText(whoisData.parsed.registrarUrl)) {
      whoisData.parsed.registrarUrl = null;
    }
    if (whoisData.parsed.registrarEmail && isPrivacyPolicyText(whoisData.parsed.registrarEmail)) {
      whoisData.parsed.registrarEmail = null;
    }
    if (originalCreationDate && !whoisData.parsed.creationDate) {
      whoisData.parsed.creationDate = originalCreationDate;
    }
    if (originalExpiryDate && !whoisData.parsed.expiryDate) {
      whoisData.parsed.expiryDate = originalExpiryDate;
    }
    if (originalUpdatedDate && !whoisData.parsed.updatedDate) {
      whoisData.parsed.updatedDate = originalUpdatedDate;
    }
    if (originalNameServers.length > 0 && (!whoisData.parsed.nameServers || whoisData.parsed.nameServers.length === 0)) {
      whoisData.parsed.nameServers = originalNameServers;
    }
    
    // CRITICAL: Determine registration status based on ALL available data
    // Check for ANY registration indicators
    const finalHasRegistrationIndicators = whoisData.parsed.registrarName || whoisData.parsed.registrarUrl ||
                                           whoisData.parsed.creationDate || whoisData.parsed.expiryDate ||
                                           (whoisData.parsed.nameServers && whoisData.parsed.nameServers.length > 0) ||
                                           whoisData.parsed.registrantName || whoisData.parsed.registrantEmail ||
                                           originalRegistrarName || originalRegistrarUrl ||
                                           originalCreationDate || originalExpiryDate ||
                                           originalNameServers.length > 0;
    
    const whoisText = rawWhois ? rawWhois.toLowerCase() : '';
    const whoisIndicatesRegistered =
      (whoisText.includes('domain name:') ||
        whoisText.includes('registrar:') ||
        whoisText.includes('creation date:') ||
        whoisText.includes('updated date:') ||
        whoisText.includes('expiry date:') ||
        whoisText.includes('expiration date:') ||
        whoisText.includes('name server') ||
        (whoisText.includes('domain status:') &&
          !whoisText.includes('domain status: available'))) &&
      !whoisText.includes('tld is not supported');
    const whoisIndicatesAvailable =
      whoisText.includes('no match') ||
      whoisText.includes('not found') ||
      whoisText.includes('no entries found') ||
      whoisText.includes('status: available') ||
      whoisText.includes('domain status: available') ||
      whoisText.includes('tld is not supported');
    
    const determineRegistrationStatus = () => {
      if (dnsResolved) return true;
      if (finalHasRegistrationIndicators || whoisIndicatesRegistered) return true;
      if (whoisIndicatesAvailable) return false;
      if (!tldNotSupported && !hasWhoisError) {
        return false;
      }
      if (originalIsRegistered !== undefined && originalIsRegistered !== null) {
        return originalIsRegistered;
      }
      return false;
    };
    
    whoisData.parsed.isRegistered = determineRegistrationStatus();
    
    // Final cleanup: Remove any REDACTED or privacy-protected values before sending
    const finalCleanup = (obj) => {
      if (!obj) return;
      
      // Clean ALL string fields
      Object.keys(obj).forEach(key => {
        if (typeof obj[key] === 'string') {
          if (isRedactedValue(obj[key]) || isPrivacyPolicyText(obj[key])) {
            obj[key] = null;
          }
        }
      });
      
      const sanitizeFields = (fields) => {
        fields.forEach(field => {
          if (obj[field] && typeof obj[field] === 'string') {
            if (isRedactedValue(obj[field]) || isPrivacyPolicyText(obj[field])) {
              obj[field] = null;
            }
          }
        });
      };
      
      const registrantFields = ['registrantName', 'registrantEmail', 'registrantPhone', 'registrantOrganization', 
                                'registrantFax', 'registrantAddress', 'registrantCity', 'registrantState', 
                                'registrantZip', 'registrantCountry'];
      const adminFields = ['adminName', 'adminEmail', 'adminPhone', 'adminOrganization',
                           'adminFax', 'adminAddress', 'adminCity', 'adminState',
                           'adminZip', 'adminCountry'];
      const techFields = ['techName', 'techEmail', 'techPhone', 'techOrganization',
                          'techFax', 'techAddress', 'techCity', 'techState',
                          'techZip', 'techCountry'];
      
      sanitizeFields(registrantFields);
      sanitizeFields(adminFields);
      sanitizeFields(techFields);
    };
    finalCleanup(whoisData.parsed);
    
    // Always return data, even if whois command had issues
      res.json({
        domain: trimmedDomain,
        whois: whoisData.parsed,
        raw: rawWhois,
        timestamp: new Date().toISOString()
      });

    } catch (error) {
    console.error('WHOIS lookup endpoint error:', error);
    // Always return 200 OK with available data, even on errors
    try {
      const dns = require('dns').promises;
      let isRegistered = false;
      let nameServers = [];
      
      try {
        await dns.resolve4(trimmedDomain);
        isRegistered = true;
        try {
          nameServers = await dns.resolveNs(trimmedDomain);
        } catch (e) {
          // Ignore NS lookup errors
        }
      } catch (dnsError) {
        // Domain doesn't resolve
      }
      
      return res.status(200).json({
        domain: trimmedDomain,
        whois: {
          isRegistered: isRegistered,
          nameServers: nameServers,
          registrar: null,
          registrarName: null,
          registrarUrl: null,
          creationDate: null,
          expiryDate: null,
          updatedDate: null,
          status: [],
          registrantName: null,
          registrantEmail: null,
          registrantPhone: null,
          registrantFax: null,
          registrantOrganization: null,
          registrantAddress: null,
          registrantCity: null,
          registrantState: null,
          registrantZip: null,
          registrantCountry: null
        },
        raw: error.message || 'WHOIS lookup failed',
        timestamp: new Date().toISOString()
      });
    } catch (fallbackError) {
      return res.status(200).json({
        domain: trimmedDomain,
        whois: {
          isRegistered: false,
          nameServers: [],
          registrar: null,
          registrarName: null,
          registrarUrl: null
        },
        raw: error.message || 'WHOIS lookup failed',
        timestamp: new Date().toISOString()
      });
    }
  }
});

/**
 * Parse raw WHOIS text into structured data
 */
function parseWhoisData(rawText, domain) {
  const lines = rawText.split('\n');
  const parsed = {
    isRegistered: undefined,
    registrar: null,
    registrarName: null,
    registrarUrl: null,
    registrarEmail: null,
    registrarPhone: null,
    creationDate: null,
    expiryDate: null,
    updatedDate: null,
    nameServers: [],
    status: [],
    registrantName: null,
    registrantEmail: null,
    registrantPhone: null,
    registrantFax: null,
    registrantOrganization: null,
    registrantAddress: null,
    registrantCity: null,
    registrantState: null,
    registrantZip: null,
    registrantCountry: null
  };

  let inRegistrantSection = false;
  let inAdminSection = false;
  let inTechSection = false;

  for (const line of lines) {
    const trimmedLine = line.trim();
    if (!trimmedLine || trimmedLine.startsWith('%') || trimmedLine.startsWith('#')) {
      continue;
    }

    const lowerLine = trimmedLine.toLowerCase();
    const colonIndex = trimmedLine.indexOf(':');
    
    if (colonIndex === -1) continue;

    const key = trimmedLine.substring(0, colonIndex).trim().toLowerCase();
    const value = trimmedLine.substring(colonIndex + 1).trim();

    // Helper function to check if value is privacy policy text or REDACTED (not real data)
    const isPrivacyPolicyText = (val) => {
      if (!val || typeof val !== 'string') return false;
      const lowerVal = val.toLowerCase().trim();
      
      // Check for REDACTED (exact match or in context)
      if (lowerVal === 'redacted' || lowerVal === '[redacted]' || lowerVal === '(redacted)') {
        return true;
      }
      
      // Check for privacy policy text
      if (lowerVal.length < 10) return false;
      return lowerVal.includes('access to non-public data') ||
             lowerVal.includes('layered access') ||
             lowerVal.includes('identity digital inc.') ||
             lowerVal.includes('upon request') ||
             lowerVal.includes('legitimate interest') ||
             lowerVal.includes('legal basis') ||
             lowerVal.includes('withheld data') ||
             lowerVal.includes('url listed above') ||
             lowerVal.includes('reserve the right to modify') ||
             lowerVal.includes('by submitting this query') ||
             lowerVal.includes('withheld for privacy') ||
             lowerVal.includes('privacy service provided') ||
             lowerVal.length > 200; // Very long values are likely privacy policy text
    };
    
    // Registrar information - handle multiple formats
    if (key.includes('registrar') && !key.includes('registrant')) {
      if (key.includes('name') || key === 'registrar' || key === 'sponsoring registrar') {
        if (!parsed.registrarName && !isPrivacyPolicyText(value)) {
        parsed.registrar = value;
        parsed.registrarName = value;
        }
      } else if (key.includes('url') || key.includes('website') || key.includes('whois')) {
        if (!parsed.registrarUrl && !isPrivacyPolicyText(value)) {
          // Only accept valid URLs
          if (value.startsWith('http') || value.includes('.') && !value.includes('Access to non-public')) {
        parsed.registrarUrl = value;
          }
        }
      } else if (key.includes('email')) {
        if (!parsed.registrarEmail && !isPrivacyPolicyText(value)) {
        parsed.registrarEmail = value;
        }
      } else if (key.includes('phone')) {
        if (!parsed.registrarPhone && !isPrivacyPolicyText(value)) {
        parsed.registrarPhone = value;
        }
      }
    }
    
    // Also check for registrar info without explicit "registrar" in key (some formats)
    if ((key === 'name' || key === 'organization') && !inRegistrantSection && !inAdminSection && !inTechSection) {
      // Check if this might be registrar name by looking at context
      if (lowerLine.includes('registrar') && !parsed.registrarName && !isPrivacyPolicyText(value)) {
        parsed.registrarName = value;
        parsed.registrar = value;
      }
    }

    // Dates
    if (key.includes('creation date') || key.includes('created')) {
      parsed.creationDate = value;
    }
    if (key.includes('expiry date') || key.includes('expiration') || key.includes('expires')) {
      parsed.expiryDate = value;
    }
    if (key.includes('updated date') || key.includes('last updated') || key.includes('modified')) {
      parsed.updatedDate = value;
    }

    // Name servers
    if (key.includes('name server') || key === 'nserver' || key === 'nameserver') {
      const nsValue = value.toLowerCase().trim();
      if (nsValue && !parsed.nameServers.includes(nsValue)) {
        parsed.nameServers.push(nsValue);
      }
    }

    // Domain status
    if (key.includes('status') || key.includes('domain status')) {
      if (value && !parsed.status.includes(value)) {
        parsed.status.push(value);
      }
    }

    // Section detection
    if (lowerLine.includes('registrant contact') || lowerLine === 'registrant:') {
      inRegistrantSection = true;
      inAdminSection = false;
      inTechSection = false;
    } else if (lowerLine.includes('admin contact') || lowerLine === 'admin:') {
      inRegistrantSection = false;
      inAdminSection = true;
      inTechSection = false;
    } else if (lowerLine.includes('tech contact') || lowerLine === 'tech:') {
      inRegistrantSection = false;
      inAdminSection = false;
      inTechSection = true;
    }

    // Registrant information - check in section or search globally if no section found
    // FILTER OUT REDACTED VALUES - don't store them
    if (inRegistrantSection && !inAdminSection && !inTechSection) {
      if (key.includes('name') && !key.includes('registrar') && !key.includes('admin') && !key.includes('tech')) {
        if (!parsed.registrantName && !isPrivacyPolicyText(value)) parsed.registrantName = value;
      } else if ((key.includes('organization') || key === 'org') && !key.includes('registrar')) {
        if (!parsed.registrantOrganization && !isPrivacyPolicyText(value)) parsed.registrantOrganization = value;
      } else if (key.includes('email') && !key.includes('registrar') && !key.includes('admin') && !key.includes('tech')) {
        if (!parsed.registrantEmail && !isPrivacyPolicyText(value)) parsed.registrantEmail = value;
      } else if (key.includes('phone') && !key.includes('registrar') && !key.includes('admin') && !key.includes('tech')) {
        if (!parsed.registrantPhone && !isPrivacyPolicyText(value)) parsed.registrantPhone = value;
      } else if (key.includes('fax') && !key.includes('registrar') && !key.includes('admin') && !key.includes('tech')) {
        if (!parsed.registrantFax) parsed.registrantFax = value;
      } else if (key.includes('address') || key === 'street') {
        if (!parsed.registrantAddress) parsed.registrantAddress = value;
      } else if (key === 'city') {
        if (!parsed.registrantCity) parsed.registrantCity = value;
      } else if (key === 'state' || key === 'province') {
        if (!parsed.registrantState) parsed.registrantState = value;
      } else if (key === 'zip' || key === 'postal code' || key === 'postcode') {
        if (!parsed.registrantZip) parsed.registrantZip = value;
      } else if (key === 'country') {
        if (!parsed.registrantCountry) parsed.registrantCountry = value;
      }
    } else if (!inRegistrantSection && !inAdminSection && !inTechSection) {
      // Search globally for registrant info (many WHOIS formats don't have clear section markers)
      // FILTER OUT REDACTED VALUES
      if ((key.includes('registrant') || lowerLine.includes('registrant')) && !key.includes('registrar')) {
        if (key.includes('name') || (key === 'name' && !parsed.registrantName)) {
          if (!isPrivacyPolicyText(value)) parsed.registrantName = value;
      } else if (key.includes('organization') || key === 'org') {
          if (!isPrivacyPolicyText(value)) parsed.registrantOrganization = value;
      } else if (key.includes('email')) {
          if (!isPrivacyPolicyText(value)) parsed.registrantEmail = value;
      } else if (key.includes('phone')) {
          if (!isPrivacyPolicyText(value)) parsed.registrantPhone = value;
        } else if (key.includes('fax')) {
          parsed.registrantFax = value;
      } else if (key.includes('address') || key === 'street') {
        parsed.registrantAddress = value;
      } else if (key === 'city') {
        parsed.registrantCity = value;
      } else if (key === 'state' || key === 'province') {
        parsed.registrantState = value;
      } else if (key === 'zip' || key === 'postal code' || key === 'postcode') {
        parsed.registrantZip = value;
      } else if (key === 'country') {
        parsed.registrantCountry = value;
        }
      }
      // Also try to match common patterns like "Name: Value" when in registrant context
      // Check if previous lines mentioned registrant
      const lineIndex = lines.indexOf(line);
      const prevLines = lines.slice(Math.max(0, lineIndex - 5), lineIndex);
      const hasRegistrantContext = prevLines.some(l => l.toLowerCase().includes('registrant') && !l.toLowerCase().includes('registrar'));
      if (hasRegistrantContext) {
        if ((key === 'name' || key.includes('name')) && !parsed.registrantName && !key.includes('registrar') && !key.includes('admin') && !key.includes('tech')) {
          parsed.registrantName = value;
        } else if ((key === 'email' || key.includes('email')) && !parsed.registrantEmail && !key.includes('registrar') && !key.includes('admin') && !key.includes('tech')) {
          parsed.registrantEmail = value;
        } else if ((key === 'phone' || key.includes('phone') || key === 'tel') && !parsed.registrantPhone && !key.includes('registrar') && !key.includes('admin') && !key.includes('tech')) {
          parsed.registrantPhone = value;
        } else if ((key === 'organization' || key === 'org') && !parsed.registrantOrganization && !key.includes('registrar')) {
          parsed.registrantOrganization = value;
        }
      }
    }
  }

  // Determine if domain is registered - check multiple indicators
  const lowerRawText = rawText.toLowerCase();
  
  // Domain is NOT registered if:
  const isNotRegistered = lowerRawText.includes('no match') || 
                          lowerRawText.includes('not found') ||
                          lowerRawText.includes('domain available') ||
                          lowerRawText.includes('no entries found') ||
                          lowerRawText.includes('status: available') ||
                          lowerRawText.includes('status: free');
  
  // Check if TLD is not supported - use DNS lookup as fallback
  const tldNotSupported = lowerRawText.includes('tld is not supported');
  
  // Domain is registered if ANY of these are present:
  const hasDomainName = lowerRawText.includes('domain name:');
  const hasCreated = lowerRawText.includes('created:') || lowerRawText.includes('creation date:');
  const hasRegistrar = lowerRawText.includes('registrar:') || lowerRawText.includes('sponsoring registrar');
  const hasNameServers = lowerRawText.includes('name server:') || lowerRawText.includes('nserver:');
  const hasStatus = parsed.status.length > 0;
  
  // More aggressive check - if we have ANY indication the domain exists, mark as registered
  const hasAnyRegistrationData = parsed.registrar ||
    parsed.registrarName ||
    parsed.creationDate ||
    parsed.expiryDate ||
    parsed.nameServers.length > 0 ||
    parsed.registrantName ||
    parsed.registrantOrganization ||
    parsed.registrantEmail ||
    hasDomainName ||
    hasCreated ||
    hasRegistrar ||
    hasNameServers ||
    hasStatus;
  
  // Mark as registered if we have ANY registration data OR if it's not explicitly marked as available
  // Default to registered if we have any data at all (most WHOIS queries are for existing domains)
  parsed.isRegistered = hasAnyRegistrationData || (!isNotRegistered && !tldNotSupported);
  
  // If we have registration data but isNotRegistered is true, still mark as registered (data takes precedence)
  if (hasAnyRegistrationData) {
    parsed.isRegistered = true;
  }

  return { parsed };
}

module.exports = router;

