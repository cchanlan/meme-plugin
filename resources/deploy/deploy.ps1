#!/usr/bin/env pwsh
<#
  meme-generator 一键部署脚本（Windows / PowerShell 版）

  与同目录的 deploy.sh 逐步对应，输出同一套 ::STEP:: / ::OK:: / ::FAIL:: 标记，
  由 apps/deploy.js 统一解析。全程幂等：venv 在就复用、仓库在就 pull、
  pm2 有同名就 restart，可以重复执行。

  用法: deploy.ps1 <数据目录> <pm2进程名> [pip镜像] [git代理前缀] [监听端口]
#>
param(
  [Parameter(Mandatory = $true)][string]$DataDir,
  [string]$Pm2Name = 'meme-plugin',
  [string]$PipIndex = '',
  [string]$GitProxy = '',
  # 机器上已经有一个 meme 服务占着 2233 时，新装的这套必须换端口
  [int]$Port = 2233
)

$ErrorActionPreference = 'Continue'

# 输出编码钉成 UTF-8：Windows PowerShell 5.1 重定向到管道时默认走系统 ANSI(GBK)，
# 调用方（Node）按 UTF-8 读，中文步骤名和报错就全是乱码。pwsh 7 本来就是 UTF-8，设了无害。
try {
  [Console]::OutputEncoding = [System.Text.Encoding]::UTF8
  $OutputEncoding = [System.Text.Encoding]::UTF8
} catch {}

$VenvDir = Join-Path $DataDir 'venv'
$ReposDir = Join-Path $DataDir 'repos'
# Windows 上 meme-generator 读 %APPDATA%\meme_generator ——
# 它用 nonebot plugin-localstore 的规则，user_config_dir 默认 roaming=True，
# 所以是 Roaming 不是 Local。填成 LocalAppData 服务就读不到这份配置。
$ConfigDir = Join-Path $env:APPDATA 'meme_generator'
$ConfigFile = Join-Path $ConfigDir 'config.toml'
# venv 里可执行文件在 Scripts\ 而不是 bin\
$VenvPy = Join-Path $VenvDir 'Scripts\python.exe'
$VenvPip = Join-Path $VenvDir 'Scripts\pip.exe'
$VenvMeme = Join-Path $VenvDir 'Scripts\meme.exe'

function Step($m) { Write-Output "::STEP::$m" }
function Ok($m) { Write-Output "::OK::$m" }
function Fail($m) { Write-Output "::FAIL::$m"; exit 1 }

# 订阅的表情仓库：目录名 / git 地址 / 分支 / 表情子目录
# 子目录各仓库不一样（emoji / memes / meme），填错会让 meme_dirs 指向不存在的路径
$Repos = @(
  @{ dir = 'meme_emoji'; url = 'https://github.com/anyliew/meme_emoji'; branch = 'main'; sub = 'emoji' }
  @{ dir = 'crazy_emoji'; url = 'https://github.com/anyliew/crazy_emoji'; branch = 'main'; sub = 'emoji' }
  @{ dir = 'meme-generator-contrib'; url = 'https://github.com/MemeCrafters/meme-generator-contrib'; branch = 'main'; sub = 'memes' }
  @{ dir = 'meme-generator-jj'; url = 'https://github.com/jinjiao007/meme-generator-jj'; branch = 'master'; sub = 'memes' }
  @{ dir = 'tudou-meme'; url = 'https://github.com/LRZ9712/tudou-meme'; branch = 'main'; sub = 'meme' }
)

# ── 1. 环境自检 ────────────────────────────────────────
Step '检查运行环境'

if (-not (Get-Command git -ErrorAction SilentlyContinue)) {
  Fail '缺少 git，请先安装：https://git-scm.com/download/win'
}
if (-not (Get-Command pm2 -ErrorAction SilentlyContinue)) {
  Fail '缺少 pm2，请先安装：npm i -g pm2'
}

# 找一个 3.9+ 的 Python。Windows 上优先用 py 启动器，它能列出所有已装版本
$Py = $null
foreach ($cand in @('python', 'python3', 'py')) {
  if (-not (Get-Command $cand -ErrorAction SilentlyContinue)) { continue }
  $ver = & $cand -c 'import sys;print(f"{sys.version_info[0]}.{sys.version_info[1]}")' 2>$null
  if ($LASTEXITCODE -ne 0 -or -not $ver) { continue }
  $parts = $ver.Trim().Split('.')
  if ($parts[0] -eq '3' -and [int]$parts[1] -ge 9) { $Py = $cand; break }
}
if (-not $Py) { Fail '需要 Python 3.9+，当前没找到合适的版本（装的时候记得勾 Add to PATH）' }
Ok "环境就绪（$(& $Py --version 2>&1), git, pm2）"

# ── 2. 建 venv ────────────────────────────────────────
Step '准备 Python 虚拟环境'
if (Test-Path $VenvPy) {
  Ok 'venv 已存在，复用'
} else {
  New-Item -ItemType Directory -Force -Path $DataDir | Out-Null
  & $Py -m venv $VenvDir 2>&1 | Out-Null
  if (-not (Test-Path $VenvPy)) { Fail '创建 venv 失败' }
  Ok 'venv 创建完成'
}

# ── 3. 装 meme-generator ──────────────────────────────
Step '安装 meme-generator（skia-python 较大，可能要几分钟）'
$PipArgs = @()
if ($PipIndex) { $PipArgs = @('-i', $PipIndex) }

