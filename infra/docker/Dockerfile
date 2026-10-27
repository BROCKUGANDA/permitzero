# syntax=docker/dockerfile:1.7
#
# PermitZero monorepo image build.
#
# Three runtime targets share one source tree because the packages ship
# TypeScript that is executed directly by tsx (no emit step): api, worker and
# web. The web target is the only one that compiles, via `next build`.
#
# Two install stages, deliberately: the build stage needs dev dependencies
# (typescript, tailwind, postcss) while the api/worker runtimes install
# --omit=dev. tsx therefore lives in `dependencies`, not `devDependencies`, in
# every package that runs server code at runtime.

FROM node:22-alpine AS manifests
WORKDIR /app
COPY package.json package-lock.json tsconfig.base.json ./
COPY packages/domain/package.json packages/domain/
COPY packages/schemas/package.json packages/schemas/
COPY packages/ui/package.json packages/ui/
COPY packages/broker/package.json packages/broker/
COPY packages/policy/package.json packages/policy/
COPY packages/test-fixtures/package.json packages/test-fixtures/
COPY packages/db/package.json packages/db/
COPY packages/queue/package.json packages/queue/
COPY packages/provider-meta/package.json packages/provider-meta/
COPY apps/api/package.json apps/api/
COPY apps/worker/package.json apps/worker/
COPY apps/web/package.json apps/web/

# ---------------------------------------------------------------------------
# Full install (dev + prod) — build, typecheck and test only.
# ---------------------------------------------------------------------------
FROM manifests AS deps-full
RUN npm ci --no-audit --no-fund

FROM deps-full AS build
COPY . .
RUN npm run typecheck

FROM build AS web-build
ENV NEXT_TELEMETRY_DISABLED=1
RUN npm run build -w @permitzero/web

# ---------------------------------------------------------------------------
# Prod-only install — what the long-running containers carry.
# ---------------------------------------------------------------------------
FROM manifests AS deps-prod
RUN npm ci --omit=dev --no-audit --no-fund

FROM node:22-alpine AS server-base
ENV NODE_ENV=production
WORKDIR /app
COPY --from=deps-prod /app/node_modules ./node_modules
COPY package.json package-lock.json tsconfig.base.json ./
COPY packages ./packages
# The migration runner reads these SQL files at boot; without them `migrate`
# dies with ENOENT and nothing downstream can start.
COPY infra/migrations ./infra/migrations
COPY apps/api/package.json apps/api/
COPY apps/worker/package.json apps/worker/
RUN addgroup -S permitzero 2>/dev/null; adduser -S -G permitzero permitzero 2>/dev/null; \
    chown -R permitzero:permitzero /app
USER permitzero

FROM server-base AS api
COPY apps/api ./apps/api
EXPOSE 3000
WORKDIR /app/apps/api
CMD ["node", "/app/node_modules/.bin/tsx", "src/server.ts"]

FROM server-base AS worker
COPY apps/worker ./apps/worker
WORKDIR /app/apps/worker
CMD ["node", "/app/node_modules/.bin/tsx", "src/main.ts"]

# One-shot: migrate, and optionally seed when PZ_SEED=1. Runs as root because
# the seed writes storage/demo-credentials.json into a bind-mounted directory.
FROM server-base AS migrate
COPY apps/api ./apps/api
USER root
ENV PZ_SEED=0
CMD ["sh", "-c", "cd /app/packages/db && node /app/node_modules/.bin/tsx src/cli.ts migrate && if [ \"$PZ_SEED\" = \"1\" ]; then node /app/node_modules/.bin/tsx src/cli.ts seed; fi"]

# ---------------------------------------------------------------------------
# Next.js standalone server: traced, self-contained, no dev dependencies.
# ---------------------------------------------------------------------------
FROM node:22-alpine AS web
ENV NODE_ENV=production NEXT_TELEMETRY_DISABLED=1 PORT=3000 HOSTNAME=0.0.0.0
WORKDIR /app
COPY --from=web-build /app/apps/web/.next/standalone ./
COPY --from=web-build /app/apps/web/.next/static ./apps/web/.next/static
EXPOSE 3000
CMD ["node", "apps/web/server.js"]
