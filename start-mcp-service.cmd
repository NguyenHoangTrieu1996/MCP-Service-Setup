@echo off
setlocal

title MCP Service Launcher

set "MCP_DIR=C:\MCP-Gateway"
set "TUNNEL_DIR=C:\MCP-Gateway\tunnel"
set "ENV_FILE=C:\MCP-Gateway\.env"

if not exist "%ENV_FILE%" (
  echo [ERROR] Khong tim thay %ENV_FILE%
  pause
  exit /b 1
)

for /f "usebackq tokens=1,* delims==" %%A in ("%ENV_FILE%") do (
  if /I "%%A"=="CONTROL_PLANE_API_KEY" set "CONTROL_PLANE_API_KEY=%%B"
)

if not defined CONTROL_PLANE_API_KEY (
  echo [ERROR] Khong tim thay CONTROL_PLANE_API_KEY trong .env
  pause
  exit /b 1
)

echo [OK] Da nap CONTROL_PLANE_API_KEY tu .env

echo [1/2] Khoi dong MCP Gateway...
start "MCP Gateway" /D "%MCP_DIR%" cmd /k npm start

timeout /t 3 /nobreak >nul

echo [2/2] Khoi dong OpenAI Secure MCP Tunnel...
start "OpenAI MCP Tunnel" /D "%TUNNEL_DIR%" cmd /k tunnel-client.exe run --profile windows-mcp

echo.
echo MCP Gateway va Tunnel da duoc khoi dong.
echo MCP Health    : http://127.0.0.1:3000/health
echo Tunnel Ready  : http://127.0.0.1:8080/readyz
echo.
timeout /t 3 /nobreak >nul

endlocal
exit /b 0
