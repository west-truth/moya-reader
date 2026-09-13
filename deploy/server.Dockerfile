FROM maven:3.9.11-eclipse-temurin-21 AS apk-build
RUN apt-get update && apt-get install -y --no-install-recommends python3 && rm -rf /var/lib/apt/lists/*
WORKDIR /workspace
COPY services/apk-worker services/apk-worker
RUN python3 services/apk-worker/build.py

FROM eclipse-temurin:21-jre-jammy AS apk-java

FROM node:22-bookworm-slim AS build

WORKDIR /workspace
RUN corepack enable

COPY package.json pnpm-lock.yaml pnpm-workspace.yaml ./
COPY apps/server/package.json apps/server/package.json
COPY packages/contracts/package.json packages/contracts/package.json
COPY packages/document-series-core/package.json packages/document-series-core/package.json
COPY packages/extension-contracts/package.json packages/extension-contracts/package.json
COPY packages/extension-runtime/package.json packages/extension-runtime/package.json
COPY packages/epub-core/package.json packages/epub-core/package.json
COPY packages/fixed-document-core/package.json packages/fixed-document-core/package.json
COPY packages/text-core/package.json packages/text-core/package.json
RUN pnpm install --frozen-lockfile

COPY apps/server apps/server
COPY packages/contracts packages/contracts
COPY packages/document-series-core packages/document-series-core
COPY packages/extension-contracts packages/extension-contracts
COPY packages/extension-runtime packages/extension-runtime
COPY packages/epub-core packages/epub-core
COPY packages/fixed-document-core packages/fixed-document-core
COPY packages/text-core packages/text-core
COPY src src
COPY services/apk-worker services/apk-worker
RUN pnpm --filter server build && pnpm --filter server bundle

FROM build AS production-dependencies
RUN pnpm --config.inject-workspace-packages=true --filter server deploy --prod /opt/server

FROM node:22-bookworm-slim AS runtime

RUN apt-get update && apt-get install -y --no-install-recommends chromium fonts-noto-cjk \
    && rm -rf /var/lib/apt/lists/*
ENV MOYA_SOURCE_BROWSER_EXECUTABLE=/usr/bin/chromium

ENV NODE_ENV=production
ENV MOYA_APK_RUNTIME_DIR=/opt/moya-apk
ENV MOYA_APK_JAVA=/opt/java/openjdk/bin/java
WORKDIR /app

RUN mkdir -p /data/server && chown node:node /data/server

COPY --from=production-dependencies --chown=node:node /opt/server/node_modules ./node_modules
COPY --from=build --chown=node:node /workspace/apps/server/package.json ./package.json
COPY --from=build --chown=node:node /workspace/apps/server/dist ./dist
COPY --from=apk-java /opt/java/openjdk /opt/java/openjdk
COPY --from=apk-build /workspace/services/apk-worker/build/target/apk-worker-0.1.0.jar /opt/moya-apk/target/apk-worker-0.1.0.jar
COPY --from=apk-build /workspace/services/apk-worker/build/dependencies /opt/moya-apk/dependencies
COPY --from=apk-build /workspace/services/apk-worker/build/src /opt/moya-apk/source
COPY --from=apk-build /workspace/services/apk-worker/build/UPSTREAM-LICENSE /opt/moya-apk/UPSTREAM-LICENSE
COPY --from=apk-build /workspace/services/apk-worker/build/build-inventory.json /opt/moya-apk/build-inventory.json
COPY services/apk-worker /opt/moya-apk/build-recipe/
COPY third_party/licenses/mangayomi-dom /app/licenses/mangayomi-dom
COPY THIRD_PARTY_NOTICES.md /app/THIRD_PARTY_NOTICES.md

USER node
EXPOSE 8787
CMD ["node", "dist/index.js"]
