# Build and runtime use the same Debian/glibc base for native dependencies.
FROM node:22-bookworm-slim AS base
WORKDIR /app

FROM base AS native-build
# node-gyp fallback when a dependency doesn't ship a prebuilt binary.
RUN apt-get update && apt-get install -y --no-install-recommends python3 make g++ \
    && rm -rf /var/lib/apt/lists/*

# ---- build ----
FROM native-build AS build
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
# The web PWA does not use Capacitor's Android asset generation (Sharp).
# Skip its install-time binary download and run only esbuild's setup.
RUN cd pwa && npm ci --ignore-scripts && npm rebuild esbuild
COPY pwa ./pwa
RUN cd pwa && npm run build

# ---- production dependencies ----
FROM native-build AS runtime-deps
COPY package.json package-lock.json ./
RUN npm ci --omit=dev && \
    npm install --no-save --omit=dev --no-audit --no-fund \
      "cheerio@^1.2.0" "rss-parser@^3.13.0" "mammoth@^1.8.0" "pdf-parse@^1.1.1" \
      "tesseract.js@^5.1.0" "xlsx@^0.18.5" "docx@^9.5.0"
# Bundled skills look for their libraries in /app/node_modules, above /app/agents.

# ---- runtime ----
# sqlite-vec ships glibc-only prebuilt binaries; keep the same libc and Node
# ABI as the stages installing native dependencies.
FROM base AS dockercli-extract
ARG TARGETARCH
USER root
RUN apt-get update && apt-get install -y --no-install-recommends curl ca-certificates \
    && case "$TARGETARCH" in \
         arm64) DOCKER_ARCH=aarch64 ;; \
         amd64) DOCKER_ARCH=x86_64 ;; \
         *) echo "unsupported TARGETARCH=$TARGETARCH"; exit 1 ;; \
       esac \
    && curl -fsSL "https://download.docker.com/linux/static/stable/${DOCKER_ARCH}/docker-27.3.1.tgz" \
       -o /tmp/docker.tgz \
    && tar -xzf /tmp/docker.tgz -C /tmp docker/docker \
    && mv /tmp/docker/docker /usr/local/bin/docker && rm -rf /tmp/docker.tgz /var/lib/apt/lists/*

FROM base AS runtime

# Compose points DOCKER_HOST at the validating API guard; the gateway itself
# never sees the daemon socket.
COPY package.json package-lock.json ./
COPY --from=dockercli-extract /usr/local/bin/docker /usr/local/bin/docker
COPY --from=runtime-deps /app/node_modules ./node_modules

COPY --from=build /app/dist ./dist
COPY --from=build /app/web/dist ./web/dist
COPY --from=build /app/pwa/dist ./pwa/dist
COPY agents ./agents
COPY hss.cjs ./
COPY wiki ./wiki

ENV NODE_ENV=production
ENV CLAW2_STATIC_PATH=/app/web/dist
ENV CLAW2_PWA_PATH=/app/pwa/dist
ENV CLAW2_WIKI_PATH=/app/wiki
ENV CLAW2_CONFIG_PATH=/app/.claw2/claw2.yaml

# gosu: the entrypoint (docker-entrypoint.sh) starts as root only to fix the
# ownership of bind mounts, then drops to `node` — application code never
# runs as root.
RUN apt-get update && apt-get install -y --no-install-recommends gosu \
    && rm -rf /var/lib/apt/lists/*
COPY docker-entrypoint.sh /usr/local/bin/docker-entrypoint.sh
RUN chmod +x /usr/local/bin/docker-entrypoint.sh

# Default (non-root): sibling skill containers built from this image and
# standalone `docker run` use this user, so their entrypoint run skips the
# root branch and just execs the command. The compose gateway overrides it
# with `user: "0"` so the entrypoint can chown the bind mounts (Docker
# auto-creates ./data as root on the first `compose up`) before dropping
# back to node (uid 1000).
USER node

EXPOSE 3000

ENTRYPOINT ["docker-entrypoint.sh"]
CMD ["node", "dist/gateway/cli.js"]
