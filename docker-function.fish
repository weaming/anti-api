function docker-run-anti-api
    if docker ps -a --format '{{.Names}}' | grep -q '^anti-api$'
        echo "Stopping and removing existing anti-api container..."
        docker stop anti-api >/dev/null
        docker rm anti-api >/dev/null
    end

    set -l PORT 8964
    echo "Starting anti-api (Docker, port $PORT)..."
    docker run -d \
        --name anti-api \
        -p 8964:8964 \
        -p 51121:51121 \
        -e ANTI_API_DATA_DIR=/app/data \
        -e ANTI_API_OAUTH_NO_OPEN=1 \
        -e ANTI_API_NO_OPEN=1 \
        -v "$HOME/.anti-api:/app/data" \
        -v "./src:/app/src" \
        -v "./public:/app/public" \
        --restart unless-stopped \
        weaming/anti-api

    if test $status -ne 0
        echo "Failed to start Docker service." >&2
        return 1
    end

    echo "Panel: http://localhost:$PORT/quota"
end
