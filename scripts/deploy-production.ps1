[CmdletBinding()]
param(
    [Parameter(Mandatory)][ValidatePattern('^[A-Za-z0-9][A-Za-z0-9_.@-]*$')][string]$Server,
    [Parameter(Mandatory)][ValidatePattern('^https://[A-Za-z0-9.-]+(:[0-9]{1,5})?$')][string]$PublicOrigin,
    [Parameter(Mandatory)][ValidatePattern('^/etc/nginx/[A-Za-z0-9_./-]+$')][string]$NginxConfig
)

$ErrorActionPreference = 'Stop'
# 真实部署坐标由操作者显式传入，不在源码中保存私人主机或域名。
if ($NginxConfig.Split('/') -contains '..') { throw 'Nginx config must not contain parent traversal.' }
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
        if ($LASTEXITCODE) { throw 'Unable to upload the server archive.' }
        scp -- (Join-Path $root 'deploy/codex-assistant.service') "${Server}:$remoteTmp.service"
        if ($LASTEXITCODE) { throw 'Unable to upload the service unit.' }
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
nginx_config='__NGINX_CONFIG__'
backup="/var/backups/codex-assistant/$release"
previous="$(sudo readlink "$current" || true)"
configs_changed=0
service_touched=0
state_changed=0
sudo install -d -m 0700 "$backup"
for config in /etc/systemd/system/codex-assistant.service /etc/nginx/snippets/codex-assistant.locations.conf "$nginx_config"; do
  if sudo test -f "$config"; then sudo cp -a "$config" "$backup/$(basename "$config")"; fi
done
rollback() {
  status=$?
  trap - EXIT
  if [ "$status" -ne 0 ]; then
    if [ "$service_touched" -eq 1 ]; then sudo systemctl stop codex-assistant.service || true; fi
    if [ "$state_changed" -eq 1 ]; then
      sudo install -d -m 0700 "$backup/failed-new-state"
      for name in codex-assistant.sqlite codex-assistant.sqlite-wal codex-assistant.sqlite-shm; do
        if sudo test -f "$state/$name"; then sudo mv "$state/$name" "$backup/failed-new-state/$name"; fi
        if sudo test -f "$backup/$name"; then sudo mv "$backup/$name" "$state/$name"; fi
      done
    fi
    if [ "$configs_changed" -eq 1 ]; then
      for config in /etc/systemd/system/codex-assistant.service /etc/nginx/snippets/codex-assistant.locations.conf "$nginx_config"; do
        if sudo test -f "$backup/$(basename "$config")"; then sudo cp -a "$backup/$(basename "$config")" "$config"; else sudo rm -f "$config"; fi
      done
      sudo systemctl daemon-reload
      sudo nginx -t && sudo systemctl reload nginx || true
    fi
    if [ "$service_touched" -eq 1 ]; then
      if [ -n "$previous" ]; then
        sudo ln -sfn "$previous" "$current.rollback"
        sudo mv -Tf "$current.rollback" "$current"
        sudo systemctl restart codex-assistant.service || true
      else
        sudo rm -f "$current"
      fi
    fi
    echo "Deployment failed; preserved release and recovery data at $backup" >&2
  fi
  sudo rm -f "$archive" "$unit" "$snippet" || true
  exit "$status"
}
trap rollback EXIT
sudo id codexassistant >/dev/null 2>&1 || sudo useradd --system --home-dir "$state" --create-home --shell /usr/sbin/nologin codexassistant
sudo install -d -o codexassistant -g codexassistant -m 0750 "$app/releases" "$state"
sudo install -d -o root -g root -m 0755 /srv/www/codex-assistant/downloads
sudo install -d -o root -g root -m 0750 /etc/codex-assistant
sudo test ! -e "$target"
echo "$sha  $archive" | sha256sum -c -
sudo install -d -o codexassistant -g codexassistant -m 0750 "$target"
sudo tar -xzf "$archive" -C "$target"
sudo chown -R codexassistant:codexassistant "$target"
sudo -u codexassistant -- env PATH=/opt/node-v22.23.2-linux-x64/bin:/usr/local/sbin:/usr/local/bin:/usr/sbin:/usr/bin NPM_CONFIG_CACHE="$state/npm-cache" /opt/node-v22.23.2-linux-x64/bin/npm ci --omit=dev --ignore-scripts --no-audit --no-fund --workspace=@codex-assistant/server --prefix "$target"
if ! sudo test -f "$environment"; then
  token="$(/opt/node-v22.23.2-linux-x64/bin/node -e 'process.stdout.write(require("node:crypto").randomBytes(32).toString("hex"))')"
  sudo sh -c "printf '%s\n' 'CODEX_ASSISTANT_ACCESS_TOKEN=$token' > '$environment'"
  sudo chmod 0600 "$environment"
