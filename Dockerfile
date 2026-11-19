FROM node:22.23.5-alpine3.24 AS dependencies

WORKDIR /app
COPY package*.json ./
RUN npm ci --omit=dev

FROM alpine:3.24
RUN apk add --no-cache ca-certificates libatomic libstdc++

WORKDIR /app
COPY --from=dependencies /usr/local/bin/node /usr/local/bin/node
COPY --from=dependencies /app/node_modules ./node_modules
COPY package.json server.js health.js public-view.js config.json ./
COPY public ./public

EXPOSE 9200
CMD ["node", "server.js"]
