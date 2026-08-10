#!/bin/bash
# One-command deploy from your machine: upload files, build image, start container on server.
# Usage: ./deploy-docker.sh

set -e

SERVER="${SERVER:-root@75.119.155.9}"
SERVER_PATH="${SERVER_PATH:-/var/www/infinet.services/ai-studio-backend}"
SSH_KEY="${SSH_KEY:-$HOME/Desktop/contabo_key.txt}"

SCP_OPTS=(-o StrictHostKeyChecking=accept-new)
SSH_OPTS=(-o StrictHostKeyChecking=accept-new)
[[ -n "$SSH_KEY" ]] && [[ -f "$SSH_KEY" ]] && { SCP_OPTS+=(-i "$SSH_KEY"); SSH_OPTS+=(-i "$SSH_KEY"); }

echo "Uploading files to $SERVER:$SERVER_PATH ..."
scp "${SCP_OPTS[@]}" Dockerfile docker-compose.yml package.json package-lock.json server.js docker-upgrade.sh "${SERVER}:${SERVER_PATH}/"
# Upload auto-upgrade files (for install-auto-upgrade.sh on server)
scp -r "${SCP_OPTS[@]}" auto-upgrade "${SERVER}:${SERVER_PATH}/"

echo "On server: docker compose build && docker compose up -d ..."
ssh "${SSH_OPTS[@]}" "$SERVER" "cd ${SERVER_PATH} && chmod +x docker-upgrade.sh 2>/dev/null; docker compose build && docker compose up -d"

echo "Done. Logs: ssh ${SSH_OPTS[*]} $SERVER 'cd ${SERVER_PATH} && docker compose logs -f ai-studio-backend'"
