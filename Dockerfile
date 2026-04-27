FROM node:20-bookworm-slim

WORKDIR /app

# Dependencies first for cacheable layer.
COPY package.json package-lock.json ./
RUN npm ci

# Source. `sandbox/` is needed at runtime — manager.ts reads it for seed
# editor buffers and bakes sandbox/package.json into the Daytona image.
COPY tsconfig.json ./
COPY src ./src
COPY sandbox ./sandbox

ENV NODE_ENV=production
ENV PORT=8000
ENV HOST=0.0.0.0
EXPOSE 8000

CMD ["npx", "tsx", "src/server.ts"]
