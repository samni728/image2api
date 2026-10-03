#!/usr/bin/env bash
set -u
ROOT="$(cd "$(dirname "$0")" && pwd)"
cd "$ROOT"
PID_FILE="$ROOT/run/service.pid"
LOG_FILE="$ROOT/logs/service.log"
ENV_FILE="$ROOT/.env"
mkdir -p "$ROOT/run" "$ROOT/logs"

get_env() { grep -E "^$1=" "$ENV_FILE" 2>/dev/null | tail -1 | cut -d= -f2-; }
set_env() {
  local k="$1" v="$2"
  python3 - "$ENV_FILE" "$k" "$v" <<'PY'
from pathlib import Path
import sys
p=Path(sys.argv[1]); k=sys.argv[2]; v=sys.argv[3]
lines=p.read_text().splitlines() if p.exists() else []
out=[]; found=False
for line in lines:
    if line.startswith(k+'='):
        out.append(f'{k}={v}'); found=True
    else: out.append(line)
if not found: out.append(f'{k}={v}')
p.write_text('\n'.join(out)+'\n')
PY
}

is_alive() {
  [[ -f "$PID_FILE" ]] || return 1
  local pid; pid="$(cat "$PID_FILE" 2>/dev/null || true)"
  [[ -n "$pid" ]] && kill -0 "$pid" 2>/dev/null
}
port_in_use() { lsof -nP -iTCP:"$1" -sTCP:LISTEN >/dev/null 2>&1; }
choose_port() {
  local port; port="$(get_env PORT)"; [[ "$port" =~ ^[0-9]+$ ]] || port=3811
  if port_in_use "$port"; then
    for p in $(seq 3811 3899); do
      if ! port_in_use "$p"; then port="$p"; break; fi
    done
    set_env PORT "$port"
    echo "[port] 原端口被占用，已切换到 $port"
  fi
  echo "$port"
}

build() {
  echo "[build] TypeScript 编译中..."
  npm run build || return 1
}

start() {
  if is_alive; then echo "[running] PID $(cat "$PID_FILE")"; return 0; fi
  rm -f "$PID_FILE"
  local port; port="$(choose_port | tail -1)"
  build || return 1
  echo "[start] http://127.0.0.1:$port"
  # Detach the process group as well as stdio so terminal/tool shutdown cannot
  # terminate the service after this launcher exits.
  local pid
  pid="$(python3 - "$ROOT" "$LOG_FILE" <<'PY'
from pathlib import Path
import subprocess
import sys
root = Path(sys.argv[1])
with open(sys.argv[2], 'ab', buffering=0) as log:
    process = subprocess.Popen(
        ['node', str(root / 'dist/index.js')],
        cwd=root,
        stdin=subprocess.DEVNULL,
        stdout=log,
        stderr=subprocess.STDOUT,
        start_new_session=True,
    )
print(process.pid)
PY
)" || return 1
  echo "$pid" > "$PID_FILE"
  for _ in $(seq 1 30); do
    sleep 0.5
    if curl -fsS "http://127.0.0.1:$port/healthz" >/dev/null 2>&1; then
      echo "[ok] 已启动 PID=$pid PORT=$port"
      echo "[log] $LOG_FILE"
      return 0
    fi
    kill -0 "$pid" 2>/dev/null || break
  done
  echo "[error] 启动失败，最近日志："
  tail -n 50 "$LOG_FILE" 2>/dev/null || true
  return 1
}

stop() {
  if ! is_alive; then rm -f "$PID_FILE"; echo "[stopped] 当前未运行"; return 0; fi
  local pid; pid="$(cat "$PID_FILE")"
  echo "[stop] PID=$pid"
  kill "$pid" 2>/dev/null || true
  for _ in $(seq 1 20); do
    sleep 0.25
    kill -0 "$pid" 2>/dev/null || { rm -f "$PID_FILE"; echo "[ok] 已停止"; return 0; }
  done
  kill -9 "$pid" 2>/dev/null || true
  rm -f "$PID_FILE"
  echo "[ok] 已强制停止"
}

status() {
  local port; port="$(get_env PORT)"
  if is_alive; then
    echo "[running] PID=$(cat "$PID_FILE") PORT=$port"
    curl -fsS "http://127.0.0.1:$port/healthz" 2>/dev/null || true
    echo
  else
    echo "[stopped] PORT=$port"
  fi
  echo "Project: $(get_env CHATGPT_PROJECT_NAME)"
  echo "Project ID: $(get_env CHATGPT_PROJECT_ID)"
}

logs() { touch "$LOG_FILE"; tail -n 100 -f "$LOG_FILE"; }
health() {
  local port; port="$(get_env PORT)"
  echo "healthz:"; curl -sS "http://127.0.0.1:$port/healthz"; echo
  echo "readyz:"; curl -sS "http://127.0.0.1:$port/readyz"; echo
}

menu() {
  while true; do
    echo
    echo "===== Web to API Image ====="
    echo "1) 启动"
    echo "2) 重启"
    echo "3) 停止"
    echo "4) 状态"
    echo "5) 实时日志"
    echo "6) Health / Ready 检查"
    echo "7) 编译"
    echo "0) 退出"
    read -r -p "请选择: " c
    case "$c" in
      1) start;; 2) stop; start;; 3) stop;; 4) status;; 5) logs;; 6) health;; 7) build;; 0) exit 0;; *) echo "无效选择";;
    esac
  done
}

case "${1:-menu}" in
  start) start;; restart) stop; start;; stop) stop;; status) status;; logs|log) logs;; health|ready) health;; build) build;; menu) menu;; *) echo "用法: $0 {start|restart|stop|status|logs|health|build|menu}"; exit 2;;
esac
