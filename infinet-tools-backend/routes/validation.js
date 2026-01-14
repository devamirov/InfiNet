/**
 * Validation utilities for input validation across all routes
 */

/**
 * Validates domain format
 * @param {string} domain - Domain to validate
 * @returns {{ valid: boolean, error?: string }}
 */
function validateDomain(domain) {
  if (!domain || typeof domain !== 'string') {
    return { valid: false, error: 'Domain is required and must be a string' };
  }

  const trimmed = domain.trim().toLowerCase();
  
  if (trimmed.length === 0) {
    return { valid: false, error: 'Domain cannot be empty' };
  }

  if (trimmed.length > 253) {
    return { valid: false, error: 'Domain is too long (maximum 253 characters)' };
  }

  // Domain pattern: must start with alphanumeric, can contain hyphens, must end with TLD
  const domainPattern = /^(?!-)(?:[a-zA-Z0-9-]{1,63}\.)+[a-zA-Z]{2,}$/;
  
  if (!domainPattern.test(trimmed)) {
    return { 
      valid: false, 
      error: 'Invalid domain format. Please enter a valid domain (e.g., example.com)' 
    };
  }

  // Check for consecutive dots or dots at start/end
  if (trimmed.startsWith('.') || trimmed.endsWith('.') || trimmed.includes('..')) {
    return { valid: false, error: 'Invalid domain format. Domain cannot start/end with dots or contain consecutive dots' };
  }

  return { valid: true, value: trimmed };
}

/**
 * Validates URL format
 * @param {string} url - URL to validate
 * @returns {{ valid: boolean, error?: string, value?: string }}
 */
function validateUrl(url) {
  if (!url || typeof url !== 'string') {
    return { valid: false, error: 'URL is required and must be a string' };
  }

  const trimmed = url.trim();
  
  if (trimmed.length === 0) {
    return { valid: false, error: 'URL cannot be empty' };
  }

  if (trimmed.length > 2048) {
    return { valid: false, error: 'URL is too long (maximum 2048 characters)' };
  }

  try {
    const parsed = new URL(trimmed);
    
    // Only allow http and https protocols
    if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') {
      return { 
        valid: false, 
        error: 'Invalid URL protocol. Only http:// and https:// are allowed' 
      };
    }

    // Check for valid hostname
    if (!parsed.hostname || parsed.hostname.length === 0) {
      return { valid: false, error: 'URL must include a valid hostname' };
    }

    return { valid: true, value: trimmed };
  } catch (error) {
    return { 
      valid: false, 
      error: 'Invalid URL format. Please enter a valid URL (e.g., https://example.com)' 
    };
  }
}

/**
 * Validates IP address format (IPv4 or IPv6)
 * @param {string} ip - IP address to validate
 * @returns {{ valid: boolean, error?: string, value?: string }}
 */
function validateIpAddress(ip) {
  if (!ip || typeof ip !== 'string') {
    return { valid: false, error: 'IP address is required and must be a string' };
  }

  const trimmed = ip.trim();
  
  if (trimmed.length === 0) {
    return { valid: false, error: 'IP address cannot be empty' };
  }

  // IPv4 pattern: four groups of 1-3 digits separated by dots
  const ipv4Pattern = /^(\d{1,3}\.){3}\d{1,3}$/;
  
  // IPv6 pattern: simplified check (full validation is complex)
  const ipv6Pattern = /^([0-9a-fA-F]{0,4}:){2,7}[0-9a-fA-F]{0,4}$/;
  
  if (ipv4Pattern.test(trimmed)) {
    // Validate IPv4 octets are in valid range (0-255)
    const parts = trimmed.split('.');
    const allValid = parts.every(part => {
      const num = parseInt(part, 10);
      return num >= 0 && num <= 255;
    });
    
    if (!allValid) {
      return { valid: false, error: 'Invalid IPv4 address. Each octet must be between 0 and 255' };
    }
    
    return { valid: true, value: trimmed };
  }
  
  if (ipv6Pattern.test(trimmed)) {
    return { valid: true, value: trimmed };
  }

  return { 
    valid: false, 
    error: 'Invalid IP address format. Please enter a valid IPv4 (e.g., 192.168.1.1) or IPv6 address' 
  };
}

