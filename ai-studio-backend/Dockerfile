# ai-studio-backend
FROM node:20-bookworm

WORKDIR /app

COPY package.json package-lock.json* ./
RUN npm install --omit=dev

COPY server.js ./

EXPOSE 3002

CMD ["node", "server.js"]
