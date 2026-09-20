FROM node:22-alpine

WORKDIR /app
COPY package.json ./
COPY src ./src
COPY fixtures ./fixtures

ENV NODE_ENV=production
ENV EVENT_LOG=/app/data/events.jsonl
EXPOSE 3000
VOLUME ["/app/data"]
CMD ["node", "src/server.js"]
