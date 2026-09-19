FROM node:22-bookworm-slim AS build
WORKDIR /app
COPY package.json pnpm-lock.yaml ./
RUN corepack enable && pnpm install --frozen-lockfile
COPY tsconfig.json build.mjs ./
COPY *.ts ./
# Subdirectories are listed one by one because COPY *.ts does not descend,
# and a build that silently omits a directory fails at import time in the
# runtime stage rather than here.
COPY llm ./llm
COPY catalog ./catalog
RUN pnpm run build

FROM node:22-bookworm-slim AS runtime
WORKDIR /app
ENV NODE_ENV=production
# Bound to every interface because a container that only answers on loopback
# answers nothing. The adapter holds no credential, so this exposes no secret.
ENV HOST=0.0.0.0
ENV PORT=8080

RUN groupadd --system magentic && useradd --system --gid magentic --home-dir /app --shell /usr/sbin/nologin magentic
COPY --from=build --chown=magentic:magentic /app/package.json /app/pnpm-lock.yaml ./
RUN corepack enable && pnpm install --prod --frozen-lockfile
COPY --from=build --chown=magentic:magentic /app/dist ./dist

# Agent definitions are read at boot rather than bundled, so that a deployment
# can host a different set without rebuilding the adapter. Named explicitly so
# that a directory that failed to copy stops the container instead of quietly
# serving an empty catalog.
COPY --chown=magentic:magentic agents ./agents
ENV MAGENTIC_AGENTS_DIR=/app/agents

# No volume and no writable state. The adapter stores nothing between
# requests, which is what makes it safe to run several of and to restart
# without ceremony.
USER magentic
EXPOSE 8080
CMD ["node", "--enable-source-maps", "dist/http-main.mjs"]
