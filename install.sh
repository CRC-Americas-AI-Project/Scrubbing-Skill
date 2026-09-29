#!/usr/bin/env bash
# SAP Scrubbing MCP — Instalador Mac
# Uso: bash install.sh
# Ou diretamente: curl -fsSL <URL>/install.sh | bash

set -euo pipefail

INSTALL_DIR="$HOME/.sap-scrubbing"
REPO_URL="https://github.com/CRC-Americas-AI-Project/Scrubbing-Skill.git"
PORT=8812
PLIST_PATH="$HOME/Library/LaunchAgents/com.sap.scrubbing.plist"

echo ""
echo "╔══════════════════════════════════════════════╗"
echo "║   SAP Scrubbing MCP — Instalador Mac         ║"
echo "╚══════════════════════════════════════════════╝"
echo ""

# ── Verificar Node.js ─────────────────────────────────────────────────────────
echo "🔍 Verificando Node.js..."
if ! command -v node &>/dev/null; then
  echo "   Node.js não encontrado. Instalando automaticamente..."
  if ! command -v brew &>/dev/null; then
    echo "   Instalando Homebrew primeiro..."
    /bin/bash -c "$(curl -fsSL https://raw.githubusercontent.com/Homebrew/install/HEAD/install.sh)"
    # Adicionar Homebrew ao PATH para Apple Silicon
    eval "$(/opt/homebrew/bin/brew shellenv)" 2>/dev/null || eval "$(/usr/local/bin/brew shellenv)" 2>/dev/null || true
  fi
  brew install node
fi

NODE_VER=$(node -v | sed 's/v//' | cut -d. -f1)
if [ "$NODE_VER" -lt 20 ]; then
  echo "   Node.js $(node -v) encontrado, atualizando para v20+..."
  brew upgrade node 2>/dev/null || brew install node@20
fi
echo "   ✓ Node.js $(node -v)"

# ── Verificar Git ─────────────────────────────────────────────────────────────
if ! command -v git &>/dev/null; then
  echo "   Git não encontrado. Instalando via Xcode Command Line Tools..."
  xcode-select --install 2>/dev/null || true
  echo "   Se aparecer uma janela de instalação, conclua e execute este script novamente."
  # Tentar via Homebrew como alternativa
  if command -v brew &>/dev/null; then
    brew install git
  else
    echo "❌ Por favor instale o git e execute novamente: https://git-scm.com"
    exit 1
  fi
fi

# ── Clonar ou atualizar ───────────────────────────────────────────────────────
echo ""
if [ -d "$INSTALL_DIR/.git" ]; then
  echo "📦 Atualizando instalação existente..."
  git -C "$INSTALL_DIR" pull --ff-only --quiet
else
  echo "📦 Baixando SAP Scrubbing MCP..."
  git clone --quiet "$REPO_URL" "$INSTALL_DIR"
fi

cd "$INSTALL_DIR"
echo "📥 Instalando dependências..."
npm install --silent
# dist/ dos shared packages já estão no repositório — build não necessário

# ── Criar script de start ─────────────────────────────────────────────────────
START_SCRIPT="$INSTALL_DIR/start-mac.sh"
cat > "$START_SCRIPT" << EOF
#!/usr/bin/env bash
cd "$INSTALL_DIR"
export PORT=$PORT
exec node packages/servers/scrubbing-mcp/src/mcp-server-http.mjs
EOF
chmod +x "$START_SCRIPT"

# ── Criar launcher clicável na área de trabalho ───────────────────────────────
DESKTOP_LAUNCHER="$HOME/Desktop/SAP Scrubbing MCP.command"
cat > "$DESKTOP_LAUNCHER" << EOF
#!/usr/bin/env bash
# Duplo clique para iniciar o SAP Scrubbing MCP
cd "$INSTALL_DIR"
export PORT=$PORT

echo ""
echo "  SAP Scrubbing MCP"
echo "  URL: http://localhost:$PORT/mcp"
echo "  Pressione Ctrl+C para encerrar."
echo ""

node packages/servers/scrubbing-mcp/src/mcp-server-http.mjs
EOF
chmod +x "$DESKTOP_LAUNCHER"

# ── Configurar auto-start no login (launchd) ──────────────────────────────────
echo ""
echo "⚙️  Configurando início automático no login..."
mkdir -p "$HOME/Library/LaunchAgents"
cat > "$PLIST_PATH" << EOF
<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
    <key>Label</key>
    <string>com.sap.scrubbing</string>
    <key>ProgramArguments</key>
    <array>
        <string>/usr/local/bin/node</string>
        <string>$INSTALL_DIR/packages/servers/scrubbing-mcp/src/mcp-server-http.mjs</string>
    </array>
    <key>WorkingDirectory</key>
    <string>$INSTALL_DIR</string>
    <key>EnvironmentVariables</key>
    <dict>
        <key>PORT</key>
        <string>$PORT</string>
        <key>PATH</key>
        <string>/usr/local/bin:/usr/bin:/bin:/opt/homebrew/bin</string>
    </dict>
    <key>RunAtLoad</key>
    <true/>
    <key>KeepAlive</key>
    <true/>
    <key>StandardOutPath</key>
    <string>$HOME/.sap-scrubbing/server.log</string>
    <key>StandardErrorPath</key>
    <string>$HOME/.sap-scrubbing/server.log</string>
</dict>
</plist>
EOF

# Carregar o serviço agora
launchctl unload "$PLIST_PATH" 2>/dev/null || true
launchctl load "$PLIST_PATH" 2>/dev/null && echo "   ✓ Servidor iniciado automaticamente" || true

# ── Testar se subiu ───────────────────────────────────────────────────────────
echo ""
echo "🧪 Testando servidor..."
sleep 3
HTTP_STATUS=$(curl -s -o /dev/null -w "%{http_code}" "http://localhost:$PORT/mcp" 2>/dev/null || echo "000")
if [ "$HTTP_STATUS" = "200" ]; then
  echo "   ✅ Servidor rodando em http://localhost:$PORT/mcp"
else
  echo "   ⚠️  Servidor ainda iniciando. Aguarde alguns segundos."
  echo "   Ou inicie manualmente: duplo clique em 'SAP Scrubbing MCP.command' na área de trabalho"
fi

# ── Concluído ─────────────────────────────────────────────────────────────────
echo ""
echo "╔══════════════════════════════════════════════╗"
echo "║   ✅ Instalação concluída!                   ║"
echo "╚══════════════════════════════════════════════╝"
echo ""
echo "O servidor inicia automaticamente quando você faz login."
echo "Para iniciar manualmente: duplo clique em"
echo "  'SAP Scrubbing MCP.command' na área de trabalho"
echo ""
echo "Configure o Joule Desktop:"
echo "  → URL:    http://localhost:$PORT/mcp"
echo "  → Auth:   None"
echo ""
