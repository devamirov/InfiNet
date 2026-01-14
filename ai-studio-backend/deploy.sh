#!/bin/bash

# AI Studio Backend Deployment Script
# Deploys to Contabo server safely without breaking existing services

set -e  # Exit on error

# Configuration
SERVER_IP="75.119.155.9"
SERVER_USER="root"
SERVER_PATH="/var/www/infinet.services"
BACKEND_DIR="ai-studio-backend"
SSH_KEY="$HOME/Desktop/contabo_key.txt"
LOCAL_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"

# Colors for output
RED='\033[0;31m'
GREEN='\033[0;32m'
YELLOW='\033[1;33m'
NC='\033[0m' # No Color

echo -e "${GREEN}🚀 Starting AI Studio Backend Deployment${NC}"
echo "=========================================="

# Check if SSH key exists
if [ ! -f "$SSH_KEY" ]; then
    echo -e "${RED}❌ SSH key not found at: $SSH_KEY${NC}"
    exit 1
fi

# Set proper permissions for SSH key
chmod 600 "$SSH_KEY"
echo -e "${GREEN}✓ SSH key permissions set${NC}"

# Test SSH connection
echo -e "${YELLOW}📡 Testing SSH connection...${NC}"
if ! ssh -i "$SSH_KEY" -o StrictHostKeyChecking=no -o ConnectTimeout=10 "$SERVER_USER@$SERVER_IP" "echo 'Connection successful'" > /dev/null 2>&1; then
    echo -e "${RED}❌ Failed to connect to server${NC}"
    exit 1
fi
echo -e "${GREEN}✓ SSH connection successful${NC}"

# Create backup of existing backend if it exists
echo -e "${YELLOW}💾 Creating backup of existing backend (if exists)...${NC}"
ssh -i "$SSH_KEY" "$SERVER_USER@$SERVER_IP" "
    if [ -d \"$SERVER_PATH/$BACKEND_DIR\" ]; then
        BACKUP_NAME=\"${BACKEND_DIR}_backup_\$(date +%Y%m%d_%H%M%S)\"
        cp -r \"$SERVER_PATH/$BACKEND_DIR\" \"$SERVER_PATH/\$BACKUP_NAME\"
        echo \"✓ Backup created: \$BACKUP_NAME\"
    else
        echo \"✓ No existing backend to backup\"
    fi
"

# Create directory structure on server
echo -e "${YELLOW}📁 Creating directory structure on server...${NC}"
ssh -i "$SSH_KEY" "$SERVER_USER@$SERVER_IP" "
    mkdir -p \"$SERVER_PATH/$BACKEND_DIR\"
    echo \"✓ Directory created\"
"

# Upload files (excluding node_modules, .env will be created separately)
echo -e "${YELLOW}📤 Uploading backend files...${NC}"
rsync -avz --progress \
    -e "ssh -i $SSH_KEY -o StrictHostKeyChecking=no" \
    --exclude 'node_modules' \
    --exclude '.env' \
    --exclude '.git' \
    --exclude '*.log' \
    "$LOCAL_DIR/" "$SERVER_USER@$SERVER_IP:$SERVER_PATH/$BACKEND_DIR/"

echo -e "${GREEN}✓ Files uploaded successfully${NC}"

# Create .env file on server (from local .env)
echo -e "${YELLOW}🔐 Setting up environment variables...${NC}"
if [ -f "$LOCAL_DIR/.env" ]; then
    scp -i "$SSH_KEY" -o StrictHostKeyChecking=no "$LOCAL_DIR/.env" "$SERVER_USER@$SERVER_IP:$SERVER_PATH/$BACKEND_DIR/.env"
    echo -e "${GREEN}✓ Environment variables configured${NC}"
else
    echo -e "${RED}❌ .env file not found locally${NC}"
    exit 1
fi

# Install dependencies on server
echo -e "${YELLOW}📦 Installing dependencies on server...${NC}"
ssh -i "$SSH_KEY" "$SERVER_USER@$SERVER_IP" "
    cd \"$SERVER_PATH/$BACKEND_DIR\"
    if command -v npm &> /dev/null; then
        npm install --production
        echo \"✓ Dependencies installed\"
    else
        echo \"⚠️  npm not found, trying with node...\"
        if command -v node &> /dev/null; then
            /usr/bin/npm install --production || echo \"⚠️  npm install failed, please install manually\"
        else
            echo \"❌ Node.js not found. Please install Node.js first.\"
            exit 1
        fi
    fi
"

# Check if PM2 is installed, if not, install it
echo -e "${YELLOW}⚙️  Setting up PM2 process manager...${NC}"
ssh -i "$SSH_KEY" "$SERVER_USER@$SERVER_IP" "
    if ! command -v pm2 &> /dev/null; then
        echo \"Installing PM2...\"
        npm install -g pm2
    fi
    
    # Stop existing process if running
    pm2 stop ai-studio-backend 2>/dev/null || true
    pm2 delete ai-studio-backend 2>/dev/null || true
    
    # Start the backend
    cd \"$SERVER_PATH/$BACKEND_DIR\"
    pm2 start server.js --name ai-studio-backend
    pm2 save
    
    echo \"✓ PM2 process started\"
"

# Test the backend
echo -e "${YELLOW}🧪 Testing backend health endpoint...${NC}"
sleep 3  # Wait for server to start
if curl -s -f "http://$SERVER_IP:3002/api/health" > /dev/null 2>&1; then
    echo -e "${GREEN}✓ Backend is running and responding${NC}"
else
    echo -e "${YELLOW}⚠️  Backend health check failed. Please check manually.${NC}"
    echo -e "${YELLOW}   You may need to configure firewall rules for port 3002${NC}"
fi

echo ""
echo -e "${GREEN}✅ Deployment completed successfully!${NC}"
echo "=========================================="
echo -e "${GREEN}Backend URL: http://$SERVER_IP:3002${NC}"
echo -e "${GREEN}Health Check: http://$SERVER_IP:3002/api/health${NC}"
echo ""
echo -e "${YELLOW}Next steps:${NC}"
echo "1. Update your mobile app to point to: http://$SERVER_IP:3002"
echo "2. Configure firewall if needed: sudo ufw allow 3002/tcp"
echo "3. Check PM2 status: ssh into server and run 'pm2 status'"
echo "4. View logs: pm2 logs ai-studio-backend"



