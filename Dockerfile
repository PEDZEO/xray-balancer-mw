FROM node:20-alpine
WORKDIR /app
COPY server.js .
COPY config.json .
EXPOSE 4100
CMD ["node", "server.js"]
