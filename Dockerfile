FROM node:24.17-alpine AS base
RUN npm install -g npm@11.14.0 && npm cache clean --force

# Install dependencies only when needed
FROM base AS deps
WORKDIR /app
COPY package.json package-lock.json ./
COPY prisma ./prisma/
COPY prisma.config.ts ./
RUN --mount=type=cache,target=/root/.npm npm ci

# Build the application
FROM base AS builder
WORKDIR /app
COPY --from=deps /app/node_modules ./node_modules
COPY . .

ENV NEXT_TELEMETRY_DISABLED=1
ENV NODE_ENV=production
ENV DATABASE_URL=postgresql://tac:password@postgres:5432/tacbookings

# Stripe publishable key is delivered at runtime from the encrypted DB store
# (#2082), never inlined at build time — so no NEXT_PUBLIC_STRIPE_PUBLISHABLE_KEY
# build ARG/ENV here.

ARG NEXT_PUBLIC_SENTRY_DSN
ENV NEXT_PUBLIC_SENTRY_DSN=$NEXT_PUBLIC_SENTRY_DSN

# Deployed-code knowledge bundle (AID-3, #2372). Generated here in the builder,
# where the dependencies exist (a plain `docker compose build` on a club's
# server has no host Node/npm toolchain, so generation cannot run outside the
# image). The commit SHA is INJECTED at build time via GIT_COMMIT_SHA because
# `.git` is absent from the build context; KNOWLEDGE_BUNDLE_OBSERVED_AT pins the
# observed-at for a byte-reproducible artifact. Both are passed by CI / the
# deploy runner (see .github/workflows/ci.yml and
# scripts/run-production-blue-green-deploy.sh). When GIT_COMMIT_SHA is absent
# (a bare `docker build`), the generator writes a placeholder-SHA bundle that the
# runtime loader treats as UNVERIFIED and fail-closes on — the image still
# builds and runs, with diagnostics code answers disabled. Generation FAILS
# CLOSED on any detected secret, stopping the build rather than shipping a leak.
# `docs/` is available to this stage (see the .dockerignore note); the runtime
# image still excludes raw docs — only the curated bundle is copied to the runner.
ARG GIT_COMMIT_SHA=""
ENV GIT_COMMIT_SHA=$GIT_COMMIT_SHA
ARG KNOWLEDGE_BUNDLE_OBSERVED_AT=""
ENV KNOWLEDGE_BUNDLE_OBSERVED_AT=$KNOWLEDGE_BUNDLE_OBSERVED_AT
RUN npm run diagnostics:bundle

RUN npx prisma generate
RUN npm run build

# Production image
FROM node:24.17-alpine AS runner
WORKDIR /app

ENV NODE_ENV=production
ENV NEXT_TELEMETRY_DISABLED=1
ENV TZ=Pacific/Auckland

RUN apk add --no-cache aws-cli postgresql16-client
RUN rm -rf /usr/local/lib/node_modules/npm /usr/local/lib/node_modules/corepack \
  /usr/local/bin/npm /usr/local/bin/npx /usr/local/bin/corepack

RUN addgroup --system --gid 1001 nodejs
RUN adduser --system --uid 1001 nextjs

COPY --from=builder /app/public ./public
COPY --from=builder /app/.next/standalone ./
COPY --from=builder /app/.next/static/ ./.next/static/
COPY --from=builder /app/prisma ./prisma
COPY --from=builder /app/prisma.config.ts ./prisma.config.ts
COPY --from=builder /app/node_modules ./node_modules
# Guaranteed placement of the deployed-code knowledge bundle (AID-3, #2372)
# alongside the standalone trace, so the runtime loader
# (src/lib/diagnostics/knowledge/load.ts) finds it at
# /app/.artifacts/diagnostics/knowledge-bundle.json regardless of tracing. The
# builder's `npm run diagnostics:bundle` step above always writes this path (a
# real bundle, or a placeholder-SHA one the loader fail-closes on), so this COPY
# never fails.
COPY --from=builder /app/.artifacts ./.artifacts

RUN mkdir -p .next/cache && chown nextjs:nodejs .next/cache

# Image Manager uploads are written here at runtime. Create the directory owned
# by the app user so that a freshly-mounted named volume (docker-compose:
# image_uploads -> /app/public/images) inherits uid 1001 ownership on first init
# and is writable under the read-only container root filesystem.
RUN mkdir -p public/images && chown -R nextjs:nodejs public/images

USER nextjs

EXPOSE 3000

ENV PORT=3000
ENV HOSTNAME="0.0.0.0"

CMD ["node", "server.js"]
