# InfiNet Tools Backend

Backend API service for all InfiNet Hub Tools. This service handles all tool endpoints except URL Shortener (which runs on `infi.live` domain).

## Tools Implemented

1. **Domain Check** - Check domain availability
2. **WHOIS Lookup** - Get domain registration information
3. **QR Code Generator** - Generate QR codes
4. **SEO Preview** - Generate SEO preview data
5. **Business Name Generator** - Generate business name suggestions
6. **Color Palette Generator** - Generate color palettes from base colors
7. **UTM Generator** - Generate UTM tracking URLs
8. **Speed Test** - Test website loading speed
9. **IP Address Lookup** - Look up IP address information
10. **Image Resize** - Resize and compress images
11. **Favicon Generator** - Generate favicons in multiple sizes

## Prerequisites

- Node.js 18+ 
- npm or yarn
- System `whois` command (for domain/WHOIS tools)
- Chrome/Chromium (for Speed Test - Puppeteer)

## Installation

```bash
cd infinet-tools-backend
npm install
```

## Configuration

1. Copy `.env.example` to `.env`:
```bash
cp .env.example .env
```

2. Update `.env` with your configuration:
```env
PORT=3003
ALLOWED_ORIGINS=*
```

## Running

**Development:**
```bash
npm run dev
```

**Production:**
```bash
npm start
```

## API Endpoints

All endpoints are prefixed with `/api/tools/`:

- `POST /api/tools/domain-check` - Check domain availability
- `POST /api/tools/whois-lookup` - WHOIS lookup
- `POST /api/tools/qr` - Generate QR code
- `POST /api/tools/seo-preview` - Generate SEO preview
- `POST /api/tools/business-names` - Generate business names
- `POST /api/tools/color-palette` - Generate color palette
- `POST /api/tools/utm-generator` - Generate UTM URL
- `POST /api/tools/speed-test` - Speed test website
- `POST /api/tools/ip-lookup` - Lookup IP address
- `POST /api/tools/resize-image` - Resize image (multipart/form-data)
- `POST /api/tools/generate-favicon` - Generate favicon (multipart/form-data)
- `GET /api/health` - Health check

## Health Check

```bash
curl http://localhost:3003/api/health
```

## Deployment

See `DEPLOYMENT.md` for detailed deployment instructions to your Contabo server.

## Notes

- URL Shortener is NOT included here - it runs separately on `infi.live` domain
- File Converter is NOT included - it runs separately at `/var/www/infinet.services/file-converter-service`
- AI Studio backend is NOT included - it runs separately at `/var/www/infinet.services/ai-studio-backend`

