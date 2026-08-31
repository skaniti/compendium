# Next.js production image for apps/web.
#
# Build context is the REPO ROOT, not apps/web — npm workspaces need the
# root package.json + package-lock.json alongside apps/web's own manifest to
# resolve. Root docker-compose.yml's `web` service sets
# `build.context: .` + `build.dockerfile: apps/web/Dockerfile` accordingly.
#
#   docker compose build web        # from the repo root
#   docker build -f apps/web/Dockerfile -t compendium-web .   # standalone
#
# Multi-stage: deps (npm ci) -> builder (`next build`, output: "standalone"
# per next.config.ts) -> runner (traced server.js + node_modules only — no
# devDependencies, no source tree, no other workspace).
#
# `output: "standalone"` places the traced server + hoisted node_modules at
# the MONOREPO ROOT of the standalone tree (i.e. `.next/standalone/apps/web/
# server.js` + `.next/standalone/node_modules/`), not inside apps/web/ —
# verified by building locally and inspecting the tree (batch-07 Task 4).
# Static assets (`apps/web/.next/static`) and `apps/web/public` are excluded
# from standalone output by design and must be copied in separately.

FROM node:22-slim AS deps
WORKDIR /repo
COPY package.json package-lock.json ./
COPY apps/web/package.json ./apps/web/package.json
RUN npm ci

FROM node:22-slim AS builder
WORKDIR /repo
# next.config.ts resolves BACKEND_URL at BUILD time for the
# /captured-assets/* rewrite destination (the /api/* proxy route handlers
# read it at runtime instead) — so the builder must be told the compose-
# network address, or the image bakes the localhost default.
ARG BACKEND_URL=http://localhost:8001
ENV BACKEND_URL=$BACKEND_URL
COPY --from=deps /repo/node_modules ./node_modules
COPY . .
RUN npm run build -w apps/web

FROM node:22-slim AS runner
WORKDIR /repo
ENV NODE_ENV=production \
    PORT=3000 \
    HOSTNAME=0.0.0.0
COPY --from=builder /repo/apps/web/.next/standalone ./
COPY --from=builder /repo/apps/web/.next/static ./apps/web/.next/static
COPY --from=builder /repo/apps/web/public ./apps/web/public

EXPOSE 3000

CMD ["node", "apps/web/server.js"]
