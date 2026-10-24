# Multi-stage: the web build never ships its toolchain, and the runtime image
# carries production deps only. `--smol` keeps the control plane's RSS down.
FROM oven/bun:1-alpine AS deps
WORKDIR /app
COPY package.json bun.lock ./
COPY apps/server/package.json apps/server/
COPY apps/web/package.json apps/web/
RUN bun install --frozen-lockfile --production --ignore-scripts

FROM oven/bun:1-alpine AS web-build
WORKDIR /app
COPY --from=deps /app/node_modules node_modules
COPY package.json bun.lock ./
COPY apps/web/package.json apps/web/
COPY apps/web apps/web
RUN bun install --frozen-lockfile --ignore-scripts && bun run --cwd apps/web build

FROM oven/bun:1-alpine AS runtime
WORKDIR /app
ENV NODE_ENV=production \
    DATA_DIR=/data
COPY package.json ./
COPY --from=deps /app/node_modules node_modules
COPY apps/server apps/server
COPY --from=web-build /app/apps/web/dist apps/web/dist
EXPOSE 3000
HEALTHCHECK --interval=30s --timeout=3s --start-period=15s \
  CMD wget -qO- http://127.0.0.1:3000/healthz || exit 1
CMD ["bun", "--smol", "apps/server/src/index.ts"]
