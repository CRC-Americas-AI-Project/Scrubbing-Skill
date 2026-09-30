# SAP Scrubbing MCP - Instalador Windows
# Uso: Cole no PowerShell ou clique direito -> "Executar com o PowerShell"

$ErrorActionPreference = "Stop"
$InstallDir = "$env:USERPROFILE\.sap-scrubbing"
$RepoUrl = "https://github.com/CRC-Americas-AI-Project/Scrubbing-Skill.git"
$Port = 8812

Write-Host ""
Write-Host "+----------------------------------------------+" -ForegroundColor Cyan
Write-Host "|   SAP Scrubbing MCP - Instalador Windows     |" -ForegroundColor Cyan
Write-Host "+----------------------------------------------+" -ForegroundColor Cyan
Write-Host ""

# Verificar Node.js
Write-Host "Verificando Node.js..." -ForegroundColor Cyan
$nodeCmd = Get-Command node -ErrorAction SilentlyContinue
if (-not $nodeCmd) {
    Write-Host "Node.js nao encontrado. Instalando via winget..." -ForegroundColor Yellow
    try {
        # Instalar Node.js v20 LTS especificamente (v22/v24 tem problemas com workspaces)
        winget install OpenJS.NodeJS.LTS --version 20.19.2 --silent --accept-package-agreements --accept-source-agreements 2>$null
        if ($LASTEXITCODE -ne 0) {
            winget install OpenJS.NodeJS --version 20.19.2 --silent --accept-package-agreements --accept-source-agreements 2>$null
        }
        $env:PATH = [System.Environment]::GetEnvironmentVariable("PATH", "Machine") + ";" + [System.Environment]::GetEnvironmentVariable("PATH", "User")
        $nodeCmd = Get-Command node -ErrorAction SilentlyContinue
    } catch {}
    if (-not $nodeCmd) {
        Write-Host "Nao foi possivel instalar automaticamente." -ForegroundColor Red
        Write-Host "Instale manualmente em: https://nodejs.org (versao 20+)" -ForegroundColor Yellow
        Start-Process "https://nodejs.org"
        Read-Host "Pressione Enter apos instalar o Node.js"
        $nodeCmd = Get-Command node -ErrorAction SilentlyContinue
        if (-not $nodeCmd) { exit 1 }
    }
}

$nodeVersion = (node -v).TrimStart('v')
$nodeMajor = [int]($nodeVersion.Split('.')[0])
if ($nodeMajor -lt 20) {
    Write-Host "ERRO: Node.js v20+ necessario. Voce tem: v$nodeVersion" -ForegroundColor Red
    Write-Host "Atualize em: https://nodejs.org" -ForegroundColor Yellow
    exit 1
}
if ($nodeMajor -gt 20) {
    Write-Host "  AVISO: Node.js v$nodeVersion detectado. Recomendado: v20 LTS." -ForegroundColor Yellow
    Write-Host "  Instalando Node.js v20 LTS para garantir compatibilidade..." -ForegroundColor Yellow
    winget install OpenJS.NodeJS.LTS --version 20.19.2 --silent --accept-package-agreements --accept-source-agreements 2>$null
    $env:PATH = [System.Environment]::GetEnvironmentVariable("PATH", "Machine") + ";" + [System.Environment]::GetEnvironmentVariable("PATH", "User")
    $nodeVersion = (node -v 2>$null).TrimStart('v')
    if ($nodeVersion) {
        $nodeMajor = [int]($nodeVersion.Split('.')[0])
    }
}
Write-Host "  OK Node.js v$nodeVersion" -ForegroundColor Green

# Verificar Git
$gitCmd = Get-Command git -ErrorAction SilentlyContinue
if (-not $gitCmd) {
    Write-Host "Instalando git via winget..." -ForegroundColor Yellow
    try {
        winget install Git.Git --silent --accept-package-agreements --accept-source-agreements
        $env:PATH = [System.Environment]::GetEnvironmentVariable("PATH", "Machine") + ";" + [System.Environment]::GetEnvironmentVariable("PATH", "User")
    } catch {
        Write-Host "Instale git manualmente em: https://git-scm.com" -ForegroundColor Red
        Start-Process "https://git-scm.com"
        exit 1
    }
}
Write-Host "  OK Git" -ForegroundColor Green

# Clonar ou atualizar
Write-Host ""
if (Test-Path "$InstallDir\.git") {
    Write-Host "Atualizando instalacao existente..." -ForegroundColor Cyan
    git -C $InstallDir pull --ff-only --quiet
} else {
    Write-Host "Baixando SAP Scrubbing MCP do GitHub..." -ForegroundColor Cyan
    git clone --quiet $RepoUrl $InstallDir
}

Set-Location $InstallDir
Write-Host "Instalando dependencias (aguarde ~2 min)..." -ForegroundColor Cyan
npm install --no-workspaces --legacy-peer-deps --silent

