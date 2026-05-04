# syntax=docker/dockerfile:1
#
# Placeholder multi-stage build for the Colyseus server.
# NOT EXERCISED in this scaffold. `docker build` may need additional fixes
# (e.g. switching to `pnpm deploy` for a server-only artifact) before it
# works against a real registry. Revisit when wiring Fly.io deploy.

FROM node:20-alpine AS build
WORKDIR /app
RUN corepack enable && corepack prepare pnpm@9 --activate

COPY pnpm-workspace.yaml package.json pnpm-lock.yaml tsconfig.base.json tsconfig.json ./
COPY packages/shared/package.json ./packages/shared/
COPY packages/server/package.json ./packages/server/
COPY packages/client/package.json ./packages/client/

RUN pnpm install --frozen-lockfile --filter @mp/shared --filter @mp/server

COPY packages/shared ./packages/shared
COPY packages/server ./packages/server
RUN pnpm --filter @mp/server run build

FROM node:20-alpine AS runtime
WORKDIR /app
RUN corepack enable && corepack prepare pnpm@9 --activate

COPY --from=build /app/pnpm-workspace.yaml /app/package.json /app/pnpm-lock.yaml ./
COPY --from=build /app/packages/client/package.json ./packages/client/
COPY --from=build /app/packages/shared/package.json ./packages/shared/
COPY --from=build /app/packages/shared/dist ./packages/shared/dist
COPY --from=build /app/packages/server/package.json ./packages/server/
COPY --from=build /app/packages/server/dist ./packages/server/dist

RUN pnpm install --prod --frozen-lockfile --filter @mp/shared --filter @mp/server

ENV NODE_ENV=production
ENV PORT=2567
EXPOSE 2567
CMD ["node", "packages/server/dist/index.js"]
