@echo off
title Configuracao - Agente WhatsApp
cd /d "%~dp0"

:: Adiciona caminhos comuns do Node.js ao PATH desta sessao
set "PATH=%PATH%;C:\Program Files\nodejs;%APPDATA%\npm;%LOCALAPPDATA%\Programs\nodejs"

echo.
echo ================================================
echo   AGENTE WHATSAPP - CONFIGURACAO INICIAL
echo ================================================
echo.

:: Verifica Node.js
node --version >nul 2>&1
if %errorlevel% neq 0 (
    echo [ERRO] Node.js nao encontrado.
    echo.
    echo  1. Acesse: https://nodejs.org
    echo  2. Clique em "Download Node.js LTS"
    echo  3. Instale e REINICIE o computador
    echo  4. Execute este arquivo novamente
    echo.
    pause
    exit /b 1
)
for /f "tokens=*" %%v in ('node --version') do set NODE_VER=%%v
echo [OK] Node.js %NODE_VER% encontrado.

:: Cria ou recria package.json se estiver ausente ou sem as dependencias certas
findstr /C:"baileys" "%~dp0package.json" >nul 2>&1
if %errorlevel% neq 0 (
    echo [INFO] Criando package.json...
    powershell -NoProfile -Command "$pkg = @{name='whatsapp-agente';version='1.0.0';dependencies=@{'@hapi/boom'='^10.0.1';'@whiskeysockets/baileys'='^7.0.0-rc11';express='^4.18.2';'node-cron'='^3.0.3';qrcode='^1.5.3'}} | ConvertTo-Json -Depth 5; Set-Content -Encoding UTF8 -Path '%~dp0package.json' -Value $pkg"
    if not exist "%~dp0package.json" (
        echo [ERRO] Falha ao criar package.json.
        pause
        exit /b 1
    )
    echo [OK] package.json criado.
    :: Remove node_modules para forcar reinstalacao com package.json correto
    if exist "%~dp0node_modules" rmdir /s /q "%~dp0node_modules"
)

:: Instala dependencias se necessario
if not exist "%~dp0node_modules\@whiskeysockets" (
    echo.
    echo [INFO] Instalando dependencias pela primeira vez...
    echo       Aguarde, pode levar alguns minutos.
    echo.
    npm install
    if %errorlevel% neq 0 (
        echo.
        echo [ERRO] Falha ao instalar dependencias.
        echo       Verifique sua conexao com a internet.
        echo.
        pause
        exit /b 1
    )
    echo.
    echo [OK] Dependencias instaladas!
) else (
    echo [OK] Dependencias ja instaladas.
)

:: Inicia o agente
echo.
echo ================================================
echo   INICIANDO AGENTE WHATSAPP...
echo ================================================
echo.
echo  Mantenha esta janela aberta.
echo  Abra o dashboard, clique em Conectar WhatsApp
echo  e escaneie o QR code com seu celular.
echo.

node whatsapp-local.mjs

echo.
echo Agente encerrado.
pause
