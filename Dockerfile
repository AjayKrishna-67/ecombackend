# syntax=docker/dockerfile:1

############################################
# Stage 1 — Build (server + admin UI + dashboard)
############################################
FROM node:22-alpine AS builder
WORKDIR /app

# Toolchain for native modules (node-gyp) + bun as the package manager.
# bun is installed via npm so we keep Node 22 for a matching runtime ABI.
RUN apk add --no-cache python3 make g++ \
 && npm install -g bun@1.3.7

# Install ALL dependencies (dev deps needed for the build) from the committed
# bun lockfile for reproducible builds.
COPY package.json bun.lock ./
RUN bun install --frozen-lockfile

# Only the sources needed to build
COPY tsconfig*.json vite.config.mts ./
COPY src ./src
COPY static ./static

# Compile in order:
#   1. build          -> tsc (server/worker) into dist/
#   2. build:admin    -> compile Admin UI extensions into ./admin-ui
#   3. build:dashboard-> vite build of the React dashboard into dist/dashboard
#   4. admin-ui build -> produce the Angular bundle in ./admin-ui/dist
RUN bun run build \
 && bun run build:admin \
 && bun run build:dashboard \
 && cd admin-ui && bun install && bun run build

# Fail the build early if any expected artefact is missing
RUN test -f dist/src/index.js \
 && test -f dist/src/index-worker.js \
 && test -f admin-ui/dist/browser/index.html \
 && test -d static/email/templates/partials

############################################
# Stage 2 — Production dependencies only
############################################
FROM node:22-alpine AS prod-deps
WORKDIR /app

# Same toolchain so any native prod module compiles against this exact musl/ABI
RUN apk add --no-cache python3 make g++ \
 && npm install -g bun@1.3.7

COPY package.json bun.lock ./
RUN bun install --frozen-lockfile --production

# --- Slim the production dependency tree (safe, runtime-only pruning) ---
# aws-sdk v2 is unused in this codebase (only @aws-sdk v3 is imported).
RUN rm -rf node_modules/aws-sdk
# Strip docs, tests, type-defs and source-maps that are never needed at runtime.
RUN find node_modules -type d \
      \( -name test -o -name tests -o -name __tests__ -o -name docs -o -name doc \
       -o -name example -o -name examples -o -name coverage -o -name .github \
       -o -name .nyc_output -o -name .idea -o -name .vscode \) \
      -prune -exec rm -rf {} + 2>/dev/null || true
RUN find node_modules -type f \
      \( -name '*.md' -o -name '*.markdown' -o -name '*.map' -o -name '*.ts' \
       -o -name '*.tsx' -o -name '*.flow' -o -name '*.d.ts' -o -name 'CHANGELOG*' \
       -o -name 'AUTHORS*' -o -name '.npmignore' -o -name '.eslintrc*' \
       -o -name '.prettierrc*' -o -name '.editorconfig' -o -name 'tsconfig*.json' \) \
      -delete 2>/dev/null || true

############################################
# Stage 3 — Runtime (small, non-root)
############################################
FROM node:22-alpine AS runner
WORKDIR /app

# Production defaults. PORT matches apiOptions.port in vendure-config.ts.
# 768MB heap keeps V8 under a 1Gi container limit (default is only ~512MB).
ENV NODE_ENV=production \
    PORT=8000 \
    NODE_OPTIONS=--max-old-space-size=768

# tini => proper PID 1: signal forwarding + zombie reaping under Kubernetes
RUN apk add --no-cache tini

# Production-only node_modules (no dev deps, built for this exact ABI/musl)
COPY --from=prod-deps /app/node_modules ./node_modules

# Compiled server/worker, client bundles, email templates & assets
COPY --from=builder /app/package.json ./package.json
COPY --from=builder /app/dist ./dist
COPY --from=builder /app/admin-ui/dist ./dist/admin-ui/dist
COPY --from=builder /app/static ./static
COPY --from=builder /app/static ./dist/static

# Writable runtime dirs owned by the unprivileged `node` user:
#  - AdminUiPlugin/DashboardPlugin rewrite index.html + ui-config on boot
#  - AssetServerPlugin writes a local image-transform cache under dist/src/assets
#    (originals live in S3; this is just an ephemeral cache — mount a volume here
#     in production if you want it to persist across restarts).
RUN mkdir -p static/product-exports dist/static/product-exports dist/src/assets/cache \
 && chown -R node:node static dist/static dist/admin-ui dist/dashboard dist/src/assets

USER node
EXPOSE 8000

# App serves /health on $PORT (busybox wget ships in alpine)
HEALTHCHECK --interval=30s --timeout=5s --start-period=40s --retries=3 \
  CMD wget -q --spider "http://127.0.0.1:${PORT}/health" || exit 1

# Kubernetes manages restarts/scaling — no PM2 needed.
# Run the WORKER in a separate deployment by overriding the command with:
#   ["node", "dist/src/index-worker.js"]
ENTRYPOINT ["/sbin/tini", "--"]
CMD ["node", "dist/src/index.js"]
