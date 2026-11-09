FROM node:25-slim
WORKDIR /app
COPY package*.json ./
RUN npm ci --omit=dev
COPY . .
ENV DATA_DIR=/data
VOLUME /data
EXPOSE 3000
CMD ["node", "server.js"]
