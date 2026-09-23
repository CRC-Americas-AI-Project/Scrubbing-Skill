#!/usr/bin/env bash
# SAP Scrubbing MCP — Script de instalação (Mac/Linux)
# Uso: bash install.sh
# Ou diretamente: curl -fsSL <URL>/install.sh | bash

set -euo pipefail

INSTALL_DIR="$HOME/.sap-scrubbing"
REPO_URL="https://github.com/CRC-Americas-AI-Project/Scrubbing-Skill.git"

echo ""
echo "╔══════════════════════════════════════════════╗"
echo "║   SAP Scrubbing MCP — Instalador             ║"
echo "╚══════════════════════════════════════════════╝"
echo ""

# ── Verificar Node.js ─────────────────────────────────────────────────────────
echo "🔍 Verificando Node.js..."
if ! command -v node &>/dev/null; then
  echo ""
  echo "❌ Node.js não encontrado."
  echo "   Instale a versão 20 ou superior em: https://nodejs.org"
  echo ""
  exit 1
fi

NODE_VER=$(node -v | sed 's/v//' | cut -d. -f1)
if [ "$NODE_VER" -lt 20 ]; then
  echo ""
  echo "❌ Node.js v20+ necessário. Você tem: $(node -v)"
  echo "   Atualize em: https://nodejs.org"
  echo ""
  exit 1
fi

echo "   ✓ Node.js $(node -v)"
echo "   ✓ npm $(npm -v)"

# ── Clonar ou atualizar ───────────────────────────────────────────────────────
echo ""
if [ -d "$INSTALL_DIR/.git" ]; then
  echo "📦 Atualizando instalação existente em $INSTALL_DIR..."
  git -C "$INSTALL_DIR" pull --ff-only --quiet
else
  echo "📦 Baixando SAP Scrubbing MCP..."
  if command -v git &>/dev/null; then
    git clone --quiet "$REPO_URL" "$INSTALL_DIR"
  else
    echo "❌ git não encontrado. Instale o git e tente novamente."
    exit 1
  fi
fi

# ── Instalar dependências ─────────────────────────────────────────────────────
echo ""
echo "📥 Instalando dependências (pode demorar alguns minutos)..."
cd "$INSTALL_DIR"
npm install --silent

# ── Compilar pacotes compartilhados ──────────────────────────────────────────
echo "🔨 Compilando..."
npm run build:shared --silent 2>/dev/null || true

# ── Criar script de start ─────────────────────────────────────────────────────
START_SCRIPT="$HOME/.local/bin/sap-scrubbing"
mkdir -p "$(dirname "$START_SCRIPT")"
cat > "$START_SCRIPT" << EOF
#!/usr/bin/env bash
cd "$INSTALL_DIR"
exec node packages/servers/scrubbing-mcp/src/mcp-server-http.mjs "\$@"
EOF
chmod +x "$START_SCRIPT"

# ── Concluído ─────────────────────────────────────────────────────────────────
echo ""
echo "╔══════════════════════════════════════════════╗"
echo "║   ✅ Instalação concluída!                   ║"
echo "╚══════════════════════════════════════════════╝"
echo ""
echo "Para iniciar o servidor MCP:"
echo ""
echo "  cd $INSTALL_DIR && npm run start:unified"
echo ""
echo "  (ou use o atalho: sap-scrubbing)"
echo ""
echo "Configure o Joule Desktop:"
echo "  → URL:    http://localhost:8812/mcp"
echo "  → Header: X-User-Id: <seu-i-number>  (ex: I749420)"
echo "  → Auth:   None"
echo ""
