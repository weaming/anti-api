ARG BUN_IMAGE=oven/bun:1.1.38
FROM ${BUN_IMAGE}

WORKDIR /app

RUN apt-get update && apt-get install -y --no-install-recommends \
    python3 make g++ curl ca-certificates \
    && rm -rf /var/lib/apt/lists/*

ENV NODE_ENV=production

# 1. Only install native dependencies in the container
# 1. Install dependencies
COPY package.json bun.lock ./
RUN bun install --production --frozen-lockfile

# 2. Build the application
COPY tsconfig.json ./
COPY src ./src
RUN bun run build

COPY public ./public


ENV HOME=/app/data

RUN mkdir -p /app/data

EXPOSE 8964 8965

CMD ["bun", "run", "dist/main.js", "start"]
