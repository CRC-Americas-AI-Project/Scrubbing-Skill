#!/usr/bin/env bash
# start-scrubbing.sh — Inicia Harmony MCP + DCD MCP + Scrubbing MCP unificado
#
# Uso:
#   ./start-scrubbing.sh              # sobe os 3 servidores
#   ./start-scrubbing.sh --unified    # sobe apenas o servidor unificado (porta 8812)
#   npm run start:scrubbing
#
# Endpoints disponíveis:
#   http://localhost:8810/mcp  (Harmony — individual, mantido para compatibilidade)
#   http://localhost:8811/mcp  (DCD — individual, mantido para compatibilidade)
#   http://0.0.0.0:8812/mcp   (Scrubbing MCP unificado — multi-usuário, produção)
#
# Para servidor compartilhado, use apenas a porta 8812 e passe X-User-Id no header.

set -euo pipefail
ROOT="$(cd "$(dirname "$0")" && pwd)"

UNIFIED_ONLY=false
for arg in "$@"; do
  [ "$arg" = "--unified" ] && UNIFIED_ONLY=true
done

# ── Matar processos anteriores nas portas (se houver) ─────────────────────────
if [ "$UNIFIED_ONLY" = true ]; then
  PORTS=(8812)
else
  PORTS=(8810 8811 8812)
fi

for PORT in "${PORTS[@]}"; do
  PID=$(lsof -ti :"$PORT" 2>/dev/null || true)
  if [ -n "$PID" ]; then
    echo "[scrubbing] Porta $PORT em uso (PID $PID) — encerrando..."
    kill "$PID" 2>/dev/null || true
    sleep 0.5
  fi
done

# ── Iniciar servidores ────────────────────────────────────────────────────────
PIDS=()

if [ "$UNIFIED_ONLY" = false ]; then
  node "$ROOT/packages/servers/sap-harmony-mcp/src/mcp-server-http.mjs" &
  PIDS+=($!)

  node "$ROOT/packages/servers/sap-dcd-mcp/src/mcp-server-http.mjs" &
  PIDS+=($!)
fi

node "$ROOT/packages/servers/scrubbing-mcp/src/mcp-server-http.mjs" &
PIDS+=($!)

# ── Cleanup no Ctrl+C ─────────────────────────────────────────────────────────
cleanup() {
  echo ""
  echo "[scrubbing] Encerrando servidores (PIDs: ${PIDS[*]})..."
  kill "${PIDS[@]}" 2>/dev/null || true
  exit 0
}
trap cleanup INT TERM

# ── Banner ────────────────────────────────────────────────────────────────────
sleep 1  # aguarda os servidores imprimirem seus banners
echo ""
if [ "$UNIFIED_ONLY" = true ]; then
  echo "╔══════════════════════════════════════════════════════╗"
  echo "║     SAP Scrubbing MCP — Servidor Unificado           ║"
  echo "╠══════════════════════════════════════════════════════╣"
  echo "║  Unified  →  http://0.0.0.0:8812/mcp                ║"
  echo "║  41 tools (Harmony + DCD) | multi-usuário           ║"
  echo "╠══════════════════════════════════════════════════════╣"
  echo "║  Passe X-User-Id: <i-number> em cada requisição.    ║"
  echo "║  Pressione Ctrl+C para encerrar.                    ║"
  echo "╚══════════════════════════════════════════════════════╝"
else
  echo "╔══════════════════════════════════════════════════════╗"
  echo "║        SAP Scrubbing MCP Servers — ativos            ║"
  echo "╠══════════════════════════════════════════════════════╣"
  echo "║  Harmony  →  http://localhost:8810/mcp               ║"
  echo "║  DCD      →  http://localhost:8811/mcp               ║"
  echo "║  Unified  →  http://0.0.0.0:8812/mcp  (produção)    ║"
  echo "╠══════════════════════════════════════════════════════╣"
  echo "║  Configure o Joule Desktop com as URLs acima.        ║"
  echo "║  Pressione Ctrl+C para encerrar todos os servidores. ║"
  echo "╚══════════════════════════════════════════════════════╝"
fi
echo ""

wait
