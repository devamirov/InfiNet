# InfiNet AI Agent - Setup Guide

## 🎉 Congratulations! Your AI Agent is ready!

This guide will help you set up and use your new AI Agent for your InfiNet website.

## 📋 What's Been Built

1. **Backend AI Chat API** - Handles all AI conversations
2. **Floating Chat Widget** - Appears on all pages
3. **Admin Panel** - View conversations and leads
4. **Database Integration** - Stores all conversations and leads
5. **Booking Integration** - Automatically schedules consultations

## 🚀 Quick Setup

### Step 1: Install Dependencies

```bash
cd backend
npm install
```

### Step 2: Configure API Key

1. Open `backend/.env` file (create it if it doesn't exist)
2. Add your Gemini API key:
   ```
   GEMINI_API_KEY=AIzaSyBMoXVtx_O4uwyUCLwrNQGN3xQvPMxCp6c
   ```

### Step 3: Update API URL (Important!)

**In Production:**
1. Open `ai-chat-widget.js`
2. Find this line: `const API_BASE_URL = 'http://localhost:3000';`
3. Replace with your backend URL: `const API_BASE_URL = 'https://your-backend-url.com';`

**In Admin Panel:**
1. Open `admin/index.html`
2. Find this line: `const API_BASE_URL = 'http://localhost:3000';`
3. Replace with your backend URL: `const API_BASE_URL = 'https://your-backend-url.com';`

### Step 4: Add Widget to All Pages

The widget is already added to `index.html`. To add it to other pages:

1. Open any HTML page (e.g., `services/index.html`, `portfolio/index.html`)
2. Before `</body>`, add:
   ```html
   <!-- InfiNet AI Chat Widget -->
   <script src="../ai-chat-widget.js"></script>
   ```
   (Use `ai-chat-widget.js` if the file is in the same directory)

### Step 5: Start the Backend Server

```bash
cd backend
npm start
```

Or for development with auto-reload:
```bash
npm run dev
```

## 🎯 Features

### For Visitors:
- **Customer Support** - Answers FAQs about services
- **Portfolio Assistant** - Suggests relevant projects
- **Project Estimator** - Provides rough estimates (directs to contact for exact pricing)
- **Design Consultation** - Collects preferences and requirements
- **Auto-Booking** - Schedules consultations when visitor confirms

### For You (Admin):
- **View All Conversations** - See every chat session
- **View All Leads** - See collected lead information
- **Booking Integration** - Leads automatically create bookings
- **Statistics** - Track conversations, leads, and bookings

## 📊 Admin Panel

Access the admin panel at: `http://your-domain.com/admin/`

**Features:**
- View all conversations
- View all leads with collected information
- See booking status
- Export data (coming soon)

## 🔧 Configuration

### AI Model
The system uses **Gemini 2.0 Flash** (fast and free tier friendly)

### Free Tier Limits
- **15 requests per minute**
- **1,500 requests per day**
- **1,000,000 tokens per minute**

This is usually enough for most websites!

## 🐛 Troubleshooting

### Widget Not Appearing
1. Check browser console for errors
2. Verify `ai-chat-widget.js` is accessible
3. Check API_BASE_URL is correct

### AI Not Responding
1. Check backend server is running
2. Verify GEMINI_API_KEY is set in `.env`
3. Check backend logs for errors
4. Verify API key is valid

### CORS Errors
1. Make sure your backend CORS settings include your frontend domain
2. Check `server.js` CORS configuration

## 📝 API Endpoints

- `POST /api/ai/chat` - Send message to AI
- `POST /api/ai/create-booking` - Create booking from AI
- `GET /api/ai/conversations` - Get all conversations (Admin)
- `GET /api/ai/conversations/:sessionId` - Get conversation (Admin)
- `GET /api/ai/leads` - Get all leads (Admin)
- `GET /api/ai/leads/:sessionId` - Get lead (Admin)

## 🔒 Security Notes

1. **Never commit `.env` file** - Keep API keys secret
2. **Use HTTPS in production** - Protect API calls
3. **Add authentication to admin panel** - Protect your data
4. **Rate limiting** - Consider adding rate limits to API

## 📞 Support

If you encounter any issues:
1. Check backend logs
2. Check browser console
3. Verify all configuration is correct
4. Test API endpoints directly

## 🎨 Customization

### Widget Colors
Edit `ai-chat-widget.js` - search for color values:
- `#060097` - Primary blue
- `#57ffff` - Accent cyan

### Widget Position
Edit the CSS in `ai-chat-widget.js`:
```css
.infinet-ai-widget {
    bottom: 20px;
    right: 20px;
}
```

### AI Personality
Edit the `AI_SYSTEM_PROMPT` in `backend/server.js` to change how the AI responds.

## ✅ Checklist

- [ ] Install dependencies (`npm install` in backend)
- [ ] Add GEMINI_API_KEY to `.env`
- [ ] Update API_BASE_URL in `ai-chat-widget.js`
- [ ] Update API_BASE_URL in `admin/index.html`
- [ ] Add widget script to all pages
- [ ] Start backend server
- [ ] Test the widget
- [ ] Test admin panel
- [ ] Add authentication to admin panel (recommended)

## 🎊 You're All Set!

Your AI Agent is ready to help your visitors and generate leads!