/**
 * Validates required string field
 * @param {any} value - Value to validate
 * @param {string} fieldName - Name of the field for error messages
 * @param {object} options - Validation options
 * @returns {{ valid: boolean, error?: string, value?: string }}
 */
function validateRequiredString(value, fieldName, options = {}) {
  const { minLength = 0, maxLength = Infinity, trim = true } = options;

  if (!value || typeof value !== 'string') {
    return { valid: false, error: `${fieldName} is required and must be a string` };
  }

  const processed = trim ? value.trim() : value;
  
  if (processed.length === 0) {
    return { valid: false, error: `${fieldName} cannot be empty` };
  }

  if (processed.length < minLength) {
    return { valid: false, error: `${fieldName} must be at least ${minLength} character(s)` };
  }

  if (processed.length > maxLength) {
    return { valid: false, error: `${fieldName} must be no more than ${maxLength} characters` };
  }

  return { valid: true, value: processed };
}

/**
 * Validates slug format (alphanumeric and hyphens only)
 * @param {string} slug - Slug to validate
 * @returns {{ valid: boolean, error?: string, value?: string }}
 */
function validateSlug(slug) {
  if (!slug || typeof slug !== 'string') {
    return { valid: false, error: 'Slug is required and must be a string' };
  }

  const trimmed = slug.trim();
  
  if (trimmed.length === 0) {
    return { valid: false, error: 'Slug cannot be empty' };
  }

  if (trimmed.length > 50) {
    return { valid: false, error: 'Slug is too long (maximum 50 characters)' };
  }

  // Alphanumeric and hyphens only, no spaces
  if (!/^[a-zA-Z0-9-]+$/.test(trimmed)) {
    return { 
      valid: false, 
      error: 'Slug can only contain letters, numbers, and hyphens (no spaces or special characters)' 
    };
  }

  // Cannot start or end with hyphen
  if (trimmed.startsWith('-') || trimmed.endsWith('-')) {
    return { valid: false, error: 'Slug cannot start or end with a hyphen' };
  }

  return { valid: true, value: trimmed };
}

/**
 * Validates hex color code
 * @param {string} color - Color to validate
 * @returns {{ valid: boolean, error?: string, value?: string }}
 */
function validateHexColor(color) {
  if (!color || typeof color !== 'string') {
    return { valid: false, error: 'Color is required and must be a string' };
  }

  const trimmed = color.trim();
  
  // Remove # if present for validation
  const hex = trimmed.startsWith('#') ? trimmed.slice(1) : trimmed;
  
  if (hex.length !== 3 && hex.length !== 6) {
    return { 
      valid: false, 
      error: 'Invalid hex color format. Use 3 or 6 hex digits (e.g., #FFF or #FFFFFF)' 
    };
  }

  if (!/^[0-9a-fA-F]+$/.test(hex)) {
    return { valid: false, error: 'Color must contain only hexadecimal digits (0-9, A-F)' };
  }

  return { valid: true, value: trimmed.startsWith('#') ? trimmed : `#${trimmed}` };
}

/**
 * Validates numeric value
 * @param {any} value - Value to validate
 * @param {string} fieldName - Name of the field
 * @param {object} options - Validation options
 * @returns {{ valid: boolean, error?: string, value?: number }}
 */
function validateNumber(value, fieldName, options = {}) {
  const { min, max, integer = false } = options;

  if (value === null || value === undefined) {
    return { valid: false, error: `${fieldName} is required` };
  }

  const num = typeof value === 'string' ? parseFloat(value) : value;
  
  if (isNaN(num)) {
    return { valid: false, error: `${fieldName} must be a valid number` };
  }

  if (integer && !Number.isInteger(num)) {
    return { valid: false, error: `${fieldName} must be an integer` };
  }

  if (min !== undefined && num < min) {
    return { valid: false, error: `${fieldName} must be at least ${min}` };
  }

  if (max !== undefined && num > max) {
    return { valid: false, error: `${fieldName} must be no more than ${max}` };
  }

  return { valid: true, value: num };
}

module.exports = {
  validateDomain,
  validateUrl,
  validateIpAddress,
  validateRequiredString,
  validateSlug,
  validateHexColor,
  validateNumber
};

