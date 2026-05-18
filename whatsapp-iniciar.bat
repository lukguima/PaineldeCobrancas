@echo off
title Agente WhatsApp - Painel de Cobrancas
color 0A
cd /d "%~dp0"

set "PATH=%PATH%;C:\Program Files\nodejs;%APPDATA%\npm;%LOCALAPPDATA%\Programs\nodejs"

:: Se as dependencias nao estiverem instaladas, roda o setup primeiro
if not exist "%~dp0node_modules\@whiskeysockets" (
    echo [INFO] Dependencias nao encontradas. Executando configuracao...
    echo.
    call "%~dp0whatsapp-setup.bat"
    exit /b
)

echo.
echo  =========================================
echo   Agente WhatsApp - Painel de Cobrancas
echo  =========================================
echo.
echo  Iniciando... Mantenha esta janela aberta.
echo  Minimize-a caso queira usar o computador.
echo.

node whatsapp-local.mjs

echo.
echo  O agente foi encerrado.
echo  Pressione qualquer tecla para fechar.
pause > nul
