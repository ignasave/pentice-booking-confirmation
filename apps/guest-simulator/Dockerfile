# syntax=docker/dockerfile:1
# Build context is the repository root: the lockfile and the shared package live there.
#   docker build -f apps/guest-simulator/Dockerfile .

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
COPY apps/guest-simulator/tsconfig.json apps/guest-simulator/
COPY apps/guest-simulator/src apps/guest-simulator/src
RUN pnpm --filter @pentice/guest-simulator build

FROM workspace AS production-dependencies
RUN pnpm install --frozen-lockfile --ignore-scripts --prod --filter @pentice/guest-simulator

FROM node:24-alpine
ENV NODE_ENV=production DATA_DIR=/data
# A named volume mounted here takes its ownership from this directory on first use.
RUN mkdir /data && chown node:node /data
# pnpm links each dependency into the app's node_modules by a relative path into the
# workspace store, so both keep the places they have in the repository.
WORKDIR /app/apps/guest-simulator
COPY --from=production-dependencies /repo/node_modules /app/node_modules
COPY --from=production-dependencies /repo/apps/guest-simulator/node_modules node_modules
COPY --from=build /repo/apps/guest-simulator/dist dist
USER node
EXPOSE 3001
# Exec form, so node is PID 1 and receives SIGTERM itself.
CMD ["node", "--enable-source-maps", "dist/main.js"]
