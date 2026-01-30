#!/bin/bash
cd "$(dirname "$0")"

PORT=8964
BUILD_FLAG="--no-build"

for arg in "$@"; do
    if [ "$arg" = "--build" ] || [ "$arg" = "-b" ]; then
        BUILD_FLAG="--build"
    fi
done

if ! command -v docker >/dev/null 2>&1; then
    echo "Docker is not installed. Install Docker Desktop and try again."
    exit 1
fi

if ! docker info >/dev/null 2>&1; then
    echo "Docker daemon is not running. Start Docker Desktop and try again."
    exit 1
fi

COMPOSE_CMD=""
if docker compose version >/dev/null 2>&1; then
    COMPOSE_CMD="docker compose"
elif command -v docker-compose >/dev/null 2>&1; then
    COMPOSE_CMD="docker-compose"
fi

if [ -z "$COMPOSE_CMD" ]; then
    echo "Docker Compose is not available."
    exit 1
fi

if [ "$BUILD_FLAG" = "--build" ]; then
    echo "Running host build..."
    if command -v bun >/dev/null 2>&1; then
        bun run build
    else
        echo "Error: bun is not installed on host. Cannot run host build."
        exit 1
    fi
fi

echo "Starting anti-api (Docker, port ${PORT})..."
$COMPOSE_CMD up -d $BUILD_FLAG
if [ $? -ne 0 ]; then
    echo "Failed to start Docker service."
    exit 1
fi

echo "Panel: http://localhost:${PORT}/quota"
