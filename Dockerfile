FROM node:22-alpine
WORKDIR /app
COPY package.json package-lock.json ./
RUN npm ci --ignore-scripts --no-audit --no-fund
COPY . .
RUN mkdir -p /data && chown node:node /data
VOLUME ["/data"]
ENV OAF_HOST=0.0.0.0 OAF_PORT=4310 OAF_MODEL_MODE=deterministic OAF_ALLOW_NETWORK=false OAF_ALLOW_EXTERNAL_WRITES=false
EXPOSE 4310
USER node
CMD ["node","services/control-api/src/server.mjs"]
