FROM node:22-bookworm-slim AS build
WORKDIR /app
COPY package.json pnpm-lock.yaml ./
RUN corepack enable && pnpm install --frozen-lockfile
COPY tsconfig.json build.mjs ./
COPY *.ts ./
RUN pnpm run build

FROM node:22-bookworm-slim AS runtime
WORKDIR /app
ENV NODE_ENV=production
# Bound to every interface because a container that only answers on loopback
# answers nothing. The adapter holds no credential, so this exposes no secret.
ENV HOST=0.0.0.0
ENV PORT=8080

RUN groupadd --system lnkz && useradd --system --gid lnkz --home-dir /app --shell /usr/sbin/nologin lnkz
COPY --from=build --chown=lnkz:lnkz /app/package.json /app/pnpm-lock.yaml ./
RUN corepack enable && pnpm install --prod --frozen-lockfile
COPY --from=build --chown=lnkz:lnkz /app/dist ./dist

# No volume and no writable state. The adapter stores nothing between
# requests, which is what makes it safe to run several of and to restart
# without ceremony.
USER lnkz
EXPOSE 8080
CMD ["node", "--enable-source-maps", "dist/http-main.mjs"]
