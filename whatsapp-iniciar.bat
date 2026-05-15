@echo off
title Agente WhatsApp — Painel de Cobranças
color 0A
cd /d "%~dp0"

echo.
echo  =========================================
echo   Agente WhatsApp — Painel de Cobranças
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
