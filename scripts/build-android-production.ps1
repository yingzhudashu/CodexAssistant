[CmdletBinding()]
param(
    [string]$SigningProperties = "$env:USERPROFILE\.codexassistant\android-release.properties",
    [string]$Output
)

$ErrorActionPreference = 'Stop'
$root = (Resolve-Path (Join-Path $PSScriptRoot '..')).Path
if (-not $Output) { $Output = Join-Path $root 'artifacts/android' }
if (-not (Test-Path -LiteralPath $SigningProperties)) { throw "Signing properties not found: $SigningProperties" }
$properties = @{}
Get-Content -LiteralPath $SigningProperties | ForEach-Object {
    if ($_ -match '^(?<key>[A-Za-z0-9_.-]+)=(?<value>.*)$') { $properties[$Matches.key] = $Matches.value }
}
foreach ($key in 'storeFile', 'storePassword', 'keyAlias', 'keyPassword') {
    if (-not $properties[$key]) { throw "Missing production Android property: $key" }
}
$env:CODEX_ASSISTANT_KEYSTORE = $properties.storeFile
$env:CODEX_ASSISTANT_KEYSTORE_PASSWORD = $properties.storePassword
$env:CODEX_ASSISTANT_KEY_ALIAS = $properties.keyAlias
$env:CODEX_ASSISTANT_KEY_PASSWORD = $properties.keyPassword
$outputPath = (Resolve-Path (New-Item -ItemType Directory -Force -Path $Output)).Path
Push-Location (Join-Path $root 'android')
try {
    & .\gradlew.bat --no-daemon assembleRelease
    if ($LASTEXITCODE) { throw 'Android production build failed.' }
} finally { Pop-Location }
$apk = Join-Path $root 'android/app/build/outputs/apk/release/app-release.apk'
if (-not (Test-Path -LiteralPath $apk)) { throw "APK not found: $apk" }
$version = (Select-String -Path (Join-Path $root 'android/app/build.gradle.kts') -Pattern 'versionName\s*=\s*"([^"]+)"').Matches[0].Groups[1].Value
$versionCode = [int](Select-String -Path (Join-Path $root 'android/app/build.gradle.kts') -Pattern 'versionCode\s*=\s*(\d+)').Matches[0].Groups[1].Value
$target = Join-Path $outputPath "CodexAssistant-$version.apk"
Copy-Item -LiteralPath $apk -Destination $target -Force
$hash = (Get-FileHash -LiteralPath $target -Algorithm SHA256).Hash.ToLowerInvariant()
$size = (Get-Item -LiteralPath $target).Length
$sdk = $env:ANDROID_HOME
if (-not $sdk) { $sdk = Join-Path $env:LOCALAPPDATA 'Android/Sdk' }
$apksigner = Get-ChildItem (Join-Path $sdk 'build-tools') -Filter apksigner.bat -Recurse | Sort-Object FullName -Descending | Select-Object -First 1
if (-not $apksigner) { throw 'apksigner was not found.' }
& $apksigner.FullName verify --verbose $target
if ($LASTEXITCODE) { throw 'APK signature verification failed.' }
$manifest = [ordered]@{ packageName = 'site.codexassistant'; versionName = $version; versionCode = $versionCode; releaseId = "$version-$hash"; apk = [ordered]@{ file = (Split-Path $target -Leaf); sha256 = $hash; sizeBytes = $size }; notificationMode = 'android-foreground-service' }
$manifest | ConvertTo-Json -Depth 5 | Set-Content -LiteralPath (Join-Path $outputPath 'manifest.json') -Encoding utf8
[pscustomobject]@{ Apk = $target; Manifest = (Join-Path $outputPath 'manifest.json'); Sha256 = $hash; SizeBytes = $size }
