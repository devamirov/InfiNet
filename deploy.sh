#!/bin/bash

# InfiNet AI Chatbot Deployment Script
# This script uploads and sets up everything on your server

set -e  # Exit on error

# Colors for output
RED='\033[0;31m'
GREEN='\033[0;32m'
YELLOW='\033[1;33m'
NC='\033[0m' # No Color

# Configuration
SERVER_IP="75.119.155.9"
SERVER_USER="root"  # Change if you use a different user
SERVER_PATH="/var/www/infinet.services"
SSH_KEY="$HOME/Desktop/servercc.txt"
BACKEND_PORT="3000"

# API Configuration - Update these or they'll be prompted
GEMINI_API_KEY="GEMINI_KEY"
EMAIL_USER="amirxtet@gmail.com"
EMAIL_PASS=""
TELEGRAM_BOT_TOKEN=""
TELEGRAM_CHAT_ID=""

echo -e "${GREEN}========================================${NC}"
echo -e "${GREEN}InfiNet AI Chatbot Deployment Script${NC}"
echo -e "${GREEN}========================================${NC}"
echo ""

# Check if SSH key exists
if [ ! -f "$SSH_KEY" ]; then
    echo -e "${RED}Error: SSH key not found at $SSH_KEY${NC}"
    exit 1
fi

# Set correct permissions for SSH key
chmod 600 "$SSH_KEY"

# Check if .env exists locally, if not create it
if [ ! -f "backend/.env" ]; then
    echo -e "${YELLOW}Creating backend/.env file...${NC}"
    
    # Prompt for missing credentials
    if [ -z "$EMAIL_PASS" ]; then
        echo -e "${YELLOW}Enter Gmail App Password (or press Enter to skip and set later):${NC}"
        read -s EMAIL_PASS
    fi
    
    if [ -z "$TELEGRAM_BOT_TOKEN" ]; then
        echo -e "${YELLOW}Enter Telegram Bot Token (or press Enter to skip and set later):${NC}"
        read TELEGRAM_BOT_TOKEN
    fi
    
    if [ -z "$TELEGRAM_CHAT_ID" ]; then
        echo -e "${YELLOW}Enter Telegram Chat ID (or press Enter to skip and set later):${NC}"
        read TELEGRAM_CHAT_ID
    fi
    
    # Create .env file
    cat > backend/.env << EOF
# Server Configuration
PORT=$BACKEND_PORT

# Email Configuration (Gmail)
EMAIL_USER=$EMAIL_USER
EMAIL_PASS=${EMAIL_PASS:-your-app-password-here}

# Telegram Bot Configuration
TELEGRAM_BOT_TOKEN=${TELEGRAM_BOT_TOKEN:-your-bot-token-here}
TELEGRAM_CHAT_ID=${TELEGRAM_CHAT_ID:-your-chat-id-here}

# Google Gemini AI Configuration
GEMINI_API_KEY=$GEMINI_API_KEY
EOF
    
    echo -e "${GREEN}Created backend/.env file${NC}"
fi

# Step 1: Update API_BASE_URL in ai-chat-widget.js
echo -e "${YELLOW}Step 1: Updating API_BASE_URL in ai-chat-widget.js...${NC}"
BACKEND_URL="http://${SERVER_IP}:${BACKEND_PORT}"
sed -i.bak "s|const API_BASE_URL = 'http://localhost:3000';|const API_BASE_URL = '${BACKEND_URL}';|g" ai-chat-widget.js
echo -e "${GREEN}✓ Updated API_BASE_URL to ${BACKEND_URL}${NC}"

# Step 2: Create temporary directory structure
echo -e "${YELLOW}Step 2: Preparing files for upload...${NC}"
TEMP_DIR=$(mktemp -d)
mkdir -p "$TEMP_DIR/backend"

