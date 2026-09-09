#!/usr/bin/env bash
# start-scrubbing.sh — Inicia Harmony MCP + DCD MCP para uso com Joule Desktop
#
# Uso:
#   ./start-scrubbing.sh
#   npm run start:scrubbing
#
# Após subir, configure o Joule Desktop com:
#   http://localhost:8810/mcp  (Harmony — quotes, opps, CPQ, RenewalExecution)
#   http://localhost:8811/mcp  (DCD — contratos, cláusulas, PDFs)

set -euo pipefail
ROOT="$(cd "$(dirname "$0")" && pwd)"

# ── Matar processos anteriores nas portas (se houver) ─────────────────────────
for PORT in 8810 8811; do
  PID=$(lsof -ti :"$PORT" 2>/dev/null || true)
  if [ -n "$PID" ]; then
    echo "[scrubbing] Porta $PORT em uso (PID $PID) — encerrando..."
    kill "$PID" 2>/dev/null || true
    sleep 0.5
  fi
done

# ── Iniciar servidores ────────────────────────────────────────────────────────
node "$ROOT/packages/servers/sap-harmony-mcp/src/mcp-server-http.mjs" &
HARMONY_PID=$!

node "$ROOT/packages/servers/sap-dcd-mcp/src/mcp-server-http.mjs" &
DCD_PID=$!

# ── Cleanup no Ctrl+C ─────────────────────────────────────────────────────────
cleanup() {
  echo ""
  echo "[scrubbing] Encerrando servidores (Harmony PID $HARMONY_PID, DCD PID $DCD_PID)..."
  kill "$HARMONY_PID" "$DCD_PID" 2>/dev/null || true
  exit 0
}
trap cleanup INT TERM

# ── Banner ────────────────────────────────────────────────────────────────────
sleep 1  # aguarda os servidores imprimirem seus banners
echo ""
echo "╔══════════════════════════════════════════════════════╗"
echo "║        SAP Scrubbing MCP Servers — ativos            ║"
echo "╠══════════════════════════════════════════════════════╣"
echo "║  Harmony  →  http://localhost:8810/mcp               ║"
echo "║  DCD      →  http://localhost:8811/mcp               ║"
echo "╠══════════════════════════════════════════════════════╣"
echo "║  Configure o Joule Desktop com as URLs acima.        ║"
echo "║  Pressione Ctrl+C para encerrar ambos os servidores. ║"
echo "╚══════════════════════════════════════════════════════╝"
echo ""

wait
