[CmdletBinding(SupportsShouldProcess)]
param()

$ErrorActionPreference = 'Stop'
$root = (Resolve-Path -LiteralPath (Join-Path $PSScriptRoot '..')).Path
# 只删除固定的生成目录，不扫描任意同名目录，也不触碰业务状态、依赖或签名材料。
$relativeTargets = @(
    'artifacts', 'apps/desktop/build', 'apps/desktop/dist', 'apps/desktop/tsconfig.tsbuildinfo',
    'apps/server/dist', 'apps/server/tsconfig.tsbuildinfo',
    'packages/protocol/dist', 'packages/protocol/tsconfig.tsbuildinfo',
    'android/build', 'android/app/build', 'android/.gradle', 'android/.kotlin',
    'test-results', 'coverage', 'playwright-report'
)
$targets = @()
foreach ($relative in $relativeTargets) {
    $target = [IO.Path]::GetFullPath((Join-Path $root $relative))
    if (-not $target.StartsWith($root + [IO.Path]::DirectorySeparatorChar, [StringComparison]::OrdinalIgnoreCase)) {
        throw "清理目标超出项目目录：$target"
    }
    # Windows junction/symlink 可能指向项目之外；删除前检查目标及全部父目录。
    $cursor = $target
    while ($cursor.Length -ge $root.Length) {
        if (Test-Path -LiteralPath $cursor) {
            $item = Get-Item -LiteralPath $cursor -Force
            if ($item.Attributes -band [IO.FileAttributes]::ReparsePoint) {
                throw "清理路径包含链接，请先人工核对：$cursor"
            }
        }
        if ($cursor -eq $root) { break }
        $cursor = Split-Path -Parent $cursor
    }
    if (Test-Path -LiteralPath $target) {
        if ((Get-Item -LiteralPath $target).PSIsContainer) {
            $links = @(Get-ChildItem -LiteralPath $target -Recurse -Force -Attributes ReparsePoint)
            if ($links.Count -gt 0) { throw "清理目录内存在链接，请先人工核对：$target" }
        }
        $targets += $target
    }
}
# 所有目标通过范围检查后再删除；先用 -WhatIf 可以查看将删除的准确路径。
foreach ($target in $targets) {
    if ($PSCmdlet.ShouldProcess($target, '删除构建产物和临时文件')) {
        Remove-Item -LiteralPath $target -Recurse -Force
    }
}
