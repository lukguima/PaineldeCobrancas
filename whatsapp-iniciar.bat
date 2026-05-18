@echo off
title Agente WhatsApp - Painel de Cobrancas
color 0A
cd /d "%~dp0"

:: Adiciona caminhos comuns do Node.js ao PATH desta sessao
set "PATH=%PATH%;C:\Program Files\nodejs;%APPDATA%\npm;%LOCALAPPDATA%\Programs\nodejs"

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
