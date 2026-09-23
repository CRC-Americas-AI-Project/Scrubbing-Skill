@echo off
title SAP Scrubbing MCP
cd /d "%~dp0"

echo.
echo  SAP Scrubbing MCP - Servidor Local
echo  ====================================
echo  URL: http://localhost:8812/mcp
echo  Pressione Ctrl+C para encerrar.
echo.

node packages\servers\scrubbing-mcp\src\mcp-server-http.mjs

echo.
echo Servidor encerrado.
pause
