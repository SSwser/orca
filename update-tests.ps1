# Script to update server.test.ts for Task 4 changes
$file = "src\main\agent-hooks\server.test.ts"
$content = Get-Content $file -Raw

# Replace buildPtyEnv() usage patterns with getEndpointCoordinates()
$content = $content -replace 'const env = server\.buildPtyEnv\(\)', 'const { port, token } = server.getEndpointCoordinates()'
$content = $content -replace 'env\.ORCA_AGENT_HOOK_PORT', 'String(port)'
$content = $content -replace 'env\.ORCA_AGENT_HOOK_TOKEN', 'token'
$content = $content -replace 'server\.buildPtyEnv\(\)\.ORCA_AGENT_HOOK_PORT', 'String(server.getEndpointCoordinates().port)'
$content = $content -replace 'server\.buildPtyEnv\(\)\.ORCA_AGENT_HOOK_TOKEN', 'server.getEndpointCoordinates().token'

# Replace env.ORCA_AGENT_HOOK_VERSION references  
$content = $content -replace 'env\.ORCA_AGENT_HOOK_VERSION', '"1"'

$content | Set-Content $file -NoNewline
Write-Host "Updated $file"
