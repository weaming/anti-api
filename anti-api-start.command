#!/bin/bash
cd "$(dirname "$0")"

# 颜色定义 #C15F3C
ORANGE='\033[38;2;193;95;60m'
NC='\033[0m'

echo ""
echo -e "${ORANGE}  █████╗ ███╗   ██╗████████╗██╗         █████╗ ██████╗ ██╗${NC}"
echo -e "${ORANGE} ██╔══██╗████╗  ██║╚══██╔══╝██║        ██╔══██╗██╔══██╗██║${NC}"
echo -e "${ORANGE} ███████║██╔██╗ ██║   ██║   ██║ █████╗ ███████║██████╔╝██║${NC}"
echo -e "${ORANGE} ██╔══██║██║╚██╗██║   ██║   ██║ ╚════╝ ██╔══██║██╔═══╝ ██║${NC}"
echo -e "${ORANGE} ██║  ██║██║ ╚████║   ██║   ██║        ██║  ██║██║     ██║${NC}"
echo -e "${ORANGE} ╚═╝  ╚═╝╚═╝  ╚═══╝   ╚═╝   ╚═╝        ╚═╝  ╚═╝╚═╝     ╚═╝${NC}"
echo ""

PORT=8964
RUST_PROXY_PORT=8965

# 静默释放端口
lsof -ti :$PORT | xargs kill -9 2>/dev/null
lsof -ti :$RUST_PROXY_PORT | xargs kill -9 2>/dev/null

# 加载 bun 路径（如果已安装）
export BUN_INSTALL="$HOME/.bun"
export PATH="$BUN_INSTALL/bin:$PATH"

# 检查 bun
if ! command -v bun &> /dev/null; then
    echo "安装 Bun..."
    curl -fsSL https://bun.sh/install | bash
    source "$HOME/.bun/bun.sh" 2>/dev/null || true
fi

# 安装依赖
if [ ! -d "node_modules" ]; then
    bun install --silent
fi

# 🦀 启动 Rust Proxy (静默)
RUST_PROXY_BIN="./rust-proxy/target/release/anti-proxy"
if [ ! -f "$RUST_PROXY_BIN" ]; then
    if command -v cargo &> /dev/null; then
        cargo build --release --manifest-path rust-proxy/Cargo.toml 2>/dev/null
    fi
fi

if [ -f "$RUST_PROXY_BIN" ]; then
    $RUST_PROXY_BIN >/dev/null 2>&1 &
    RUST_PID=$!
    sleep 1
fi

# 启动 TypeScript 服务器
bun run src/main.ts start

# 清理 Rust Proxy
if [ ! -z "$RUST_PID" ]; then
    kill $RUST_PID 2>/dev/null
fi
