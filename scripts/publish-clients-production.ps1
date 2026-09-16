[CmdletBinding()]
param(
    [Parameter(Mandatory)][ValidatePattern('^[A-Za-z0-9][A-Za-z0-9_.@-]*$')][string]$Server,
    [Parameter(Mandatory)][ValidatePattern('^https://[A-Za-z0-9.-]+(:[0-9]{1,5})?$')][string]$PublicOrigin
)

$ErrorActionPreference = 'Stop'
$root = (Resolve-Path (Join-Path $PSScriptRoot '..')).Path
$windows = Get-Content -Raw -LiteralPath (Join-Path $root 'artifacts/windows/manifest.json') | ConvertFrom-Json
$android = Get-Content -Raw -LiteralPath (Join-Path $root 'artifacts/android/manifest.json') | ConvertFrom-Json
$windowsVersion = (Get-Content -Raw -LiteralPath (Join-Path $root 'apps/desktop/package.json') | ConvertFrom-Json).version
$androidSource = Get-Content -Raw -LiteralPath (Join-Path $root 'android/app/build.gradle.kts')
$androidVersion = [regex]::Match($androidSource, 'versionName\s*=\s*"([^"]+)"').Groups[1].Value
$androidCode = [int][regex]::Match($androidSource, 'versionCode\s*=\s*(\d+)').Groups[1].Value
if ($windows.version -ne $windowsVersion -or $android.versionName -ne $androidVersion -or $android.versionCode -ne $androidCode) {
    throw 'Build manifests differ from source versions; rebuild before publishing.'
}
# 下载地址来自本次明确指定的部署目标，联合清单只写入被忽略的产物目录。
$baseUrl = "$PublicOrigin/codex-assistant/downloads"
$downloads = [ordered]@{}
foreach ($platform in 'windows', 'android') {
    $build = if ($platform -eq 'windows') { $windows } else { $android }
    $artifact = if ($platform -eq 'windows') { $build.installer } else { $build.apk }
    $version = if ($platform -eq 'windows') { [string]$build.version } else { [string]$build.versionName }
    if ($version -notmatch '^\d+\.\d+\.\d+$' -or [IO.Path]::GetFileName($artifact.file) -ne $artifact.file) {
        throw 'Invalid artifact version or file name.'
    }
    $path = Join-Path $root "artifacts/$platform/$($artifact.file)"
    if ((Get-Item -LiteralPath $path).Length -ne $artifact.sizeBytes -or (Get-FileHash -LiteralPath $path -Algorithm SHA256).Hash.ToLowerInvariant() -ne $artifact.sha256) {
        throw "Artifact hash or size mismatch: $platform"
    }
    $extension = if ($platform -eq 'windows') { 'exe' } else { 'apk' }
    $file = "CodexAssistant-$version.$extension"
    $entry = [ordered]@{ versionName = $version; file = $file; url = "$baseUrl/$file"; sha256 = $artifact.sha256; sizeBytes = $artifact.sizeBytes }
    if ($platform -eq 'windows') { $entry.signatureStatus = $build.signatureStatus } else { $entry.versionCode = $build.versionCode }
    $downloads[$platform] = $entry
}
$manifest = [ordered]@{ product = 'CodexAssistant'; protocolVersion = 'codex-assistant.v3'; version = $windows.version; releasedAt = (Get-Date).ToUniversalTime().ToString('o'); downloads = $downloads }
$manifestPath = Join-Path $root 'artifacts/manifest.json'
# 明确使用无 BOM UTF-8；联合清单是客户端更新的唯一提交点。
[IO.File]::WriteAllText($manifestPath, ($manifest | ConvertTo-Json -Depth 8) + "`n", [Text.UTF8Encoding]::new($false))
$remoteStage = '/tmp/codex-assistant-downloads-' + [guid]::NewGuid().ToString('N')
ssh -o BatchMode=yes $Server "mkdir -m 700 '$remoteStage'"
if ($LASTEXITCODE) { throw 'Unable to create upload directory.' }
foreach ($platform in 'windows', 'android') {
    $artifact = if ($platform -eq 'windows') { $windows.installer } else { $android.apk }
    $path = Join-Path $root "artifacts/$platform/$($artifact.file)"
    scp -- $path "${Server}:$remoteStage/$($downloads[$platform].file)"
    if ($LASTEXITCODE) { throw "Unable to upload $platform; upload directory retained: $remoteStage" }
}
scp -- $manifestPath "${Server}:$remoteStage/manifest.json"
if ($LASTEXITCODE) { throw 'Unable to upload joint manifest.' }
$remote = @'
import hashlib, json, os, shutil, sys, urllib.request
from pathlib import Path

