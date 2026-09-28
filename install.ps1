# SAP Scrubbing MCP — Instalador Windows
# Uso: Clique direito → "Executar com o PowerShell"

$ErrorActionPreference = "Stop"
$InstallDir = "$env:USERPROFILE\.sap-scrubbing"
$RepoUrl = "https://github.com/CRC-Americas-AI-Project/Scrubbing-Skill.git"
$Port = 8812

Write-Host ""
Write-Host "╔══════════════════════════════════════════════╗" -ForegroundColor Cyan
Write-Host "║   SAP Scrubbing MCP — Instalador Windows     ║" -ForegroundColor Cyan
Write-Host "╚══════════════════════════════════════════════╝" -ForegroundColor Cyan
Write-Host ""

# ── Verificar Node.js ─────────────────────────────────────────────────────────
Write-Host "🔍 Verificando Node.js..."
$nodeCmd = Get-Command node -ErrorAction SilentlyContinue
if (-not $nodeCmd) {
    Write-Host "❌ Node.js não encontrado." -ForegroundColor Red
    Write-Host "   Instalando via winget..." -ForegroundColor Yellow
    try {
        winget install OpenJS.NodeJS.LTS --silent --accept-package-agreements --accept-source-agreements
        $env:PATH = [System.Environment]::GetEnvironmentVariable("PATH", "Machine") + ";" + [System.Environment]::GetEnvironmentVariable("PATH", "User")
        $nodeCmd = Get-Command node -ErrorAction SilentlyContinue
    } catch {}
    if (-not $nodeCmd) {
        Write-Host "   Não foi possível instalar automaticamente." -ForegroundColor Red
        Write-Host "   Instale manualmente em: https://nodejs.org (versão 20+)" -ForegroundColor Yellow
        Start-Process "https://nodejs.org"
        Read-Host "Pressione Enter após instalar o Node.js"
        $nodeCmd = Get-Command node -ErrorAction SilentlyContinue
        if (-not $nodeCmd) { exit 1 }
    }
}

$nodeVersion = (node -v).TrimStart('v')
$nodeMajor = [int]($nodeVersion.Split('.')[0])
if ($nodeMajor -lt 20) {
    Write-Host "❌ Node.js v20+ necessário. Você tem: v$nodeVersion" -ForegroundColor Red
    Write-Host "   Atualize em: https://nodejs.org" -ForegroundColor Yellow
    exit 1
}
Write-Host "   ✓ Node.js v$nodeVersion" -ForegroundColor Green

# ── Verificar Git ─────────────────────────────────────────────────────────────
$gitCmd = Get-Command git -ErrorAction SilentlyContinue
if (-not $gitCmd) {
    Write-Host "⚙️  Instalando git via winget..." -ForegroundColor Yellow
    try {
        winget install Git.Git --silent --accept-package-agreements --accept-source-agreements
        $env:PATH = [System.Environment]::GetEnvironmentVariable("PATH", "Machine") + ";" + [System.Environment]::GetEnvironmentVariable("PATH", "User")
    } catch {
        Write-Host "   Instale git manualmente em: https://git-scm.com" -ForegroundColor Red
        Start-Process "https://git-scm.com"
        exit 1
    }
}

# ── Clonar ou atualizar ───────────────────────────────────────────────────────
Write-Host ""
if (Test-Path "$InstallDir\.git") {
    Write-Host "📦 Atualizando instalação existente..."
    git -C $InstallDir pull --ff-only --quiet
} else {
    Write-Host "📦 Baixando SAP Scrubbing MCP..."
    git clone --quiet $RepoUrl $InstallDir
}

Set-Location $InstallDir
Write-Host "📥 Instalando dependências (aguarde ~2 min)..."
npm install --silent
npm run build:shared --silent 2>$null

# ── Criar launcher invisível (sem janela preta) ───────────────────────────────
$VbsLauncher = "$env:USERPROFILE\Desktop\SAP Scrubbing MCP.vbs"
$NodePath = (Get-Command node).Source
$StartScript = "$InstallDir\packages\servers\scrubbing-mcp\src\mcp-server-http.mjs"

