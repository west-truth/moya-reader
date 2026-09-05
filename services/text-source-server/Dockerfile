FROM node:22-alpine
WORKDIR /app
COPY package.json package-lock.json ./
RUN npm ci --omit=dev --ignore-scripts --no-audit --no-fund && npm cache clean --force
COPY --chown=node:node src ./src
COPY --chown=node:node scripts/init.mjs scripts/check.mjs ./scripts/
USER node
ENV HOST=0.0.0.0 PORT=9970 CATALOG_FILE=/data/catalog.json SOURCE_ROOT=/data/content
EXPOSE 9970
CMD ["node", "src/server.mjs"]
