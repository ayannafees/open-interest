FROM node:18-alpine
WORKDIR /app
COPY package*.json ./
RUN npm ci --only=production
COPY src/ ./src/
EXPOSE 4002 4003 4004 4005
CMD ["node", "src/server.js"]
