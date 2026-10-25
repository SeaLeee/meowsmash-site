FROM node:20-alpine
WORKDIR /app
COPY server.js ./
COPY public ./public
ENV DATA_DIR=/data
CMD ["node", "server.js"]
