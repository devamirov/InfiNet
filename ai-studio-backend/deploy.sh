#!/bin/bash
# Deploy ai-studio-backend to server: upload files, npm install, pm2 restart.
# Set SERVER, SERVER_PATH, and optionally SSH_KEY and PM2_NAME before running.

set -e

# Defaults – override with env vars
SERVER="${SERVER:-root@75.119.155.9}"
SERVER_PATH="${SERVER_PATH:-/var/www/infinet.services/ai-studio-backend}"
PM2_NAME="${PM2_NAME:-ai-studio-backend}"
SSH_KEY="${SSH_KEY:-$HOME/Desktop/contabo_key.txt}"
# If SSH_KEY is set (e.g. ~/Desktop/contabo_key.txt), use it for scp/ssh
SCP_OPTS=(); SSH_OPTS=()
[[ -n "$SSH_KEY" ]] && { SCP_OPTS=(-i "$SSH_KEY"); SSH_OPTS=(-i "$SSH_KEY"); }

echo "Deploying to $SERVER:$SERVER_PATH (PM2: $PM2_NAME)"

echo "Uploading package.json..."
scp "${SCP_OPTS[@]}" package.json "${SERVER}:${SERVER_PATH}/"

echo "Uploading server.js..."
scp "${SCP_OPTS[@]}" server.js "${SERVER}:${SERVER_PATH}/server.js"

echo "Uploading package-lock.json..."
scp "${SCP_OPTS[@]}" package-lock.json "${SERVER}:${SERVER_PATH}/"

echo "On server: npm install, pm2 restart..."
ssh "${SSH_OPTS[@]}" "${SERVER}" "cd ${SERVER_PATH} && npm install --omit=dev && pm2 restart ${PM2_NAME}"

echo "Deployment complete."
echo "Check logs: ssh ${SSH_OPTS[*]} ${SERVER} 'pm2 logs ${PM2_NAME} --lines 50'"
