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
  echo "   Node.js não encontrado. Instalando via nvm (sem precisar de admin)..."

  # Instalar nvm — não requer sudo, instala em ~/.nvm
  export NVM_DIR="$HOME/.nvm"
  if [ ! -d "$NVM_DIR" ]; then
    curl -fsSL https://raw.githubusercontent.com/nvm-sh/nvm/v0.40.1/install.sh | bash
  fi

  # Carregar nvm na sessão atual
  [ -s "$NVM_DIR/nvm.sh" ] && \. "$NVM_DIR/nvm.sh"

  # Instalar Node.js 20 LTS
  echo "   Instalando Node.js 20 LTS (sem permissão de admin necessária)..."
  nvm install 20
  nvm use 20
  nvm alias default 20

  # Adicionar ao PATH permanente no shell do usuário
  SHELL_RC="$HOME/.zshrc"
  [ -f "$HOME/.bash_profile" ] && SHELL_RC="$HOME/.bash_profile"
  if ! grep -q "NVM_DIR" "$SHELL_RC" 2>/dev/null; then
    echo '' >> "$SHELL_RC"
    echo 'export NVM_DIR="$HOME/.nvm"' >> "$SHELL_RC"
    echo '[ -s "$NVM_DIR/nvm.sh" ] && \. "$NVM_DIR/nvm.sh"' >> "$SHELL_RC"
  fi
fi

# Garantir que nvm está carregado se node não estiver no PATH
if ! command -v node &>/dev/null; then
  export NVM_DIR="$HOME/.nvm"
  [ -s "$NVM_DIR/nvm.sh" ] && \. "$NVM_DIR/nvm.sh"
fi

NODE_VER=$(node -v 2>/dev/null | sed 's/v//' | cut -d. -f1)
if [ -z "$NODE_VER" ] || [ "$NODE_VER" -lt 20 ]; then
  echo "❌ Node.js v20+ necessário. Instale em: https://nodejs.org"
  exit 1
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
# Detect real node executable path (works for Homebrew Intel, Homebrew Apple Silicon, nvm, direct install)
NODE_EXEC=$(node -e "process.stdout.write(process.execPath)")
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

"$NODE_EXEC" packages/servers/scrubbing-mcp/src/mcp-server-http.mjs
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
        <string>$NODE_EXEC</string>
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
