import { getAgentHookLauncherPath } from './runtime-paths'
import { writeManagedScript } from './installer-utils'

// Why: all agents share one launcher script that reads endpoint.json (with
// {url, token}) and dispatches to /hook/<agent> based on the first argument.
// This avoids per-agent script duplication and ensures a single source of truth
// for the endpoint-file reading logic.
export function ensureLauncherScript(): void {
  const launcherPath = getAgentHookLauncherPath()
  const content =
    process.platform === 'win32' ? getWindowsLauncherScript() : getPosixLauncherScript()
  writeManagedScript(launcherPath, content)
}

function getWindowsLauncherScript(): string {
  return [
    '@echo off',
    'setlocal',
    // Why: agent name is the first argument (%1) — used to build /hook/<agent>
    'set AGENT=%1',
    'if "%AGENT%"=="" exit /b 0',
    '',
    // Why: fail-open when endpoint.json is missing (pre-install or TOCTOU race)
    'set ENDPOINT_FILE=%~dp0endpoint.json',
    'if not exist "%ENDPOINT_FILE%" exit /b 0',
    '',
    // Why: suppress stderr so a malformed JSON or TOCTOU unlink doesn't spam
    // agent transcripts with PowerShell parse errors. The fail-open path is
    // silent exit 0 regardless, so noise here is strictly harmful.
    'set MSYS_NO_PATHCONV=1',
    `powershell -NoProfile -ExecutionPolicy Bypass -Command "$ErrorActionPreference='SilentlyContinue'; try { $ep=Get-Content '%~dp0endpoint.json' -Raw | ConvertFrom-Json; if (-not $ep.url -or -not $ep.token) { exit 0 }; $payload=[Console]::In.ReadToEnd(); if ([string]::IsNullOrWhiteSpace($payload)) { exit 0 }; $body=@{ paneKey=$env:ORCA_PANE_KEY; tabId=$env:ORCA_TAB_ID; worktreeId=$env:ORCA_WORKTREE_ID; payload=($payload | ConvertFrom-Json) } | ConvertTo-Json -Depth 100 -Compress; $agent=$args[0]; Invoke-WebRequest -UseBasicParsing -Method Post -Uri ($ep.url + '/hook/' + $agent) -Headers @{ 'Content-Type'='application/json'; 'X-Orca-Agent-Hook-Token'=$ep.token } -Body $body -TimeoutSec 5 | Out-Null; exit 0 } catch { exit 0 }" "%AGENT%"`,
    'exit /b 0',
    ''
  ].join('\r\n')
}

function getPosixLauncherScript(): string {
  return [
    '#!/bin/sh',
    '# Why: agent name is the first argument ($1) — used to build /hook/<agent>',
    'agent="$1"',
    'if [ -z "$agent" ]; then',
    '  exit 0',
    'fi',
    '',
    '# Why: fail-open when endpoint.json is missing or unreadable',
    'endpoint_file="$(dirname "$0")/endpoint.json"',
    'if [ ! -r "$endpoint_file" ]; then',
    '  exit 0',
    'fi',
    '',
    '# Why: parse endpoint.json using python3 if available, otherwise sed',
    'parse_endpoint() {',
    '  if command -v python3 >/dev/null 2>&1; then',
    '    python3 -c "import json,sys;d=json.load(sys.stdin);print(d.get(\\"url\\",\\"\\"));print(d.get(\\"token\\",\\"\\"))" < "$endpoint_file" 2>/dev/null',
    '  else',
    '    # Why: fallback to sed for simple {"url":"...","token":"..."} shape',
    '    sed -n \'s/.*"url":"\\([^"]*\\)".*/\\1/p; s/.*"token":"\\([^"]*\\)".*/\\1/p\' "$endpoint_file" 2>/dev/null',
    '  fi',
    '}',
    '',
    'parsed=$(parse_endpoint)',
    'url=$(echo "$parsed" | sed -n \'1p\')',
    'token=$(echo "$parsed" | sed -n \'2p\')',
    '',
    'if [ -z "$url" ] || [ -z "$token" ]; then',
    '  exit 0',
    'fi',
    '',
    'payload=$(cat)',
    'if [ -z "$payload" ]; then',
    '  exit 0',
    'fi',
    '',
    '# Why: worktreeId may contain quotes/newlines; curl --data-urlencode handles escaping',
    'curl -sS -X POST "${url}/hook/${agent}" \\',
    '  -H "Content-Type: application/x-www-form-urlencoded" \\',
    '  -H "X-Orca-Agent-Hook-Token: ${token}" \\',
    '  --max-time 5 \\',
    '  --data-urlencode "paneKey=${ORCA_PANE_KEY}" \\',
    '  --data-urlencode "tabId=${ORCA_TAB_ID}" \\',
    '  --data-urlencode "worktreeId=${ORCA_WORKTREE_ID}" \\',
    '  --data-urlencode "payload=${payload}" >/dev/null 2>&1 || true',
    'exit 0',
    ''
  ].join('\n')
}
