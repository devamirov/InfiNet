# Backend Setup Guide

## Step 1: Create .env file

Copy the example environment file:
```bash
cd backend
cp env.example .env
```

## Step 2: Configure Email (Gmail)

1. Go to your Google Account settings
2. Enable 2-Factor Authentication
3. Go to "App Passwords" (https://myaccount.google.com/apppasswords)
4. Create a new app password for "Mail"
5. Copy the 16-character password
6. Edit `.env` file and replace `your-app-password-here` with your app password:
   ```
   EMAIL_PASS=your-16-character-app-password
   ```

## Step 3: Configure Telegram Bot

1. Open Telegram and search for `@BotFather`
2. Send `/newbot` command
3. Follow instructions to create a bot
4. Copy the bot token (looks like: `123456789:ABCdefGHIjklMNOpqrsTUVwxyz`)
5. Edit `.env` file and replace `your-bot-token-here` with your bot token:
   ```
   TELEGRAM_BOT_TOKEN=123456789:ABCdefGHIjklMNOpqrsTUVwxyz
   ```

6. Get your Chat ID:
   - Search for `@userinfobot` on Telegram
   - Start a conversation with it
   - Copy your Chat ID (looks like: `123456789`)
   - Edit `.env` file and replace `your-chat-id-here` with your chat ID:
     ```
     TELEGRAM_CHAT_ID=123456789
     ```

## Step 4: Install Dependencies

```bash
npm install
```

## Step 5: Start the Server

```bash
npm start
```

Or for development with auto-restart:
```bash
npm run dev
```

The server will run on `http://localhost:3000`

## Step 6: Verify Setup

The server will show on startup:
- ✅ Email service: Configured (if EMAIL_USER is set)
- ✅ Telegram bot: Configured (if TELEGRAM_BOT_TOKEN is set)

## Testing

### Test Email
```bash
node test-email.js
```

### Test Telegram
```bash
node test-telegram.js
```

## Important Notes

1. **Gmail App Password**: Never use your regular Gmail password. Always use an App Password.
2. **Keep .env private**: Never commit `.env` file to version control.
3. **Port**: Default port is 3000. Change `PORT` in `.env` if needed.
4. **CORS**: Currently allows all origins. Restrict in production.

## Troubleshooting

- **Email not sending**: Check app password is correct and 2FA is enabled
- **Telegram not working**: Verify bot token and chat ID are correct
- **API not responding**: Make sure server is running on port 3000

