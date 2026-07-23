# syntax=docker/dockerfile:1.7

FROM node:24-trixie AS build
WORKDIR /app
COPY package.json package-lock.json ./
RUN npm ci
COPY tsconfig.json vitest.config.ts ./
COPY src ./src
RUN npm run build && npm prune --omit=dev

FROM node:24-trixie-slim
ARG TARGETARCH
ARG SING_BOX_VERSION=1.13.14
ENV NODE_ENV=production \
    PORT=8080 \
    MIMO2API_DATA_DIR=/var/lib/mimo2api \
    MIMO2API_DATABASE_FILE=/var/lib/mimo2api/mimo2api.sqlite \
    MIMO2API_CONFIG_FILE=/var/lib/mimo2api/config.json
WORKDIR /app
COPY --from=build /app/node_modules ./node_modules
COPY --from=build /app/dist ./dist
COPY package.json config.example.json ./
COPY web ./web
RUN apt-get update \
    && apt-get install -y --no-install-recommends ca-certificates curl \
    && rm -rf /var/lib/apt/lists/* \
    && case "$TARGETARCH" in amd64|arm64) ;; *) echo "unsupported sing-box architecture: $TARGETARCH" >&2; exit 1 ;; esac \
    && curl -fsSL "https://github.com/SagerNet/sing-box/releases/download/v${SING_BOX_VERSION}/sing-box-${SING_BOX_VERSION}-linux-${TARGETARCH}-glibc.tar.gz" -o /tmp/sing-box.tar.gz \
    && mkdir -p /tmp/sing-box \
    && tar -xzf /tmp/sing-box.tar.gz -C /tmp/sing-box \
    && install -m 0755 "$(find /tmp/sing-box -type f -name sing-box -print -quit)" /usr/local/bin/sing-box \
    && rm -rf /tmp/sing-box /tmp/sing-box.tar.gz \
    && groupadd --gid 10001 mimo2api \
    && useradd --uid 10001 --gid 10001 --no-create-home --home-dir /app --shell /usr/sbin/nologin mimo2api \
    && mkdir -p /var/lib/mimo2api \
    && chown -R 10001:10001 /app /var/lib/mimo2api
USER 10001:10001
EXPOSE 8080
HEALTHCHECK --interval=30s --timeout=5s --start-period=15s --retries=3 \
  CMD node -e "fetch('http://127.0.0.1:8080/healthz').then(r=>{if(!r.ok)process.exit(1)}).catch(()=>process.exit(1))"
CMD ["node", "dist/index.js"]
