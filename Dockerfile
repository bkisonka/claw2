# ---- build ----
FROM node:20-alpine AS build
WORKDIR /app

COPY package.json package-lock.json ./
RUN npm ci

COPY tsconfig.json ./
COPY src ./src
# post-build step lives in scripts/ (see package.json build script)
COPY scripts/copy-gateway-sql.cjs ./scripts/
RUN npm run build

COPY web/package.json web/package-lock.json ./web/
RUN cd web && npm ci
COPY web ./web
# Personal delivery: the web client runs in single-user mode — no hosted
# login UI; the gateway key is entered once at the first visit and stored
# in the browser (GatewayKeyGate).
ENV VITE_CLAW2_SINGLE_USER=1
RUN npm run build:web

COPY pwa/package.json pwa/package-lock.json pwa/tsconfig.json pwa/tsconfig.node.json pwa/vite.config.ts pwa/index.html ./pwa/
RUN cd pwa && npm ci
COPY pwa ./pwa
RUN cd pwa && npm run build

# ---- runtime ----
FROM node:20-alpine AS runtime
WORKDIR /app

# docker CLI: the gateway launches every skill as a sibling container on the
# host docker through a restricted API proxy (compose ships docker-socket-
# proxy; DOCKER_HOST points at it). The gateway itself never sees the socket.
COPY package.json package-lock.json ./
RUN apk add --no-cache docker-cli && \
    npm ci --omit=dev && \
    npm install --no-save --omit=dev --no-audit --no-fund \
      "cheerio@^1.2.0" "rss-parser@^3.13.0" "mammoth@^1.8.0" "pdf-parse@^1.1.1" \
      "tesseract.js@^5.1.0" "xlsx@^0.18.5" "docx@^9.5.0"
# The extra install above = libraries of the bundled skills (agents/):
# skills resolve imports from /app/node_modules, the parent of /app/agents.

COPY --from=build /app/dist ./dist
COPY --from=build /app/web/dist ./web/dist
COPY --from=build /app/pwa/dist ./pwa/dist
COPY agents ./agents
COPY hss.cjs ./

ENV NODE_ENV=production
ENV CLAW2_STATIC_PATH=/app/web/dist
ENV CLAW2_PWA_PATH=/app/pwa/dist
ENV CLAW2_CONFIG_PATH=/app/.claw2/claw2.yaml

# Non-root: the gateway (and sibling skill containers built from this image)
# run as node (uid 1000). Mounted host dirs (.claw2, data, agents) must be
# writable by uid 1000 — true for Docker Desktop and the typical first user
# on Linux hosts; chown them once if your host layout differs.
USER node

EXPOSE 3000

CMD ["node", "dist/gateway/cli.js"]
