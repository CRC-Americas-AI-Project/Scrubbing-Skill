@echo off
setlocal EnableDelayedExpansion

echo.
echo  ================================================
echo   SAP Scrubbing MCP -- Auto-Start para Joule
echo  ================================================
echo.

:: Detectar pasta do repositorio (onde este .bat esta)
set REPO_DIR=%~dp0
set REPO_DIR=%REPO_DIR:~0,-1%

echo  Repositorio detectado: %REPO_DIR%
echo.

:: Verificar Node.js
node --version > nul 2>&1
if errorlevel 1 (
    echo  [ERRO] Node.js nao encontrado.
    echo  Instale em: https://nodejs.org  (versao 20 ou superior^)
    echo.
    pause
    exit /b 1
)
for /f "tokens=*" %%v in ('node --version') do set NODE_VER=%%v
echo  [OK] Node.js %NODE_VER%

:: Verificar se as dependencias foram instaladas
if not exist "%REPO_DIR%\node_modules" (
    echo.
    echo  [AVISO] Dependencias nao encontradas -- instalando...
    cd /d "%REPO_DIR%"
    call npm install --silent
    if errorlevel 1 (
        echo  [ERRO] Falha ao instalar dependencias. Execute install.ps1 primeiro.
        pause
        exit /b 1
    )
    echo  [OK] Dependencias instaladas
) else (
    echo  [OK] Dependencias ja instaladas
)

:: Detectar Joule Desktop
set JOULE_EXE=%LOCALAPPDATA%\Programs\Joule Desktop\Joule Desktop.exe
if not exist "%JOULE_EXE%" (
    echo  [AVISO] Joule Desktop nao encontrado em:
    echo    %JOULE_EXE%
    echo  O atalho nao sera criado -- verifique o caminho manualmente.
    set JOULE_EXE=
) else (
    echo  [OK] Joule Desktop encontrado
)

:: Criar bat de inicializacao automatica no Startup do Windows
set STARTUP=%APPDATA%\Microsoft\Windows\Start Menu\Programs\Startup

echo.
echo  Configurando auto-start no login do Windows...

echo @echo off > "%STARTUP%\start-sap-scrubbing-mcp.bat"
echo cd /d "%REPO_DIR%" >> "%STARTUP%\start-sap-scrubbing-mcp.bat"
echo start /min "" node packages\servers\scrubbing-mcp\src\mcp-server-http.mjs >> "%STARTUP%\start-sap-scrubbing-mcp.bat"
echo  [OK] start-sap-scrubbing-mcp.bat criado na pasta Startup

:: Criar open-joule.bat (launcher com verificacao de porta)
(
echo @echo off
echo :: Verificar se o servidor MCP ja esta rodando ^(porta 8812^)
echo netstat -ano ^| find ":8812" ^| find "LISTENING" ^> nul 2^>^&1
echo if errorlevel 1 ^(
echo     cd /d "%REPO_DIR%"
echo     start /min "" node packages\servers\scrubbing-mcp\src\mcp-server-http.mjs
echo     timeout /t 4 /nobreak ^> nul
echo ^)
if not "%JOULE_EXE%"=="" (
    echo start "" "%JOULE_EXE%"
)
) > "%REPO_DIR%\open-joule.bat"
echo  [OK] open-joule.bat criado

:: Criar atalho "Joule Desktop" na area de trabalho
if not "%JOULE_EXE%"=="" (
    powershell -Command "$s=[System.IO.Path]::Combine([System.Environment]::GetFolderPath('Desktop'),'Joule Desktop.lnk');$w=New-Object -comObject WScript.Shell;$l=$w.CreateShortcut($s);$l.TargetPath='%REPO_DIR%\open-joule.bat';$l.WorkingDirectory='%REPO_DIR%';$l.IconLocation='%JOULE_EXE%,0';$l.WindowStyle=7;$l.Description='Abre Joule Desktop com servidor MCP SAP ativo';$l.Save()" > nul 2>&1
    echo  [OK] Atalho "Joule Desktop" criado na area de trabalho
)

:: Iniciar servidor para esta sessao
echo.
echo  Iniciando servidor para esta sessao...
netstat -ano | find ":8812" | find "LISTENING" > nul 2>&1
if errorlevel 1 (
    cd /d "%REPO_DIR%"
    start /min "" node packages\servers\scrubbing-mcp\src\mcp-server-http.mjs
    echo  [OK] Servidor MCP iniciado ^(porta 8812^)
) else (
    echo  [OK] Servidor MCP ja estava rodando ^(porta 8812^)
)

echo.
echo  ================================================
echo   Setup concluido!
echo  ================================================
echo.
echo   O que foi configurado:
echo   - Servidor sobe automaticamente no proximo login
echo   - Atalho "Joule Desktop" criado na area de trabalho
echo.
echo   Como usar daqui em diante:
echo   - Abra sempre a Joule pelo atalho "Joule Desktop"
echo   - O servidor MCP estara pronto antes de a Joule abrir
echo.
pause
