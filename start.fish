#!/usr/bin/env fish

set -l script_dir (cd (dirname (status -f)); and pwd)
cd $script_dir

# 颜色定义
set ORANGE \033\[38\;2\;193\;95\;60m
set NC \033\[0m

echo ""
echo -e "$ORANGE  █████╗ ███╗   ██╗████████╗██╗         █████╗ ██████╗ ██╗$NC"
echo -e "$ORANGE ██╔══██╗████╗  ██║╚══██╔══╝██║        ██╔══██╗██╔══██╗██║$NC"
echo -e "$ORANGE ███████║██╔██╗ ██║   ██║   ██║ █████╗ ███████║██████╔╝██║$NC"
echo -e "$ORANGE ██╔══██║██║╚██╗██║   ██║   ██║ ╚════╝ ██╔══██║██╔═══╝ ██║$NC"
echo -e "$ORANGE ██║  ██║██║ ╚████║   ██║   ██║        ██║  ██║██║     ██║$NC"
echo -e "$ORANGE ╚═╝  ╚═╝╚═╝  ╚═══╝   ╚═╝   ╚═╝        ╚═╝  ╚═╝╚═╝     ╚═╝$NC"
echo ""

set PORT 8964
set PID_DIR "$HOME/.anti-api"
set ANTI_API_PID "$PID_DIR/anti-api.pid"
set SETTINGS_FILE "$PID_DIR/settings.json"

mkdir -p "$PID_DIR"

# helper function to kill by pid with pattern check
function safe_kill_pid
    set pid $argv[1]
    set pattern $argv[2]
    if test -z "$pid"
        return
    end
    if not kill -0 "$pid" 2>/dev/null
        return
    end
    
    set cmd (ps -p "$pid" -o command= 2>/dev/null)
    if string match -q -r "$pattern" "$cmd"
        kill "$pid" 2>/dev/null
        for i in (seq 1 5)
            if not kill -0 "$pid" 2>/dev/null
                return
            end
            sleep 0.2
        end
        kill -9 "$pid" 2>/dev/null
    end
end

# helper function to kill by port
function safe_kill_by_port
    set port $argv[1]
    set pattern $argv[2]
    set pids (lsof -nP -iTCP:"$port" -sTCP:LISTEN -t 2>/dev/null)
    for pid in $pids
        safe_kill_pid "$pid" "$pattern"
    end
end

if test -f "$ANTI_API_PID"
    safe_kill_pid (cat "$ANTI_API_PID" 2>/dev/null) "anti-api|src/main.ts"
    rm -f "$ANTI_API_PID"
end
safe_kill_by_port "$PORT" "anti-api|src/main.ts"

# Setup Bun
set -x BUN_INSTALL "$HOME/.bun"
set -x PATH "$BUN_INSTALL/bin" $PATH

if not command -v bun >/dev/null
    echo "Installing Bun..."
    curl -fsSL https://bun.sh/install | bash
    # Source bun manually for this session if needed, but PATH update above should handle it
end

if not test -d "node_modules"
    bun install --silent
end

# Run API
function run_api_once
    bun run src/main.ts start &
    set api_pid $last_pid
    echo "$api_pid" > "$ANTI_API_PID"
    wait $api_pid
    return $status
end

# Auto-restart check
set AUTO_RESTART "false"
if test -f "$SETTINGS_FILE"; and command -v python3 >/dev/null
    set AUTO_RESTART (python3 -c "import json, os; print('true' if json.load(open(os.path.expanduser('~/.anti-api/settings.json'))).get('autoRestart') else 'false')")
end

if test "$AUTO_RESTART" = "true"
    echo "Auto Restart (Watchdog) enabled"
    while true
        run_api_once
        set exit_code $status
        if contains $exit_code 0 130 143
            break
        end
        echo "Server exited with code $exit_code. Restarting in 2s..."
        sleep 2
    end
else
    run_api_once
end