@"
Set WShell = CreateObject("WScript.Shell")
Set oExec = WShell.Exec("$NodePath ""$StartScript""")
WScript.Sleep 2000
If oExec.Status = 0 Then
    WShell.AppActivate "SAP Scrubbing MCP"
    MsgBox "SAP Scrubbing MCP iniciado!" & Chr(13) & Chr(13) & "URL: http://localhost:$Port/mcp" & Chr(13) & Chr(13) & "O servidor ficará ativo até você reiniciar o computador.", 64, "SAP Scrubbing MCP"
End If
"@ | Out-File -FilePath $VbsLauncher -Encoding ASCII

# ── Criar .bat simples também (alternativa com janela) ────────────────────────
$BatLauncher = "$env:USERPROFILE\Desktop\SAP Scrubbing MCP.bat"
@"
@echo off
title SAP Scrubbing MCP
cd /d "$InstallDir"
echo.
echo   SAP Scrubbing MCP
echo   URL: http://localhost:$Port/mcp
echo   Pressione Ctrl+C para encerrar.
echo.
set PORT=$Port
node packages\servers\scrubbing-mcp\src\mcp-server-http.mjs
pause
"@ | Out-File -FilePath $BatLauncher -Encoding ASCII

# ── Configurar auto-start no login (Task Scheduler) ──────────────────────────
Write-Host ""
Write-Host "⚙️  Configurando início automático no login..."
try {
    $TaskName = "SAP Scrubbing MCP"
    $Action = New-ScheduledTaskAction `
        -Execute $NodePath `
        -Argument "`"$StartScript`"" `
        -WorkingDirectory $InstallDir
    $Trigger = New-ScheduledTaskTrigger -AtLogOn -User $env:USERNAME
    $Settings = New-ScheduledTaskSettingsSet `
        -ExecutionTimeLimit (New-TimeSpan -Hours 0) `
        -RestartCount 3 `
        -RestartInterval (New-TimeSpan -Minutes 1)
    $Principal = New-ScheduledTaskPrincipal -UserId $env:USERNAME -RunLevel Limited

    # Adicionar variável de ambiente PORT
    $Task = New-ScheduledTask -Action $Action -Trigger $Trigger -Settings $Settings -Principal $Principal
    Register-ScheduledTask -TaskName $TaskName -InputObject $Task -Force | Out-Null

    # Iniciar agora também
    Start-ScheduledTask -TaskName $TaskName 2>$null
    Write-Host "   ✓ Início automático configurado" -ForegroundColor Green
} catch {
    Write-Host "   ⚠️  Não foi possível configurar início automático." -ForegroundColor Yellow
    Write-Host "   Use o atalho na área de trabalho para iniciar manualmente." -ForegroundColor Yellow
}

# ── Testar se subiu ───────────────────────────────────────────────────────────
Write-Host ""
Write-Host "🧪 Testando servidor..."
Start-Sleep 4
try {
    $response = Invoke-WebRequest -Uri "http://localhost:$Port/mcp" -UseBasicParsing -TimeoutSec 5
    if ($response.StatusCode -eq 200) {
        Write-Host "   ✅ Servidor rodando em http://localhost:$Port/mcp" -ForegroundColor Green
    }
} catch {
    Write-Host "   ⚠️  Servidor ainda iniciando. Aguarde ou use o atalho na área de trabalho." -ForegroundColor Yellow
}

# ── Concluído ─────────────────────────────────────────────────────────────────
Write-Host ""
Write-Host "╔══════════════════════════════════════════════╗" -ForegroundColor Green
Write-Host "║   ✅ Instalação concluída!                   ║" -ForegroundColor Green
Write-Host "╚══════════════════════════════════════════════╝" -ForegroundColor Green
Write-Host ""
Write-Host "O servidor inicia automaticamente quando você faz login." -ForegroundColor White
Write-Host "Para iniciar manualmente, use o atalho na área de trabalho:" -ForegroundColor White
Write-Host "   'SAP Scrubbing MCP.bat'" -ForegroundColor Yellow
Write-Host ""
Write-Host "Configure o Joule Desktop:" -ForegroundColor White
Write-Host "   → URL:    http://localhost:$Port/mcp" -ForegroundColor Yellow
Write-Host "   → Auth:   None" -ForegroundColor Yellow
Write-Host ""
