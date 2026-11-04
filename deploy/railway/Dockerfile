FROM node:24-bookworm-slim AS build
RUN apt-get update && apt-get install -y --no-install-recommends python3 make g++ && rm -rf /var/lib/apt/lists/*
WORKDIR /app
COPY package.json ./
COPY vendor ./vendor
RUN npm install --omit=dev --legacy-peer-deps --no-audit --no-fund

FROM node:24-bookworm-slim
WORKDIR /app
ENV NODE_ENV=production
COPY --from=build /app/node_modules ./node_modules
COPY vendor ./vendor
COPY package.json start.sh ./
COPY dist ./dist
COPY seed ./seed
CMD ["sh", "start.sh"]
