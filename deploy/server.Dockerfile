FROM node:22-bookworm-slim AS build

WORKDIR /workspace
RUN corepack enable

COPY package.json pnpm-lock.yaml pnpm-workspace.yaml ./
COPY apps/server/package.json apps/server/package.json
COPY packages/contracts/package.json packages/contracts/package.json
COPY packages/extension-contracts/package.json packages/extension-contracts/package.json
COPY packages/epub-core/package.json packages/epub-core/package.json
COPY packages/fixed-document-core/package.json packages/fixed-document-core/package.json
COPY packages/text-core/package.json packages/text-core/package.json
RUN pnpm install --frozen-lockfile

COPY apps/server apps/server
COPY packages/contracts packages/contracts
COPY packages/extension-contracts packages/extension-contracts
COPY packages/epub-core packages/epub-core
COPY packages/fixed-document-core packages/fixed-document-core
COPY packages/text-core packages/text-core
COPY src src
RUN pnpm --filter server build && pnpm --filter server bundle

FROM build AS production-dependencies
RUN pnpm --config.inject-workspace-packages=true --filter server deploy --prod /opt/server

FROM node:22-bookworm-slim AS runtime

ENV NODE_ENV=production
WORKDIR /app

RUN mkdir -p /data/server && chown node:node /data/server

COPY --from=production-dependencies --chown=node:node /opt/server/node_modules ./node_modules
COPY --from=build --chown=node:node /workspace/apps/server/package.json ./package.json
COPY --from=build --chown=node:node /workspace/apps/server/dist ./dist

USER node
EXPOSE 8787
CMD ["node", "dist/index.js"]
