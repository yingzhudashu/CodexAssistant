[CmdletBinding()]
param([string]$Output)

$ErrorActionPreference = 'Stop'
# 当前项目发布包明确标记为未签名；取得 Authenticode 证书后再由发布流程单独启用签名。
$root = (Resolve-Path (Join-Path $PSScriptRoot '..')).Path
if (-not $Output) { $Output = Join-Path $root 'artifacts/windows' }
$desktopPackage = Get-Content -Raw -LiteralPath (Join-Path $root 'apps/desktop/package.json') | ConvertFrom-Json
$version = [string]$desktopPackage.version
if ([string]::IsNullOrWhiteSpace($version)) { throw 'Desktop package version is missing.' }
$outputPath = (Resolve-Path (New-Item -ItemType Directory -Force -Path $Output)).Path
Push-Location $root
try {
    npm run package:win --workspace=@codex-assistant/desktop
    if ($LASTEXITCODE) { throw 'Windows production installer build failed.' }
} finally { Pop-Location }
$installer = Get-ChildItem (Join-Path $root 'apps/desktop/build') -Filter 'CodexAssistant Setup *.exe' | Where-Object { $_.Name -notlike '*.__uninstaller.exe' } | Sort-Object LastWriteTime -Descending | Select-Object -First 1
if (-not $installer) { throw 'NSIS installer was not produced.' }
$signature = Get-AuthenticodeSignature -LiteralPath $installer.FullName
$target = Join-Path $outputPath $installer.Name
Copy-Item -LiteralPath $installer.FullName -Destination $target -Force
$hash = (Get-FileHash -LiteralPath $target -Algorithm SHA256).Hash.ToLowerInvariant()
$size = (Get-Item $target).Length
$manifest = [ordered]@{ product = 'CodexAssistant'; version = $version; installer = [ordered]@{ file = (Split-Path $target -Leaf); sha256 = $hash; sizeBytes = $size }; signatureStatus = $signature.Status }
$manifest | ConvertTo-Json -Depth 5 | Set-Content -LiteralPath (Join-Path $outputPath 'manifest.json') -Encoding utf8
[pscustomobject]@{ Installer = $target; Manifest = (Join-Path $outputPath 'manifest.json'); Sha256 = $hash; SizeBytes = $size; SignatureStatus = $signature.Status }
