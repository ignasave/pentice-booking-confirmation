# syntax=docker/dockerfile:1
# Build context is the repository root: the lockfile and the shared package live there.
#   docker build -f apps/booking-service/Dockerfile .

FROM node:24-alpine AS workspace
WORKDIR /repo
RUN corepack enable
COPY package.json pnpm-lock.yaml pnpm-workspace.yaml ./
COPY apps/booking-service/package.json apps/booking-service/
COPY apps/guest-simulator/package.json apps/guest-simulator/
COPY packages/shared/package.json packages/shared/

FROM workspace AS build
# --ignore-scripts: the root "prepare" script installs git hooks, and the image has no git.
RUN pnpm install --frozen-lockfile --ignore-scripts
COPY tsconfig.base.json ./
COPY packages/shared/src packages/shared/src
COPY apps/booking-service/tsconfig.json apps/booking-service/
COPY apps/booking-service/src apps/booking-service/src
RUN pnpm --filter @pentice/booking-service build

FROM workspace AS production-dependencies
RUN pnpm install --frozen-lockfile --ignore-scripts --prod --filter @pentice/booking-service

FROM node:24-alpine
ENV NODE_ENV=production DATA_DIR=/data
# A named volume mounted here takes its ownership from this directory on first use.
RUN mkdir /data && chown node:node /data
# pnpm links each dependency into the app's node_modules by a relative path into the
# workspace store, so both keep the places they have in the repository.
WORKDIR /app/apps/booking-service
COPY --from=production-dependencies /repo/node_modules /app/node_modules
COPY --from=production-dependencies /repo/apps/booking-service/node_modules node_modules
COPY --from=build /repo/apps/booking-service/dist dist
USER node
EXPOSE 3000
# Exec form, so node is PID 1 and receives SIGTERM itself.
CMD ["node", "--enable-source-maps", "dist/main.js"]
