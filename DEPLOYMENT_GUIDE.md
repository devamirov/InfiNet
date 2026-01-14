# AI Chatbot Deployment Guide

## 📋 Overview
This guide will help you deploy the AI chatbot to your live server at `infinet.services`.

## 🚀 Step-by-Step Deployment

### **Step 1: Upload Frontend Files**

#### 1.1 Upload the Chat Widget Script
- **File to upload**: `ai-chat-widget.js`
- **Location**: Upload to the root directory of your website (same level as `index.html`)
- **Path on server**: `/public_html/ai-chat-widget.js` or wherever your website root is

#### 1.2 Verify HTML Files
The following files should already have the chatbot script included (they do):
- ✅ `index.html` - Already has script tag
- ✅ `services/index.html` - Already has script tag
- ✅ `about-us/index.html` - Already has script tag
- ✅ `portfolio/index.html` - Already has script tag
- ✅ `contact/index.html` - Already has script tag

**If any HTML files are missing the script**, add this before `</body>`:
```html
<!-- InfiNet AI Chat Widget -->
<script src="ai-chat-widget.js"></script>
```
(For subdirectory pages, use: `<script src="../ai-chat-widget.js"></script>`)

---

### **Step 2: Update API URL in Widget**

#### 2.1 Update `ai-chat-widget.js`
**Before uploading**, change line 8 in `ai-chat-widget.js`:

**Current (localhost):**
```javascript
const API_BASE_URL = 'http://localhost:3000';
```

**Change to your live backend URL:**
```javascript
const API_BASE_URL = 'https://api.infinet.services'; // Or your backend domain
```
OR if backend is on same server but different port:
```javascript
const API_BASE_URL = 'https://infinet.services:3000'; // If using port 3000
```

---

### **Step 3: Set Up Backend Server**

#### 3.1 Upload Backend Files
Upload the entire `backend/` folder to your server. You can place it:
- **Option A**: Same server, different directory (e.g., `/home/username/backend/`)
- **Option B**: Subdomain (e.g., `api.infinet.services`)

**Files to upload:**
```
backend/
├── server.js          ✅ (Required)
├── package.json       ✅ (Required)
├── package-lock.json  ✅ (Required)
├── .env               ✅ (Required - create from env.example)
├── start.sh           ✅ (Optional - helpful for starting)
└── env.example        ✅ (Reference)
```

#### 3.2 Install Node.js Dependencies
SSH into your server and run:
```bash
cd /path/to/backend
npm install
```

#### 3.3 Create `.env` File
Create `.env` file in the `backend/` directory:

```bash
cd /path/to/backend
cp env.example .env
nano .env  # or use your preferred editor
```

**Fill in your actual values:**
```env
# Server Configuration
PORT=3000

# Email Configuration (Gmail)
EMAIL_USER=amirxtet@gmail.com
EMAIL_PASS=your-actual-gmail-app-password

# Telegram Bot Configuration
TELEGRAM_BOT_TOKEN=your-actual-telegram-bot-token
TELEGRAM_CHAT_ID=your-actual-telegram-chat-id

# Google Gemini AI Configuration
GEMINI_API_KEY=AIzaSyBMoXVtx_O4uwyUCLwrNQGN3xQvPMxCp6c
```

**⚠️ Important:**
- Use Gmail App Password (not regular password)
- Keep `.env` file secure (never commit to git)

---

### **Step 4: Start Backend Server**

#### 4.1 Option A: Using PM2 (Recommended)
```bash
# Install PM2 globally
npm install -g pm2

# Start the server
cd /path/to/backend
pm2 start server.js --name "infinet-backend"

# Make it start on server reboot
pm2 startup
pm2 save
```

#### 4.2 Option B: Using screen/tmux
```bash
cd /path/to/backend
screen -S backend
node server.js
# Press Ctrl+A then D to detach
```

