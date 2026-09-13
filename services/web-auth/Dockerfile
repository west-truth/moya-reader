FROM node:22-slim
WORKDIR /app
COPY services/web-auth/package.json services/web-auth/package-lock.json ./
RUN npm ci --omit=dev --ignore-scripts && mkdir /data && chown node:node /data
COPY services/web-auth/app.mjs services/web-auth/google.mjs services/web-auth/index.mjs services/web-auth/store.mjs ./
COPY LICENSE THIRD_PARTY_NOTICES.md ./
USER node
ENV AUTH_HOST=0.0.0.0 AUTH_PORT=1432 AUTH_DB_PATH=/data/auth.sqlite
EXPOSE 1432
VOLUME /data
CMD ["node", "index.mjs"]
