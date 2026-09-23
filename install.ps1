# SAP Scrubbing MCP — Script de instalação (Windows)
# Uso: Clique direito → "Executar com PowerShell"
# Ou no PowerShell: .\install.ps1

$ErrorActionPreference = "Stop"
$InstallDir = "$env:USERPROFILE\.sap-scrubbing"
$RepoUrl = "https://github.com/CRC-Americas-AI-Project/Scrubbing-Skill.git"

Write-Host ""
Write-Host "╔══════════════════════════════════════════════╗" -ForegroundColor Cyan
Write-Host "║   SAP Scrubbing MCP — Instalador             ║" -ForegroundColor Cyan
Write-Host "╚══════════════════════════════════════════════╝" -ForegroundColor Cyan
Write-Host ""

# ── Verificar Node.js ─────────────────────────────────────────────────────────
Write-Host "🔍 Verificando Node.js..."
$nodeCmd = Get-Command node -ErrorAction SilentlyContinue
if (-not $nodeCmd) {
    Write-Host ""
    Write-Host "❌ Node.js não encontrado." -ForegroundColor Red
    Write-Host "   Instale a versão 20 ou superior em: https://nodejs.org" -ForegroundColor Yellow
    Write-Host ""
    Start-Process "https://nodejs.org"
    Read-Host "Pressione Enter após instalar o Node.js para continuar"
    # Verificar novamente
    $nodeCmd = Get-Command node -ErrorAction SilentlyContinue
    if (-not $nodeCmd) { exit 1 }
}

$nodeVersion = (node -v).TrimStart('v')
$nodeMajor = [int]($nodeVersion.Split('.')[0])
if ($nodeMajor -lt 20) {
    Write-Host "❌ Node.js v20+ necessário. Você tem: v$nodeVersion" -ForegroundColor Red
    Write-Host "   Atualize em: https://nodejs.org" -ForegroundColor Yellow
    exit 1
}

Write-Host "   ✓ Node.js v$nodeVersion" -ForegroundColor Green
Write-Host "   ✓ npm $(npm -v)" -ForegroundColor Green

# ── Verificar Git ─────────────────────────────────────────────────────────────
$gitCmd = Get-Command git -ErrorAction SilentlyContinue
if (-not $gitCmd) {
    Write-Host ""
    Write-Host "❌ git não encontrado." -ForegroundColor Red
    Write-Host "   Instale em: https://git-scm.com" -ForegroundColor Yellow
    Start-Process "https://git-scm.com"
    exit 1
}

# ── Clonar ou atualizar ───────────────────────────────────────────────────────
Write-Host ""
if (Test-Path "$InstallDir\.git") {
    Write-Host "📦 Atualizando instalação existente em $InstallDir..."
    git -C $InstallDir pull --ff-only --quiet
} else {
    Write-Host "📦 Baixando SAP Scrubbing MCP..."
    git clone --quiet $RepoUrl $InstallDir
}

# ── Instalar dependências ─────────────────────────────────────────────────────
Write-Host ""
Write-Host "📥 Instalando dependências (pode demorar alguns minutos)..."
Set-Location $InstallDir
npm install --silent

# ── Compilar pacotes compartilhados ──────────────────────────────────────────
Write-Host "🔨 Compilando..."
npm run build:shared --silent 2>$null

# ── Criar atalho no Desktop ───────────────────────────────────────────────────
$desktopBat = "$env:USERPROFILE\Desktop\SAP Scrubbing MCP.bat"
@"
@echo off
title SAP Scrubbing MCP
cd /d "$InstallDir"
echo Iniciando SAP Scrubbing MCP em http://localhost:8812/mcp
echo Pressione Ctrl+C para encerrar.
echo.
node packages\servers\scrubbing-mcp\src\mcp-server-http.mjs
pause
"@ | Out-File -FilePath $desktopBat -Encoding ASCII

# ── Concluído ─────────────────────────────────────────────────────────────────
Write-Host ""
Write-Host "╔══════════════════════════════════════════════╗" -ForegroundColor Green
Write-Host "║   ✅ Instalação concluída!                   ║" -ForegroundColor Green
Write-Host "╚══════════════════════════════════════════════╝" -ForegroundColor Green
Write-Host ""
Write-Host "Para iniciar o servidor MCP:" -ForegroundColor White
Write-Host "   → Clique duplo em 'SAP Scrubbing MCP.bat' na sua Mesa de Trabalho" -ForegroundColor Yellow
Write-Host ""
Write-Host "Configure o Joule Desktop:" -ForegroundColor White
Write-Host "   → URL:    http://localhost:8812/mcp" -ForegroundColor Yellow
Write-Host "   → Header: X-User-Id: <seu-i-number>  (ex: I749420)" -ForegroundColor Yellow
Write-Host "   → Auth:   None" -ForegroundColor Yellow
Write-Host ""
