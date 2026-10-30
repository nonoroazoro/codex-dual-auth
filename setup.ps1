$ErrorActionPreference = 'Stop'
if (-not (Get-Command node -ErrorAction SilentlyContinue)) {
    throw 'Install Node.js 22 or newer, then run this script again.'
}
& node (Join-Path $PSScriptRoot 'src/cli.mjs') setup @args
exit $LASTEXITCODE
