@echo off
title Configuracao — Agente WhatsApp
chcp 65001 >nul
cd /d "%~dp0"

echo.
echo ================================================
echo   AGENTE WHATSAPP — CONFIGURACAO INICIAL
echo ================================================
echo.

:: ── 1. Verificar Node.js ─────────────────────────
node --version >nul 2>&1
if %errorlevel% neq 0 (
    echo [ERRO] Node.js nao encontrado no seu computador.
    echo.
    echo  1. Acesse: https://nodejs.org
    echo  2. Clique em "Download Node.js LTS"
    echo  3. Instale normalmente e reinicie o computador
    echo  4. Execute este arquivo novamente
    echo.
    pause
    exit /b 1
)
for /f "tokens=*" %%v in ('node --version') do set NODE_VER=%%v
echo [OK] Node.js %NODE_VER% encontrado.

:: ── 2. Criar package.json se nao existir ─────────
if not exist "%~dp0package.json" (
    echo [INFO] Criando package.json...
    (
        echo {
        echo   "name": "whatsapp-agente",
        echo   "version": "1.0.0",
        echo   "dependencies": {
        echo     "@hapi/boom": "^10.0.1",
        echo     "@whiskeysockets/baileys": "^7.0.0-rc11",
        echo     "express": "^4.18.2",
        echo     "node-cron": "^3.0.3",
        echo     "qrcode": "^1.5.3"
        echo   }
        echo }
    ) > "%~dp0package.json"
    echo [OK] package.json criado.
)

:: ── 3. Instalar dependencias se necessario ────────
if not exist "%~dp0node_modules\express" (
    echo.
    echo [INFO] Instalando dependencias pela primeira vez...
    echo       (pode levar alguns minutos)
    echo.
    npm install
    if %errorlevel% neq 0 (
        echo.
        echo [ERRO] Falha ao instalar dependencias.
        echo       Verifique sua conexao com a internet e tente novamente.
        echo.
        pause
        exit /b 1
    )
    echo.
    echo [OK] Dependencias instaladas com sucesso!
) else (
    echo [OK] Dependencias ja instaladas.
)

:: ── 4. Iniciar agente ─────────────────────────────
echo.
echo ================================================
echo   INICIANDO AGENTE WHATSAPP...
echo ================================================
echo.
echo  Apos iniciar, abra o dashboard no navegador,
echo  clique em "Conectar WhatsApp" e escaneie o QR.
echo.

node whatsapp-local.mjs

echo.
echo Agente encerrado.
pause
