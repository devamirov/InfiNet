# File Converter Service

Backend service for converting files between different formats.

## Supported Conversions

### Image Formats
- **Input**: JPG, JPEG, PNG, WEBP, GIF, BMP, TIFF, AVIF
- **Output**: JPG, JPEG, PNG, WEBP, GIF, BMP, TIFF, AVIF
- **Library**: Sharp

### Document Formats
- **Input**: PDF, DOCX, DOC, XLSX, XLS, PPTX, PPT, ODT, ODS, ODP, TXT, HTML, RTF
- **Output**: PDF, DOCX, DOC, XLSX, XLS, PPTX, PPT, ODT, ODS, ODP, TXT, HTML, RTF
- **Library**: LibreOffice (headless)

## Installation

1. Install Node.js dependencies:
```bash
npm install
```

2. Install LibreOffice (required for document conversions):
```bash
# Ubuntu/Debian
sudo apt-get update
sudo apt-get install -y libreoffice

# CentOS/RHEL
sudo yum install -y libreoffice

# macOS
brew install --cask libreoffice
```

3. Create `.env` file:
```bash
cp .env.example .env
```

4. Start the service:
```bash
npm start
```

For development:
```bash
npm run dev
```

## API Endpoints

### POST /api/convert
Convert a file to a different format.

**Request:**
- Method: POST
- Content-Type: multipart/form-data
- Body:
  - `file`: File to convert
  - `format`: Target format (e.g., "pdf", "png", "docx")

**Response:**
```json
{
  "success": true,
  "filename": "converted-file.pdf",
  "format": "pdf",
  "data": "base64-encoded-file-data",
  "mimeType": "application/pdf"
}
```

### GET /api/health
Check service health and LibreOffice availability.

**Response:**
```json
{
  "status": "ok",
  "libreOffice": true,
  "timestamp": "2025-01-XX..."
}
```

## Deployment

See `deploy.sh` for automated deployment to Contabo server.