# Windows: copiar node_modules da raiz para o pacote principal
# Resolve ERR_MODULE_NOT_FOUND causado por falha de symlinks em ambientes corporativos
Write-Host "Configurando pacote principal..." -ForegroundColor Cyan
$SrcModules = "$InstallDir\node_modules"
$DstModules = "$InstallDir\packages\servers\scrubbing-mcp\node_modules"
if (Test-Path $SrcModules) {
    if (-not (Test-Path $DstModules)) {
        New-Item -ItemType Junction -Path $DstModules -Target $SrcModules -ErrorAction SilentlyContinue | Out-Null
    }
    if (-not (Test-Path $DstModules)) {
        # Junction falhou (sem permissao) - copiar apenas os pacotes necessarios
        New-Item -ItemType Directory -Force -Path $DstModules | Out-Null
        $essentialPkgs = @("@modelcontextprotocol", "sap-auth", "sap-harmony-mcp", "sap-dcd-mcp", "btp-fetch")
        foreach ($pkg in $essentialPkgs) {
            $src = "$SrcModules\$pkg"
            $dst = "$DstModules\$pkg"
            if ((Test-Path $src) -and (-not (Test-Path $dst))) {
                Copy-Item -Recurse -Force $src $dst
            }
        }
    }
}
Set-Location $InstallDir

# Criar launcher .bat na area de trabalho
# Suporta Desktop padrao e Desktop com OneDrive (SAP e outros)
$DesktopPath = $null
$DesktopCandidates = @(
    [System.Environment]::GetFolderPath("Desktop"),
    "$env:USERPROFILE\Desktop",
    "$env:USERPROFILE\OneDrive\Desktop",
    "$env:USERPROFILE\OneDrive - SAP SE\Desktop",
    "$env:OneDriveCommercial\Desktop",
    "$env:OneDrive\Desktop"
)
foreach ($candidate in $DesktopCandidates) {
    if ($candidate -and (Test-Path $candidate)) {
        $DesktopPath = $candidate
        break
    }
}
if (-not $DesktopPath) {
    $DesktopPath = "$env:USERPROFILE\Desktop"
    New-Item -ItemType Directory -Force -Path $DesktopPath | Out-Null
}

$BatLauncher = "$DesktopPath\SAP Scrubbing MCP.bat"
$batContent = "@echo off`r`ntitle SAP Scrubbing MCP`r`ncd /d `"$InstallDir`"`r`necho.`r`necho   SAP Scrubbing MCP`r`necho   URL: http://localhost:$Port/mcp`r`necho   Pressione Ctrl+C para encerrar.`r`necho.`r`nset PORT=$Port`r`nnode packages\servers\scrubbing-mcp\src\mcp-server-http.mjs`r`npause"
[System.IO.File]::WriteAllText($BatLauncher, $batContent, [System.Text.Encoding]::ASCII)
Write-Host "  OK Atalho criado em: $BatLauncher" -ForegroundColor Green

# Configurar auto-start no login (Task Scheduler)
Write-Host ""
Write-Host "Configurando inicio automatico no login..." -ForegroundColor Cyan
try {
    $NodePath = (Get-Command node).Source
    $StartScript = "$InstallDir\packages\servers\scrubbing-mcp\src\mcp-server-http.mjs"
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
    $Task = New-ScheduledTask -Action $Action -Trigger $Trigger -Settings $Settings -Principal $Principal
    Register-ScheduledTask -TaskName $TaskName -InputObject $Task -Force | Out-Null
    Start-ScheduledTask -TaskName $TaskName 2>$null
    Write-Host "  OK Inicio automatico configurado" -ForegroundColor Green
} catch {
    Write-Host "  AVISO: Nao foi possivel configurar inicio automatico." -ForegroundColor Yellow
    Write-Host "  Use o atalho na area de trabalho para iniciar manualmente." -ForegroundColor Yellow
}

# Testar servidor
Write-Host ""
Write-Host "Testando servidor..." -ForegroundColor Cyan
Start-Sleep 4
try {
    $response = Invoke-WebRequest -Uri "http://localhost:$Port/mcp" -UseBasicParsing -TimeoutSec 5
    if ($response.StatusCode -eq 200) {
        Write-Host "  OK Servidor rodando em http://localhost:$Port/mcp" -ForegroundColor Green
    }
} catch {
    Write-Host "  AVISO: Servidor ainda iniciando. Aguarde ou use o atalho na area de trabalho." -ForegroundColor Yellow
}

# Concluido
Write-Host ""
Write-Host "+----------------------------------------------+" -ForegroundColor Green
Write-Host "|   Instalacao concluida!                      |" -ForegroundColor Green
Write-Host "+----------------------------------------------+" -ForegroundColor Green
Write-Host ""
Write-Host "O servidor inicia automaticamente quando voce faz login." -ForegroundColor White
Write-Host "Para iniciar manualmente, clique duas vezes em:" -ForegroundColor White
Write-Host "   'SAP Scrubbing MCP.bat' na area de trabalho" -ForegroundColor Yellow
Write-Host ""
Write-Host "Configure o Joule Desktop:" -ForegroundColor White
Write-Host "   URL:   http://localhost:$Port/mcp" -ForegroundColor Yellow
Write-Host "   Auth:  None" -ForegroundColor Yellow
Write-Host ""
