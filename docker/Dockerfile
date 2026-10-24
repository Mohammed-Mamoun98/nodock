# Two stages on purpose:
#   web-build  installs dev deps and builds the SPA
#   runtime    copies sources, installs production deps *in place*, drops nothing else
#
# Copying node_modules between stages looks cheaper but breaks workspace resolution:
# `drizzle-orm/bun-sqlite/migrator` lives under apps/server/node_modules, which a
# single `COPY --from=deps /app/node_modules` never carries.
FROM oven/bun:1-alpine AS web-build
WORKDIR /app
COPY package.json bun.lock tsconfig.base.json ./
COPY apps/server/package.json apps/server/
COPY apps/web/package.json apps/web/
RUN bun install --frozen-lockfile --ignore-scripts
COPY apps/web apps/web
RUN bun run --cwd apps/web build

FROM oven/bun:1-alpine AS runtime
WORKDIR /app
ENV NODE_ENV=production \
    DATA_DIR=/data
COPY package.json bun.lock tsconfig.base.json ./
COPY apps/server/package.json apps/server/
COPY apps/web/package.json apps/web/
COPY apps/server apps/server
COPY --from=web-build /app/apps/web/dist apps/web/dist
RUN bun install --frozen-lockfile --production --ignore-scripts
EXPOSE 3000
HEALTHCHECK --interval=30s --timeout=3s --start-period=15s \
  CMD wget -qO- http://127.0.0.1:3000/healthz || exit 1
CMD ["bun", "--smol", "apps/server/src/index.ts"]
