#!/bin/bash

# InfiNet Tools Backend Deployment Script
# Usage: ./deploy.sh [server_ip] [ssh_key_path] [username]

set -e

SERVER_IP=${1:-"75.119.155.9"}
SSH_KEY=${2:-"~/.ssh/id_rsa"}
SSH_USER=${3:-"root"}
DEPLOY_PATH="/var/www/infinet.services/infinet-tools-backend"
PORT=3003

echo "🚀 Deploying InfiNet Tools Backend to $SERVER_IP..."

# Check if SSH key exists
if [ ! -f "$SSH_KEY" ]; then
    echo "❌ SSH key not found at $SSH_KEY"
    exit 1
fi

# Create temporary deployment archive (exclude node_modules, temp, .env)
echo "📦 Creating deployment package..."
tar -czf /tmp/infinet-tools-backend.tar.gz \
    --exclude='node_modules' \
    --exclude='temp' \
    --exclude='.env' \
    --exclude='*.log' \
    --exclude='.git' \
    -C . .

echo "📤 Uploading files to server..."
scp -i "$SSH_KEY" /tmp/infinet-tools-backend.tar.gz "$SSH_USER@$SERVER_IP:/tmp/"

echo "🔧 Installing on server..."
ssh -i "$SSH_KEY" "$SSH_USER@$SERVER_IP" << EOF
    set -e
    
    # Create directory if it doesn't exist
    mkdir -p $DEPLOY_PATH
    cd $DEPLOY_PATH
    
    # Backup existing files if any
    if [ -f "server.js" ]; then
        echo "📋 Backing up existing installation..."
        cp -r . ../infinet-tools-backend-backup-\$(date +%Y%m%d-%H%M%S) || true
    fi
    
    # Extract new files
    echo "📥 Extracting files..."
    tar -xzf /tmp/infinet-tools-backend.tar.gz -C .
    rm /tmp/infinet-tools-backend.tar.gz
    
    # Create .env if it doesn't exist
    if [ ! -f .env ]; then
        echo "⚙️  Creating .env file..."
        cat > .env << EOL
PORT=$PORT
ALLOWED_ORIGINS=*
EOL
    fi
    
    # Create temp directory
    mkdir -p temp
    
    # Check Node.js
    if ! command -v node &> /dev/null; then
        echo "📦 Installing Node.js..."
        curl -fsSL https://deb.nodesource.com/setup_18.x | bash -
        apt-get install -y nodejs
    fi
    
    # Check PM2
    if ! command -v pm2 &> /dev/null; then
        echo "📦 Installing PM2..."
        npm install -g pm2
    fi
    
    # Install system dependencies
    echo "📦 Installing system dependencies..."
    apt-get update -qq
    apt-get install -y whois dnsutils chromium-browser || true
    
    # Install npm dependencies
    echo "📦 Installing npm dependencies..."
    npm install --production
    
    # Stop existing PM2 process if running
    pm2 stop infinet-tools-backend || true
    pm2 delete infinet-tools-backend || true
    
    # Start with PM2
    echo "🚀 Starting service with PM2..."
    pm2 start server.js --name infinet-tools-backend
    pm2 save
    
    # Check if process is running
    sleep 2
    if pm2 list | grep -q "infinet-tools-backend.*online"; then
        echo "✅ Service started successfully!"
        
        # Test health endpoint
        echo "🏥 Testing health endpoint..."
        sleep 1
        if curl -f http://localhost:$PORT/api/health > /dev/null 2>&1; then
            echo "✅ Health check passed!"
        else
            echo "⚠️  Health check failed - check logs with: pm2 logs infinet-tools-backend"
        fi
    else
        echo "❌ Service failed to start - check logs with: pm2 logs infinet-tools-backend"
        exit 1
    fi
    
    echo ""
    echo "📋 Next steps:"
    echo "1. Configure Apache2 reverse proxy (see apache2-config-example.conf)"
    echo "2. Enable Apache modules: a2enmod proxy proxy_http headers"
    echo "3. Reload Apache: systemctl reload apache2"
    echo "4. View logs: pm2 logs infinet-tools-backend"
EOF

# Cleanup local temp file
rm /tmp/infinet-tools-backend.tar.gz

echo ""
echo "✅ Deployment complete!"
echo ""
echo "📍 Service is running at: http://$SERVER_IP:$PORT"
echo "🏥 Health check: http://$SERVER_IP:$PORT/api/health"
echo ""
echo "📝 Don't forget to:"
echo "   1. Configure Apache2 reverse proxy"
echo "   2. Update frontend to point to your server"

