# InfiNet Tools Backend - Deployment Guide

## Server Information

- **Server IP**: 144.91.93.170
- **Deployment Path**: `/var/www/infinet.services/infinet-tools-backend/`
- **Port**: 3003
- **Web Server**: Apache2
- **Process Manager**: PM2

## Prerequisites on Server

Before deployment, ensure these are installed on your Contabo server:

```bash
# Install Node.js 18+
curl -fsSL https://deb.nodesource.com/setup_18.x | bash -
apt install -y nodejs

# Install PM2 globally
npm install -g pm2

# Install system dependencies
apt install -y whois dnsutils

# Install Chromium for Puppeteer (Speed Test)
apt install -y chromium-browser

# Install build tools (for native modules)
apt install -y build-essential python3
```

## Deployment Steps

### 1. Create Directory Structure

```bash
mkdir -p /var/www/infinet.services/infinet-tools-backend
cd /var/www/infinet.services/infinet-tools-backend
```

### 2. Upload Files

Upload all files from `infinet-tools-backend/` directory to `/var/www/infinet.services/infinet-tools-backend/`

You can use:
- `scp` command
- `rsync` command
- SFTP client

### 3. Install Dependencies

```bash
cd /var/www/infinet.services/infinet-tools-backend
npm install --production
```

### 4. Create .env File

```bash
cp .env.example .env
nano .env
```

Update with:
```env
PORT=3003
ALLOWED_ORIGINS=*
```

### 5. Start with PM2

```bash
pm2 start server.js --name infinet-tools-backend
pm2 save
pm2 startup
# Follow the instructions provided by PM2
```

### 6. Configure Apache2 Reverse Proxy

Add this to your Apache2 virtual host configuration. Since your domain is `infi.live`, edit:

```bash
nano /etc/apache2/sites-available/infi.live.conf
```

Or if using default:
```bash
nano /etc/apache2/sites-available/000-default.conf
```

Add these lines **inside** the `<VirtualHost>` block (for port 443 if you have SSL):

```apache
# Reverse proxy for InfiNet Tools Backend
ProxyPreserveHost On
ProxyPass /api/tools/domain-check http://localhost:3003/api/tools/domain-check
ProxyPassReverse /api/tools/domain-check http://localhost:3003/api/tools/domain-check

ProxyPass /api/tools/whois-lookup http://localhost:3003/api/tools/whois-lookup
ProxyPassReverse /api/tools/whois-lookup http://localhost:3003/api/tools/whois-lookup

ProxyPass /api/tools/qr http://localhost:3003/api/tools/qr
ProxyPassReverse /api/tools/qr http://localhost:3003/api/tools/qr

ProxyPass /api/tools/seo-preview http://localhost:3003/api/tools/seo-preview
ProxyPassReverse /api/tools/seo-preview http://localhost:3003/api/tools/seo-preview

ProxyPass /api/tools/business-names http://localhost:3003/api/tools/business-names
ProxyPassReverse /api/tools/business-names http://localhost:3003/api/tools/business-names

ProxyPass /api/tools/color-palette http://localhost:3003/api/tools/color-palette
ProxyPassReverse /api/tools/color-palette http://localhost:3003/api/tools/color-palette

ProxyPass /api/tools/utm-generator http://localhost:3003/api/tools/utm-generator
ProxyPassReverse /api/tools/utm-generator http://localhost:3003/api/tools/utm-generator

ProxyPass /api/tools/speed-test http://localhost:3003/api/tools/speed-test
ProxyPassReverse /api/tools/speed-test http://localhost:3003/api/tools/speed-test

ProxyPass /api/tools/ip-lookup http://localhost:3003/api/tools/ip-lookup
ProxyPassReverse /api/tools/ip-lookup http://localhost:3003/api/tools/ip-lookup

ProxyPass /api/tools/resize-image http://localhost:3003/api/tools/resize-image
ProxyPassReverse /api/tools/resize-image http://localhost:3003/api/tools/resize-image

ProxyPass /api/tools/generate-favicon http://localhost:3003/api/tools/generate-favicon
ProxyPassReverse /api/tools/generate-favicon http://localhost:3003/api/tools/generate-favicon
```

**OR** use a wildcard (simpler):

```apache
# Reverse proxy for InfiNet Tools Backend (wildcard)
ProxyPreserveHost On
ProxyPass /api/tools/ http://localhost:3003/api/tools/
ProxyPassReverse /api/tools/ http://localhost:3003/api/tools/
```

**Enable required Apache modules:**

```bash
a2enmod proxy
a2enmod proxy_http
a2enmod headers
systemctl restart apache2
```

### 7. Test Deployment

```bash
# Test health endpoint directly
curl http://localhost:3003/api/health

# Test through Apache (if domain is configured)
curl https://infi.live/api/tools/qr -X POST -H "Content-Type: application/json" -d '{"url":"https://example.com"}'
```

## Updating/Redeploying

```bash
cd /var/www/infinet.services/infinet-tools-backend

# Pull latest code or upload new files
# Then:
npm install --production
pm2 restart infinet-tools-backend

# Check logs
pm2 logs infinet-tools-backend
```

## Monitoring

```bash
# Check status
pm2 status

# View logs
pm2 logs infinet-tools-backend

# Monitor in real-time
pm2 monit
```

## Troubleshooting

1. **Service not starting**: Check logs with `pm2 logs infinet-tools-backend`
2. **Port already in use**: Change PORT in `.env` file
3. **WHOIS not working**: Install whois package: `apt install -y whois`
4. **Speed test failing**: Install Chromium: `apt install -y chromium-browser`
5. **Apache proxy not working**: Enable modules and restart Apache

## File Structure After Deployment

```
/var/www/infinet.services/
├── ai-studio-backend/          [Existing - Untouched]
├── file-converter-service/     [Existing - Untouched]
└── infinet-tools-backend/      [NEW]
    ├── server.js
    ├── package.json
    ├── .env
    ├── routes/
    ├── temp/                   [Auto-created]
    └── node_modules/
```

