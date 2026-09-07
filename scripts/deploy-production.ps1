[CmdletBinding()]
param([string]$Server = 'robotclaw-server')

$ErrorActionPreference = 'Stop'
$root = (Resolve-Path (Join-Path $PSScriptRoot '..')).Path
Push-Location $root
try {
    npm run build
    if ($LASTEXITCODE) { throw 'CodexAssistant build failed.' }
    $identity = (Get-FileHash package-lock.json -Algorithm SHA256).Hash.ToLowerInvariant().Substring(0, 12)
    $release = "{0}-{1}" -f (Get-Date).ToUniversalTime().ToString('yyyyMMddHHmmss'), $identity
    $stage = Join-Path $env:TEMP "codex-assistant-server-$release"
    $archive = Join-Path $stage 'server.tar.gz'
    New-Item -ItemType Directory -Force -Path $stage | Out-Null
    try {
        Copy-Item package.json, package-lock.json -Destination $stage
        foreach ($path in 'packages/protocol', 'apps/server', 'apps/desktop') {
            $destination = Join-Path $stage $path
            New-Item -ItemType Directory -Force -Path $destination | Out-Null
            Copy-Item (Join-Path $root "$path/package.json") -Destination $destination
        }
        Copy-Item (Join-Path $root 'packages/protocol/dist') -Destination (Join-Path $stage 'packages/protocol/dist') -Recurse
        Copy-Item (Join-Path $root 'apps/server/dist') -Destination (Join-Path $stage 'apps/server/dist') -Recurse
        tar -czf $archive -C $stage package.json package-lock.json packages apps
        if ($LASTEXITCODE) { throw 'Unable to create the server release archive.' }
        $sha256 = (Get-FileHash $archive -Algorithm SHA256).Hash.ToLowerInvariant()
        $remoteTmp = "/tmp/codex-assistant-$release"
        scp -- $archive "${Server}:$remoteTmp.tar.gz"
        scp -- (Join-Path $root 'deploy/codex-assistant.service') "${Server}:$remoteTmp.service"
        scp -- (Join-Path $root 'deploy/nginx-codex-assistant.locations.conf') "${Server}:$remoteTmp.nginx"
        if ($LASTEXITCODE) { throw 'Unable to upload CodexAssistant release files.' }
        $remote = @'
set -euo pipefail
release='__RELEASE__'
sha='__SHA256__'
tmp='__TMP__'
archive="$tmp.tar.gz"
unit="$tmp.service"
snippet="$tmp.nginx"
app=/opt/codex-assistant
target="$app/releases/$release"
current="$app/current"
state=/var/lib/codex-assistant
environment=/etc/codex-assistant/codex-assistant.env
nginx_config=/etc/nginx/sites-available/robotclaw.conf
nginx_backup="$nginx_config.codex-assistant-$release.bak"
previous=''
nginx_changed=0
created_target=0
rollback() {
  status=$?
  trap - EXIT
  if [ "$status" -ne 0 ]; then
    if [ -n "$previous" ]; then
      sudo ln -sfn "$previous" "$current.rollback"
      sudo mv -Tf "$current.rollback" "$current"
      sudo systemctl restart codex-assistant.service || true
    elif [ -L "$current" ]; then
      sudo rm -f "$current"
      sudo systemctl stop codex-assistant.service || true
    fi
    if [ "$created_target" -eq 1 ] && [ -d "$target" ]; then sudo rm -rf -- "$target"; fi
    if [ "$nginx_changed" -eq 1 ] && [ -f "$nginx_backup" ]; then
      sudo mv -f "$nginx_backup" "$nginx_config"
      sudo nginx -t && sudo systemctl reload nginx || true
    fi
  fi
  sudo rm -f "$archive" "$unit" "$snippet" || true
  exit "$status"
}
trap rollback EXIT
sudo id codexassistant >/dev/null 2>&1 || sudo useradd --system --home-dir "$state" --create-home --shell /usr/sbin/nologin codexassistant
sudo install -d -o codexassistant -g codexassistant -m 0750 "$app/releases" "$state"
sudo install -d -o root -g root -m 0755 /srv/www/codex-assistant/downloads
sudo install -d -o root -g root -m 0750 /etc/codex-assistant
test ! -e "$target"
echo "$sha  $archive" | sha256sum -c -
sudo install -d -o codexassistant -g codexassistant -m 0750 "$target"
sudo tar -xzf "$archive" -C "$target"
created_target=1
sudo chown -R codexassistant:codexassistant "$target"
sudo -u codexassistant -- env PATH=/opt/node-v22.23.2-linux-x64/bin:/usr/local/sbin:/usr/local/bin:/usr/sbin:/usr/bin NPM_CONFIG_CACHE="$state/npm-cache" /opt/node-v22.23.2-linux-x64/bin/npm ci --omit=dev --ignore-scripts --no-audit --no-fund --workspace=@codex-assistant/server --prefix "$target"
if ! sudo test -f "$environment"; then
  token="$(/opt/node-v22.23.2-linux-x64/bin/node -e 'process.stdout.write(require("node:crypto").randomBytes(32).toString("hex"))')"
  sudo sh -c "printf '%s\n' 'CODEX_ASSISTANT_ACCESS_TOKEN=$token' > '$environment'"
  sudo chmod 0600 "$environment"
fi
sudo install -o root -g root -m 0644 "$unit" /etc/systemd/system/codex-assistant.service
sudo install -o root -g root -m 0644 "$snippet" /etc/nginx/snippets/codex-assistant.locations.conf
if ! grep -Fqx '    include /etc/nginx/snippets/codex-assistant.locations.conf;' "$nginx_config"; then
  sudo cp -a "$nginx_config" "$nginx_backup"
  sudo python3 - "$nginx_config" <<'PY'
from pathlib import Path
import sys
path = Path(sys.argv[1])
source = path.read_text(encoding="utf-8")
needle = "    location ^~ /assets/ {"
include = "    include /etc/nginx/snippets/codex-assistant.locations.conf;\n\n"
if source.count(needle) != 1:
    raise SystemExit("Unable to identify the production RobotClaw server block")
path.write_text(source.replace(needle, include + needle, 1), encoding="utf-8")
PY
  nginx_changed=1
fi
sudo nginx -t
if [ -L "$current" ]; then previous="$(readlink "$current")"; fi
sudo ln -sfn "$target" "$current.next"
sudo mv -Tf "$current.next" "$current"
sudo systemctl daemon-reload
sudo systemctl enable codex-assistant.service
sudo systemctl restart codex-assistant.service
for _ in $(seq 1 30); do
  curl -fsS http://127.0.0.1:3240/codex-assistant/health >/dev/null && break
  sleep 1
done
curl -fsS http://127.0.0.1:3240/codex-assistant/health >/dev/null
sudo systemctl reload nginx
curl -fsS https://robotclaw.site/codex-assistant/health >/dev/null
mapfile -t releases < <(sudo find "$app/releases" -mindepth 1 -maxdepth 1 -type d -printf '%T@ %p\n' | sort -rn | awk '{print $2}')
for old in "${releases[@]:5}"; do sudo rm -rf -- "$old"; done
sudo rm -f "$nginx_backup" "$archive" "$unit" "$snippet"
echo "CodexAssistant production release active: $release"
'@
        $remote = $remote.Replace('__RELEASE__', $release).Replace('__SHA256__', $sha256).Replace('__TMP__', $remoteTmp)
        $remote | ssh -o BatchMode=yes $Server "tr -d '\r' | bash -s"
        if ($LASTEXITCODE) { throw 'CodexAssistant production deployment failed.' }
        Write-Output "ProductionRelease=$release`nArchiveSha256=$sha256"
    } finally {
        Remove-Item -LiteralPath $stage -Recurse -Force -ErrorAction SilentlyContinue
    }
} finally { Pop-Location }
