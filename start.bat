@echo off
chcp 65001 >nul
title DSH 插件管理器

cd /d "%~dp0"

echo ==================================================
echo   正在启动 DSH 插件管理器...
echo ==================================================

where node >nul 2>nul
if %errorlevel% neq 0 (
    echo [错误] 未检测到 Node.js 环境，请先安装 Node.js！
    pause
    exit /b 1
)

start "" http://127.0.0.1:3929
node server.js

pause