#### 4.3 Option C: Using systemd (Linux)
Create `/etc/systemd/system/infinet-backend.service`:
```ini
[Unit]
Description=InfiNet Backend API
After=network.target

[Service]
Type=simple
User=your-username
WorkingDirectory=/path/to/backend
ExecStart=/usr/bin/node server.js
Restart=always
Environment=NODE_ENV=production

[Install]
WantedBy=multi-user.target
```

Then:
```bash
sudo systemctl enable infinet-backend
sudo systemctl start infinet-backend
```

---

### **Step 5: Configure Firewall & Ports**

#### 5.1 Allow Port 3000 (or your chosen port)
```bash
# Ubuntu/Debian
sudo ufw allow 3000/tcp

# CentOS/RHEL
sudo firewall-cmd --permanent --add-port=3000/tcp
sudo firewall-cmd --reload
```

#### 5.2 Configure Nginx (if using)
If you want to use a domain like `api.infinet.services`:

```nginx
server {
    listen 80;
    server_name api.infinet.services;

    location / {
        proxy_pass http://localhost:3000;
        proxy_http_version 1.1;
        proxy_set_header Upgrade $http_upgrade;
        proxy_set_header Connection 'upgrade';
        proxy_set_header Host $host;
        proxy_cache_bypass $http_upgrade;
    }
}
```

Then update `ai-chat-widget.js`:
```javascript
const API_BASE_URL = 'https://api.infinet.services';
```

---

### **Step 6: Verify Deployment**

#### 6.1 Test Backend
```bash
# Check if server is running
curl http://localhost:3000/api/health

# Should return: {"status":"OK","message":"Consultation Booking API is running"}
```

#### 6.2 Test Frontend
1. Visit `https://infinet.services`
2. Click the floating robot button (left side)
3. Send a test message: "Hi"
4. Check browser console (F12) for any errors

#### 6.3 Check Logs
```bash
# If using PM2
pm2 logs infinet-backend

# If using systemd
sudo journalctl -u infinet-backend -f
```

---

## 📁 Files Summary

### **Must Upload to Web Server:**
- ✅ `ai-chat-widget.js` → Root directory

### **Must Upload to Backend Server:**
- ✅ `backend/server.js`
- ✅ `backend/package.json`
- ✅ `backend/package-lock.json`
- ✅ `backend/.env` (create from env.example with your values)

### **Already on Server (verify):**
- ✅ `index.html` (should have script tag)
- ✅ `services/index.html` (should have script tag)
- ✅ `about-us/index.html` (should have script tag)
- ✅ `portfolio/index.html` (should have script tag)
- ✅ `contact/index.html` (should have script tag)
- ✅ `favicon-192x192.png` (for profile picture)

---

## 🔧 Configuration Checklist

- [ ] Uploaded `ai-chat-widget.js` to website root
- [ ] Updated `API_BASE_URL` in `ai-chat-widget.js` to live backend URL
- [ ] Uploaded backend files to server
- [ ] Created `.env` file with all API keys
- [ ] Installed Node.js dependencies (`npm install`)
- [ ] Started backend server (PM2/systemd/screen)
- [ ] Opened firewall port (3000 or your port)
- [ ] Configured Nginx reverse proxy (optional)
- [ ] Tested backend health endpoint
- [ ] Tested chatbot on live website

---

## 🐛 Troubleshooting

### Backend not accessible
- Check if server is running: `pm2 list` or `ps aux | grep node`
- Check firewall: `sudo ufw status`
- Check port: `netstat -tulpn | grep 3000`

### CORS errors
- Verify backend CORS settings in `server.js` include your domain
- Check browser console for specific error

### Database errors
- Database file will be created automatically
- Ensure Node.js has write permissions in backend directory

### Email not sending
- Verify Gmail App Password is correct
- Check 2FA is enabled on Gmail account
- Test email: `node test-email.js`

---

## 📞 Support

If you encounter issues:
1. Check backend logs
2. Check browser console (F12)
3. Verify all API keys in `.env`
4. Test backend endpoint directly: `curl http://your-backend-url/api/health`

---

## 🎉 You're Done!

Once all steps are complete, your AI chatbot will be live on all pages of your website!




