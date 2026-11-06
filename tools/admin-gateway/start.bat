@echo off
chcp 65001 >nul
setlocal

if "%WX_APPID%"=="" (
  echo [错误] 请先设置 WX_APPID 环境变量（小程序后台 - 开发管理 - 开发设置）
  exit /b 1
)
if "%WX_APPSECRET%"=="" (
  echo [错误] 请先设置 WX_APPSECRET 环境变量（小程序后台 - 开发管理 - 开发设置 - AppSecret）
  exit /b 1
)

if "%TCB_ENV_ID%"=="" set TCB_ENV_ID=ordering-d0gyct6z1ff2afebd

node server.js