# Copy files to temp directory
cp ai-chat-widget.js "$TEMP_DIR/"
cp -r backend/* "$TEMP_DIR/backend/" 2>/dev/null || true

# Don't upload node_modules
rm -rf "$TEMP_DIR/backend/node_modules" 2>/dev/null || true
rm -rf "$TEMP_DIR/backend/.git" 2>/dev/null || true

echo -e "${GREEN}✓ Files prepared${NC}"

# Step 3: Upload files to server
echo -e "${YELLOW}Step 3: Uploading files to server...${NC}"

# Upload ai-chat-widget.js to website root
echo "Uploading ai-chat-widget.js..."
scp -i "$SSH_KEY" -o StrictHostKeyChecking=no "$TEMP_DIR/ai-chat-widget.js" \
    "${SERVER_USER}@${SERVER_IP}:${SERVER_PATH}/ai-chat-widget.js"

# Upload backend files
echo "Uploading backend files..."
scp -i "$SSH_KEY" -o StrictHostKeyChecking=no -r "$TEMP_DIR/backend" \
    "${SERVER_USER}@${SERVER_IP}:${SERVER_PATH}/"

echo -e "${GREEN}✓ Files uploaded${NC}"

# Step 4: Setup backend on server
echo -e "${YELLOW}Step 4: Setting up backend on server...${NC}"

ssh -i "$SSH_KEY" -o StrictHostKeyChecking=no "${SERVER_USER}@${SERVER_IP}" << 'ENDSSH'
set -e

SERVER_PATH="/var/www/infinet.services"
BACKEND_DIR="$SERVER_PATH/backend"
BACKEND_PORT="3000"

echo "Installing Node.js dependencies..."
cd "$BACKEND_DIR"
npm install --production

echo "Checking if PM2 is installed..."
if ! command -v pm2 &> /dev/null; then
    echo "Installing PM2..."
    npm install -g pm2
fi

echo "Setting up PM2 startup..."
pm2 startup systemd -u root --hp /root || true

echo "Stopping existing backend if running..."
pm2 stop infinet-backend 2>/dev/null || true
pm2 delete infinet-backend 2>/dev/null || true

echo "Starting backend server..."
cd "$BACKEND_DIR"
pm2 start server.js --name "infinet-backend"
pm2 save

echo "Checking firewall..."
# Check if ufw is active
if command -v ufw &> /dev/null; then
    if ufw status | grep -q "Status: active"; then
        echo "Opening port $BACKEND_PORT in firewall..."
        ufw allow $BACKEND_PORT/tcp || true
    fi
fi

# Check if firewalld is active
if command -v firewall-cmd &> /dev/null; then
    if systemctl is-active --quiet firewalld; then
        echo "Opening port $BACKEND_PORT in firewalld..."
        firewall-cmd --permanent --add-port=$BACKEND_PORT/tcp || true
        firewall-cmd --reload || true
    fi
fi

echo "Waiting for server to start..."
sleep 3

echo "Testing backend health endpoint..."
curl -f http://localhost:$BACKEND_PORT/api/health || echo "Warning: Backend health check failed"

echo "Backend setup complete!"
ENDSSH

echo -e "${GREEN}✓ Backend setup complete${NC}"

# Step 5: Verify HTML files have script tags
echo -e "${YELLOW}Step 5: Verifying HTML files...${NC}"

ssh -i "$SSH_KEY" -o StrictHostKeyChecking=no "${SERVER_USER}@${SERVER_IP}" << 'ENDSSH'
SERVER_PATH="/var/www/infinet.services"

check_script_tag() {
    local file="$1"
    if [ -f "$file" ]; then
        if grep -q "ai-chat-widget.js" "$file"; then
            echo "✓ $file has script tag"
        else
            echo "⚠ $file is missing script tag"
        fi
    else
        echo "⚠ $file not found"
    fi
}

check_script_tag "$SERVER_PATH/index.html"
check_script_tag "$SERVER_PATH/services/index.html"
check_script_tag "$SERVER_PATH/about-us/index.html"
check_script_tag "$SERVER_PATH/portfolio/index.html"
check_script_tag "$SERVER_PATH/contact/index.html"
ENDSSH

# Cleanup
rm -rf "$TEMP_DIR"

echo ""
echo -e "${GREEN}========================================${NC}"
echo -e "${GREEN}Deployment Complete!${NC}"
echo -e "${GREEN}========================================${NC}"
echo ""
echo "Backend URL: http://${SERVER_IP}:${BACKEND_PORT}"
echo "Backend Health Check: http://${SERVER_IP}:${BACKEND_PORT}/api/health"
echo ""
echo "Next steps:"
echo "1. Visit your website: https://infinet.services"
echo "2. Click the floating robot button to test the chatbot"
echo "3. Check backend logs: ssh -i $SSH_KEY ${SERVER_USER}@${SERVER_IP} 'pm2 logs infinet-backend'"
echo ""
echo "If you need to update .env file:"
echo "  ssh -i $SSH_KEY ${SERVER_USER}@${SERVER_IP}"
echo "  nano ${SERVER_PATH}/backend/.env"
echo "  pm2 restart infinet-backend"
echo ""




