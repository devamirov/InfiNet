#!/bin/bash

# Start the booking API server
cd "$(dirname "$0")"

echo "🚀 Starting Consultation Booking API..."

# Check if .env exists
if [ ! -f .env ]; then
    echo "⚠️  .env file not found. Copying from env.example..."
    cp env.example .env
    echo "⚠️  Please configure .env file with your credentials"
fi

# Start the server
node server.js