fi
configs_changed=1
sudo install -o root -g root -m 0644 "$unit" /etc/systemd/system/codex-assistant.service
sudo install -o root -g root -m 0644 "$snippet" /etc/nginx/snippets/codex-assistant.locations.conf
if ! grep -Fqx '    include /etc/nginx/snippets/codex-assistant.locations.conf;' "$nginx_config"; then
  sudo python3 - "$nginx_config" <<'PY'
from pathlib import Path
import sys
path = Path(sys.argv[1])
source = path.read_text(encoding="utf-8")
needle = "    location ^~ /assets/ {"
include = "    include /etc/nginx/snippets/codex-assistant.locations.conf;\n\n"
if source.count(needle) != 1:
    raise SystemExit("Unable to identify the HTTPS server block; configure the include explicitly")
path.write_text(source.replace(needle, include + needle, 1), encoding="utf-8")
PY
fi
sudo nginx -t
# Incompatible schema starts from empty state. Keep the old DB/WAL for rollback;
# never migrate data or reopen the new database with the previous release.
expected_schema="$(sudo sed -n 's/^const SCHEMA_VERSION = \([0-9]*\);/\1/p' "$target/apps/server/dist/database.js")"
test -n "$expected_schema"
if sudo test -f "$state/codex-assistant.sqlite"; then
  existing_schema="$(sudo python3 - "$state/codex-assistant.sqlite" <<'PY'
import sqlite3, sys
with sqlite3.connect('file:' + sys.argv[1] + '?mode=ro', uri=True) as connection:
    print(connection.execute('PRAGMA user_version').fetchone()[0])
PY
)"
  if [ "$existing_schema" != "$expected_schema" ]; then
    service_touched=1
    sudo systemctl stop codex-assistant.service
    state_changed=1
    for name in codex-assistant.sqlite codex-assistant.sqlite-wal codex-assistant.sqlite-shm; do
      if sudo test -f "$state/$name"; then sudo mv "$state/$name" "$backup/$name"; fi
    done
  fi
fi
service_touched=1
sudo ln -sfn "$target" "$current.next"
sudo mv -Tf "$current.next" "$current"
sudo systemctl daemon-reload
sudo systemctl enable codex-assistant.service
sudo systemctl restart codex-assistant.service
for _ in $(seq 1 30); do
  curl -fsS http://127.0.0.1:3240/codex-assistant/health >/dev/null && break
  sleep 1
done
curl -fsS http://127.0.0.1:3240/codex-assistant/health | python3 -c 'import json,sys; assert json.load(sys.stdin)["protocolVersion"] == "codex-assistant.v3"'
sudo systemctl reload nginx
curl -fsS '__PUBLIC_ORIGIN__/codex-assistant/health' | python3 -c 'import json,sys; assert json.load(sys.stdin)["protocolVersion"] == "codex-assistant.v3"'
mapfile -t releases < <(sudo find "$app/releases" -mindepth 1 -maxdepth 1 -type d -printf '%T@ %p\n' | sort -rn | awk '{print $2}')
for old in "${releases[@]:5}"; do sudo rm -rf -- "$old"; done
sudo rm -f "$archive" "$unit" "$snippet"
echo "CodexAssistant production release active: $release"
echo "RecoveryBackup=$backup"
'@
        $remote = $remote.Replace('__RELEASE__', $release).Replace('__SHA256__', $sha256).Replace('__TMP__', $remoteTmp).Replace('__PUBLIC_ORIGIN__', $PublicOrigin).Replace('__NGINX_CONFIG__', $NginxConfig)
        $remote | ssh -o BatchMode=yes $Server "tr -d '\r' | bash -s"
        if ($LASTEXITCODE) { throw 'CodexAssistant production deployment failed.' }
        Write-Output "ProductionRelease=$release`nArchiveSha256=$sha256"
    } finally {
        Remove-Item -LiteralPath $stage -Recurse -Force -ErrorAction SilentlyContinue
    }
} finally { Pop-Location }
