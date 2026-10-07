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
# `npm ci` runs the root `prepare` script, `node .husky/install.mjs` (git-hook
# setup). Copy the shim so node can find it; HUSKY=0 makes it exit at once,
# since an image has no git hooks to install.
COPY .husky/install.mjs ./.husky/install.mjs
ENV HUSKY=0
RUN npm ci

FROM node:22-slim AS builder
WORKDIR /repo
# NEXT_PUBLIC_* values are inlined into the client bundle by `next build`, so
# they must exist at BUILD time. The server compose passes
# NEXT_PUBLIC_DEMO_ROLE_TOOLING=1 for the tailnet-only owner stack (view-as
# buttons); empty means off. BACKEND_URL is read at RUN time by the route
# handlers (lib/backend-proxy.ts, the auth routes, the captured-assets
# route); the build arg only keeps root docker-compose.yml's existing
# `args:` working and gives `next build`'s prerender pass a value.
ARG NEXT_PUBLIC_DEMO_ROLE_TOOLING=""
ENV NEXT_PUBLIC_DEMO_ROLE_TOOLING=$NEXT_PUBLIC_DEMO_ROLE_TOOLING
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
