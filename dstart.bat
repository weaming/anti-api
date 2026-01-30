@echo off
chcp 65001 >nul
setlocal enabledelayedexpansion
cd /d "%~dp0"

set "PORT=8964"
set "BUILD_FLAG=--no-build"

for %%A in (%*) do (
    if /i "%%A"=="--build" set "BUILD_FLAG=--build"
    if /i "%%A"=="-b" set "BUILD_FLAG=--build"
)

where docker >nul 2>&1
if %errorlevel% neq 0 (
    echo Docker is not installed. Install Docker Desktop and try again.
    exit /b 1
)

docker info >nul 2>&1
if %errorlevel% neq 0 (
    echo Docker daemon is not running. Start Docker Desktop and try again.
    exit /b 1
)

set "COMPOSE_CMD="
docker compose version >nul 2>&1
if %errorlevel% equ 0 (
    set "COMPOSE_CMD=docker compose"
) else (
    where docker-compose >nul 2>&1
    if %errorlevel% equ 0 (
        set "COMPOSE_CMD=docker-compose"
    )
)

if "%COMPOSE_CMD%"=="" (
    echo Docker Compose is not available.
    exit /b 1
)

if "%BUILD_FLAG%"=="--build" (
    echo Running host build...
    where bun >nul 2>&1
    if %errorlevel% equ 0 (
        call bun run build
    ) else (
        echo Error: bun is not installed on host. Cannot run host build.
        exit /b 1
    )
)

echo Starting anti-api (Docker, port %PORT%)...
%COMPOSE_CMD% up -d %BUILD_FLAG%
if %errorlevel% neq 0 (
    echo Failed to start Docker service.
    exit /b 1
)

echo Panel: http://localhost:%PORT%/quota
exit /b 0