stage = Path(sys.argv[1])
destination = Path('/srv/www/codex-assistant/downloads')
manifest_path = destination / 'manifest.json'
raw = (stage / 'manifest.json').read_bytes()
manifest = json.loads(raw)
previous = json.loads(manifest_path.read_bytes()) if manifest_path.exists() else None

def digest(source):
    result = hashlib.sha256()
    size = 0
    while chunk := source.read(1024 * 1024):
        result.update(chunk)
        size += len(chunk)
    return result.hexdigest(), size

# 校验全部上传文件和版本再修改下载目录；同名发布文件永不覆盖。
for platform, entry in manifest['downloads'].items():
    assert Path(entry['file']).name == entry['file']
    if previous:
        old = previous['downloads'][platform]
        assert tuple(map(int, entry['versionName'].split('.'))) >= tuple(map(int, old['versionName'].split('.'))), 'Version downgrade refused'
        if platform == 'android':
            assert entry['versionCode'] >= old['versionCode'], 'Android code downgrade refused'
            if entry['versionName'] != old['versionName']:
                assert entry['versionCode'] > old['versionCode'], 'Android update needs a new code'
    expected = (entry['sha256'], entry['sizeBytes'])
    with (stage / entry['file']).open('rb') as source:
        assert digest(source) == expected, 'Upload verification failed'
    target = destination / entry['file']
    if target.exists():
        with target.open('rb') as source:
            assert digest(source) == expected, 'Immutable artifact already exists with different bytes'

for entry in manifest['downloads'].values():
    target = destination / entry['file']
    if not target.exists():
        temporary = destination / ('.' + stage.name + '-' + entry['file'])
        shutil.copyfile(stage / entry['file'], temporary)
        os.chmod(temporary, 0o644)
        try:
            os.link(temporary, target)
        finally:
            temporary.unlink()
    # 经公网 HTTPS 完整读取，不以 HEAD 或服务器磁盘哈希代替下载校验。
    with urllib.request.urlopen(entry['url'], timeout=180) as response:
        assert 'immutable' in response.headers.get('Cache-Control', '')
        assert digest(response) == (entry['sha256'], entry['sizeBytes']), 'Public download verification failed'
    print('Verified public download: ' + entry['file'], flush=True)

temporary_manifest = destination / ('.' + stage.name + '-manifest.json')
temporary_manifest.write_bytes(raw)
os.chmod(temporary_manifest, 0o644)
os.replace(temporary_manifest, manifest_path)
with urllib.request.urlopen(sys.argv[2] + '/manifest.json', timeout=30) as response:
    assert 'no-store' in response.headers.get('Cache-Control', '')
    assert response.read() == raw, 'Public manifest verification failed'
# 只删除本次创建且已校验的上传文件，不递归清理其他目录。
for entry in manifest['downloads'].values():
    (stage / entry['file']).unlink()
(stage / 'manifest.json').unlink()
stage.rmdir()
print('Client manifest published and verified')
'@
$remote | ssh -o BatchMode=yes $Server "sudo -n python3 - '$remoteStage' '$baseUrl'"
if ($LASTEXITCODE) { throw 'Client publication failed; inspect the upload directory and current manifest.' }
$published = Invoke-WebRequest -Uri "$baseUrl/manifest.json" -TimeoutSec 30
# 直接比较发布文本，避免不同 PowerShell 版本把 JSON 时间自动转成 DateTime。
if ([string]$published.Content -cne [IO.File]::ReadAllText($manifestPath)) { throw 'External manifest verification failed.' }
Write-Output "Published Windows $($windows.version), Android $($android.versionName)/$($android.versionCode)"
