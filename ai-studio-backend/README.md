# AI Studio Backend

Backend API for InfiNet Hub Mobile App - AI Studio (Assistant & Creator sections).

## Features

- **AI Chat Messaging** - Powered by Google Gemini API
- **Image Generation** - Powered by OpenAI DALL-E 3
- **Blog Content Generation** - Powered by Google Gemini
- **Social Media Content** - Powered by Google Gemini
- **Prompt Generation** - Powered by Google Gemini

## Setup

### 1. Install Dependencies

```bash
cd ai-studio-backend
npm install
```

### 2. Configure Environment Variables

Copy `.env.example` to `.env` and fill in your API keys:

```bash
cp .env.example .env
```

Edit `.env` and add:
- `OPENAI_API_KEY` - Your OpenAI API key for DALL-E
- `GEMINI_API_KEY` - Your Google Gemini API key
- `PORT` - Server port (default: 3001)
- `CORS_ORIGINS` - Comma-separated list of allowed origins

### 3. Start Server

```bash
# Production
npm start

# Development (with auto-reload)
npm run dev
```

## API Endpoints

### Health Check
```
GET /api/health
```

### AI Chat (Gemini)
```
POST /api/ai/chat
Body: {
  "message": "Hello, how can you help?",
  "conversationHistory": [] // Optional
}
```

### Image Generation (DALL-E)
```
POST /api/ai/image
Body: {
  "prompt": "A futuristic city at sunset",
  "size": "1024x1024", // 256x256, 512x512, 1024x1024, 1792x1024, 1024x1792
  "quality": "standard" // standard or hd (only for 1024x1024)
}
```

### Blog Generation (Gemini)
```
POST /api/ai/blog
Body: {
  "topic": "Artificial Intelligence",
  "tone": "professional", // professional, casual, friendly
  "length": "medium", // short, medium, long
  "style": "article" // article, blog, guide
}
```

### Social Media Content (Gemini)
```
POST /api/ai/social
Body: {
  "topic": "New product launch",
  "platform": "instagram", // twitter, instagram, linkedin, facebook, general
  "tone": "engaging", // engaging, professional, casual, friendly
  "hashtags": true
}
```

### Prompt Generation (Gemini)
```
POST /api/ai/prompt
Body: {
  "purpose": "Generate a marketing email",
  "context": "For a tech startup",
  "style": "detailed" // detailed, concise, creative
}
```

## Deployment

### Deploy to Contabo Server

1. Upload the `ai-studio-backend` folder to your server
2. SSH into your server
3. Navigate to the folder and install dependencies:
   ```bash
   cd ai-studio-backend
   npm install --production
   ```
4. Set up environment variables on the server
5. Use PM2 or supervisor to run the server:
   ```bash
   pm2 start server.js --name ai-studio-backend
   ```

## Notes

- Gemini API has a free tier with 200 tokens/day limit
- DALL-E 3 pricing: ~$0.040 per image (1024x1024)
- Make sure to configure CORS origins for your mobile app
- Use HTTPS in production

## Troubleshooting

- **API not configured**: Check your `.env` file has correct API keys
- **CORS errors**: Update `CORS_ORIGINS` in `.env` with your app's origin
- **Port already in use**: Change `PORT` in `.env` to a different port



