# Local setup for the AI Agent Software Platform (Windows PowerShell)
$ErrorActionPreference = 'Stop'
Set-Location (Join-Path $PSScriptRoot '..')

$node = (node --version) -replace '^v', ''
if ([version]$node -lt [version]'22.0.0') { throw "Node.js >= 22 required (found $node)" }
git --version | Out-Null

if (-not (Get-Command docker -ErrorAction SilentlyContinue)) {
  Write-Warning 'Docker not found: sandboxed execution (Phase 6+) will be unavailable until Docker is installed.'
}

npm install
npm run verify
Write-Host "Setup complete. Start the API with: npm run dev:api"
