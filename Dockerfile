FROM node:20-slim

WORKDIR /app

COPY package*.json ./
RUN npm install --omit=dev --no-fund --no-audit

COPY index.js auth.js ./

RUN mkdir -p /app/.baileys_auth

CMD ["node", "index.js"]
