FROM node:20.19.0-bookworm-slim AS build
WORKDIR /app
COPY package.json package-lock.json ./
RUN npm ci
COPY . .
RUN npm run build

FROM node:20.19.0-bookworm-slim AS runtime
ENV NODE_ENV=production
ENV SKIP_VITE=true
WORKDIR /app
COPY package.json package-lock.json ./
RUN npm ci --omit=dev && npm cache clean --force
COPY --from=build /app/dist ./dist
RUN groupadd --system trader && useradd --system --gid trader --home-dir /app trader \
  && mkdir -p /app/logs /app/incidents \
  && chown -R trader:trader /app
USER trader
EXPOSE 5000
HEALTHCHECK --interval=30s --timeout=5s --start-period=60s --retries=3 \
  CMD node -e "fetch('http://127.0.0.1:'+(process.env.PORT||5000)+'/api/health').then(r=>process.exit(r.ok?0:1)).catch(()=>process.exit(1))"
CMD ["node", "dist/index.cjs"]
