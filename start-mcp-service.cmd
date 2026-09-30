@echo off
setlocal
title MCP Service Launcher
set "MCP_LAUNCHER_FILE=%~f0"

powershell.exe -NoLogo -NoProfile -Command "try { $text = Get-Content -LiteralPath $env:MCP_LAUNCHER_FILE -Raw; $parts = $text -split '(?m)^# POWERSHELL_SECTION\r?$', 2; if ($parts.Count -ne 2) { throw 'Khong tim thay ma PowerShell.' }; & ([scriptblock]::Create($parts[1])) } catch { Write-Host ('[ERROR] ' + $_.Exception.Message) -ForegroundColor Red; exit 1 }"
if errorlevel 1 (
    echo Kiem tra loi o tren va log trong C:\MCP-Gateway\logs.
    pause
    exit /b 1
)
exit /b 0

# POWERSHELL_SECTION
$ErrorActionPreference = 'Stop'
$mcpDir = 'C:\MCP-Gateway'
$tunnelDir = Join-Path $mcpDir 'tunnel'
$envFile = Join-Path $mcpDir '.env'
$tunnelExe = Join-Path $tunnelDir 'tunnel-client.exe'
$logDir = Join-Path $mcpDir 'logs'

foreach ($file in @($envFile, $tunnelExe, (Join-Path $mcpDir 'package.json'))) {
    if (-not (Test-Path -LiteralPath $file -PathType Leaf)) {
        throw "Khong tim thay $file"
    }
}
$null = Get-Command npm.cmd -ErrorAction Stop
$null = Get-Command node.exe -ErrorAction Stop

$apiKey = ''
foreach ($line in Get-Content -LiteralPath $envFile -Encoding UTF8) {
    if ($line -match '^\s*CONTROL_PLANE_API_KEY\s*=(.*)$') {
        $apiKey = $Matches[1].Trim()
        if ($apiKey.Length -ge 2) {
            $first = $apiKey[0]
            $last = $apiKey[$apiKey.Length - 1]
            if (($first -eq [char]34 -and $last -eq [char]34) -or
                ($first -eq [char]39 -and $last -eq [char]39)) {
                $apiKey = $apiKey.Substring(1, $apiKey.Length - 2)
            }
        }
    }
}
if ([string]::IsNullOrWhiteSpace($apiKey)) {
    throw 'Khong tim thay CONTROL_PLANE_API_KEY trong .env'
}
$env:CONTROL_PLANE_API_KEY = $apiKey
$null = New-Item -ItemType Directory -Path $logDir -Force

$gateway = Start-Process -FilePath $env:ComSpec -ArgumentList '/d /c npm.cmd start' -WorkingDirectory $mcpDir -WindowStyle Hidden -RedirectStandardOutput (Join-Path $logDir 'mcp-server.log') -RedirectStandardError (Join-Path $logDir 'mcp-server-error.log') -PassThru

Start-Sleep -Seconds 3
if ($gateway.HasExited) {
    throw 'MCP Gateway da thoat. Xem mcp-server.log va mcp-server-error.log.'
}

$tunnel = Start-Process -FilePath $tunnelExe -ArgumentList 'run --profile windows-mcp' -WorkingDirectory $tunnelDir -WindowStyle Hidden -RedirectStandardOutput (Join-Path $logDir 'mcp-tunnel.log') -RedirectStandardError (Join-Path $logDir 'mcp-tunnel-error.log') -PassThru

Start-Sleep -Seconds 1
if ($tunnel.HasExited) {
    throw 'Tunnel da thoat. Xem mcp-tunnel.log va mcp-tunnel-error.log. Gateway co the van dang chay.'
}
Write-Host '[OK] Da khoi chay hai tien trinh an. Xem log de kiem tra ket noi.'
