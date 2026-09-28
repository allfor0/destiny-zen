# Update Docker MCP Image
# This script rebuilds and updates the destiny-zen Docker image

$ErrorActionPreference = "Stop"

Write-Host "=== Updating Destiny 2 MCP Docker Image ===" -ForegroundColor Cyan

# Step 1: Build TypeScript
Write-Host "`n[1/4] Building TypeScript..." -ForegroundColor Yellow
npm run build
if ($LASTEXITCODE -ne 0) {
    Write-Host "Build failed!" -ForegroundColor Red
    exit 1
}

# Step 2: Use this repository (it contains the Dockerfile) as the build context
Write-Host "`n[2/4] Using build context $PSScriptRoot" -ForegroundColor Yellow
$dockerBuildPath = $PSScriptRoot

# Step 3: Build Docker image
Write-Host "`n[3/4] Building Docker image..." -ForegroundColor Yellow
docker build -t destiny-zen:latest $dockerBuildPath
if ($LASTEXITCODE -ne 0) {
    Write-Host "Docker build failed!" -ForegroundColor Red
    exit 1
}

# Step 4: Verify
Write-Host "`n[4/4] Verifying image..." -ForegroundColor Yellow
docker images destiny-zen:latest

Write-Host "`n✓ Docker image updated successfully!" -ForegroundColor Green
Write-Host "`nNext steps:" -ForegroundColor Cyan
Write-Host "  1. Restart Claude Desktop (or your MCP client)"
Write-Host "  2. Or restart Docker Desktop if changes aren't detected"
Write-Host "`nTo test the image directly:" -ForegroundColor Cyan
Write-Host '  docker run --rm -e BUNGIE_API_KEY=$env:BUNGIE_API_KEY destiny-zen:latest' -ForegroundColor Gray