if (Test-Path $VenvMeme) {
  $verLine = (& $VenvMeme --version 2>&1) -join ' '
  $m = [regex]::Match($verLine, '[0-9]+\.[0-9]+(\.[0-9]+)?')
  Ok "meme-generator 已安装（$(if ($m.Success) { $m.Value } else { '版本未知' })）"
} else {
  & $VenvPip install --upgrade pip @PipArgs 2>&1 | Out-Null
  # 必须锁 0.1.x：0.2 起被 Rust 重写成纯库，既没有 meme 命令也不带 HTTP 服务，
  # 而本插件全靠那个 HTTP 接口
  & $VenvPip install 'meme-generator>=0.1,<0.2' @PipArgs 2>&1 | Select-Object -Last 5
  if (-not (Test-Path $VenvMeme)) {
    Fail 'meme-generator 安装失败：需要 0.1.x，它依赖 skia-python，Python 版本过新时可能没有预编译包'
  }
  Ok 'meme-generator 安装完成'
}

# ── 4. 克隆订阅仓库 ───────────────────────────────────
Step '拉取表情资源仓库'
New-Item -ItemType Directory -Force -Path $ReposDir | Out-Null
$MemeDirs = @()
foreach ($repo in $Repos) {
  $target = Join-Path $ReposDir $repo.dir
  $fullUrl = $repo.url
  if ($GitProxy) { $fullUrl = $GitProxy.TrimEnd('/') + '/' + $repo.url }

  if (Test-Path (Join-Path $target '.git')) {
    & git -C $target pull --quiet 2>&1 | Out-Null
    Write-Output "  ✓ $($repo.dir) 已更新"
  } else {
    # 把真实报错带出来，别只说「克隆失败」——分不清是网络、分支名还是代理前缀的问题
    $err = & git clone --depth 1 -b $repo.branch $fullUrl $target 2>&1
    if ($LASTEXITCODE -ne 0) {
      $last = ($err | Where-Object { $_ -notmatch '^Cloning' } | Select-Object -Last 1)
      Write-Output "  ⚠️ $($repo.dir) 克隆失败：$last"
      continue
    }
    Write-Output "  ✓ $($repo.dir) 克隆完成"
  }
  $subPath = Join-Path $target $repo.sub
  if (Test-Path $subPath) { $MemeDirs += $subPath }
}
Ok '资源仓库就绪'

# ── 5. 生成 config.toml ───────────────────────────────
Step '写入 meme-generator 配置'
New-Item -ItemType Directory -Force -Path $ConfigDir | Out-Null
# 已有配置先备份，绝不静默覆盖用户原有的设置
if (Test-Path $ConfigFile) {
  $backup = "$ConfigFile.bak.$(Get-Date -Format 'yyyyMMdd-HHmmss')"
  Copy-Item $ConfigFile $backup
  Write-Output "  已备份原配置到 $(Split-Path $backup -Leaf)"
}
# TOML 里的路径要用正斜杠或转义反斜杠，否则 \m \t 之类会被当转义序列
$dirsToml = ($MemeDirs | ForEach-Object { '"' + $_.Replace('\', '/') + '"' }) -join ','

@"
# 由 meme-plugin 的 #meme部署 生成
[meme]
load_builtin_memes = true
meme_dirs = [$dirsToml]
meme_disabled_list = []

[resource]
resource_urls = [
  "https://raw.githubusercontent.com/MeetWq/meme-generator/",
  "https://fastly.jsdelivr.net/gh/MeetWq/meme-generator@",
  "https://raw.gitmirror.com/MeetWq/meme-generator/",
]

[gif]
gif_max_size = 10.0
gif_max_frames = 100

[log]
log_level = "INFO"

[server]
host = ""
port = $Port
"@ | Set-Content -Path $ConfigFile -Encoding UTF8
Ok "配置已写入 $ConfigFile"

# ── 6. 下载内置表情资源 ───────────────────────────────
Step '下载内置表情素材'
& $VenvMeme download 2>&1 | Out-Null
if ($LASTEXITCODE -eq 0) { Ok '素材下载完成' } else { Write-Output '  ⚠️ 素材下载有失败项，多数表情仍可用' }

# ── 7. pm2 起服务 ─────────────────────────────────────
Step '启动 meme 服务'
& pm2 describe $Pm2Name 2>&1 | Out-Null
if ($LASTEXITCODE -eq 0) {
  & pm2 restart $Pm2Name 2>&1 | Out-Null
  if ($LASTEXITCODE -ne 0) { Fail 'pm2 restart 失败' }
  Ok "服务已重启（$Pm2Name）"
} else {
  # Windows 上 pm2 起 .exe 要显式给解释器，直接 pm2 start meme.exe 会被当脚本
  & pm2 start $VenvMeme --name $Pm2Name --cwd $DataDir --interpreter none -- run 2>&1 | Out-Null
  if ($LASTEXITCODE -ne 0) { Fail 'pm2 start 失败' }
  Ok "服务已启动（$Pm2Name）"
}
& pm2 save 2>&1 | Out-Null
if ($LASTEXITCODE -eq 0) { Ok 'pm2 配置已保存（重启机器后自动拉起）' }

Write-Output '::DONE::部署完成'



