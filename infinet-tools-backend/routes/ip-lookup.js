const express = require('express');
const router = express.Router();
const axios = require('axios');

/**
 * POST /api/tools/ip-lookup
 * Look up IP address information
 */
router.post('/', async (req, res) => {
  try {
    const { ip } = req.body;

    if (!ip || typeof ip !== 'string') {
      return res.status(400).json({
        error: 'IP address is required',
        status: 400
      });
    }

    const trimmedIp = ip.trim();
    
    // Validate IP format (IPv4 or IPv6)
    const ipv4Pattern = /^(\d{1,3}\.){3}\d{1,3}$/;
    const ipv6Pattern = /^([0-9a-fA-F]{0,4}:){2,7}[0-9a-fA-F]{0,4}$/;
    
    if (!ipv4Pattern.test(trimmedIp) && !ipv6Pattern.test(trimmedIp)) {
      return res.status(400).json({
        error: 'Invalid IP address format',
        status: 400
      });
    }

    try {
      // Use ipapi.co for IP lookup (free tier)
      const response = await axios.get(`https://ipapi.co/${trimmedIp}/json/`, {
        timeout: 10000
      });

      const data = response.data;

      const result = {
        ip: data.ip || trimmedIp,
        location: data.city && data.region 
          ? `${data.city}, ${data.region}` 
          : data.city || data.region || 'Unknown',
        isp: data.org || data.asn || 'Unknown',
        country: data.country_name || data.country || 'Unknown',
        city: data.city || undefined,
        region: data.region || undefined,
        countryCode: data.country_code || undefined,
        timezone: data.timezone || undefined,
        latitude: data.latitude || undefined,
        longitude: data.longitude || undefined
      };

      res.json({
        ...result,
        timestamp: new Date().toISOString()
      });

    } catch (error) {
      console.error('IP lookup error:', error);
      
      // Return error response
      res.status(500).json({
        error: 'Failed to lookup IP address',
        message: error.response?.data?.reason || error.message || 'IP lookup service unavailable',
        status: 500,
        ip: trimmedIp
      });
    }

  } catch (error) {
    console.error('IP lookup endpoint error:', error);
    res.status(500).json({
      error: 'Internal server error',
      status: 500
    });
  }
});

module.exports = router;

