#!/bin/bash
# Run this ON THE SERVER to upgrade the container: build image + recreate/start.
# Usage: ./docker-upgrade.sh   (from /var/www/infinet.services/ai-studio-backend)

set -e
cd "$(dirname "$0")"
echo "Building image..."
docker compose build
echo "Recreating and starting container..."
docker compose up -d
echo "Done. Logs: docker compose logs -f ai-studio-backend"
