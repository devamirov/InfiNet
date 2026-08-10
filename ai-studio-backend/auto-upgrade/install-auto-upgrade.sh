#!/bin/bash
# Run this ONCE on the server as root to enable automatic docker-upgrade after boot and after apt upgrades.
# Usage: sudo ./install-auto-upgrade.sh   (from /var/www/infinet.services/ai-studio-backend/auto-upgrade)

set -e
SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
PROJECT_DIR="$(dirname "$SCRIPT_DIR")"

if [[ "$(id -u)" -ne 0 ]]; then
  echo "Run as root: sudo $0"
  exit 1
fi

echo "Installing systemd service..."
cp -f "$SCRIPT_DIR/ai-studio-docker-upgrade.service" /etc/systemd/system/
systemctl daemon-reload
systemctl enable ai-studio-docker-upgrade.service
echo "  Enabled: ai-studio-docker-upgrade.service (runs at boot)"

echo "Installing APT hook..."
cp -f "$SCRIPT_DIR/99-ai-studio-docker.conf" /etc/apt/apt.conf.d/
echo "  Installed: /etc/apt/apt.conf.d/99-ai-studio-docker.conf (runs ~2 min after apt upgrade)"

echo ""
echo "Done. From now on:"
echo "  - After reboot: container will build and start automatically."
echo "  - After apt upgrade / unattended-upgrades: container will rebuild and restart ~2 min after the last package."
echo "  - To run manually: $PROJECT_DIR/docker-upgrade.sh"
