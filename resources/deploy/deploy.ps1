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

# ── 先把 PATH 刷新一遍 ────────────────────────────────
# Yunzai 进程的 PATH 停在它启动那一刻。装 Python / `npm i -g pm2` 时写进注册表的
# 新 PATH，已经跑着的进程看不见，它 spawn 出来的这个 PowerShell 也继承不到 ——
# 于是「环境变量里明明有 Python311、明明装了 pm2」，脚本却报「缺少 pm2」。
# [Environment]::GetEnvironmentVariable(...,'Machine'/'User') 是直接读注册表的，
# 拿到的是当下最新值，合进本会话就绕开了继承问题（不重启 Yunzai 也能认到）。
try {
  $fromReg = @(
    [Environment]::GetEnvironmentVariable('Path', 'Machine'),
    [Environment]::GetEnvironmentVariable('Path', 'User')
  ) -join ';'
  $seen = New-Object 'System.Collections.Generic.List[string]'
  foreach ($p in (($fromReg + ';' + $env:Path) -split ';')) {
    $q = $p.Trim().TrimEnd('\')
    if ($q -and -not $seen.Contains($q)) { $seen.Add($q) }
  }
  $env:Path = $seen -join ';'
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

<#
  找一个外部命令的真实路径。
  Get-Command 之外还按常见安装位置翻一遍 —— 装的时候没勾「Add to PATH」，
  或者装完没重启 Yunzai，PATH 上就是没有。
  同时排除 %LOCALAPPDATA%\Microsoft\WindowsApps 下的东西：那是微软商店的
  「应用执行别名」存根，`python` 跑起来只会弹出商店页面、返回非 0 且什么都不输出。
#>
function Find-Exe($name, $fallbacks) {
  foreach ($c in @(Get-Command $name -All -ErrorAction SilentlyContinue)) {
    # 跳过 npm 生成的 .ps1 包装：Get-Command 在 PowerShell 里把 ExternalScript
    # 排在 Application 前面，pm2 会优先命中 pm2.ps1 而不是 pm2.cmd。而那个包装是
    # `& node .../bin/pm2 $args` —— PowerShell 收集 $args 时会**吃掉参数终止符 `--`**，
    # 于是后面 `pm2 start meme.exe ... -- run` 的 run 变成多余的位置参数被 pm2 丢弃，
    # 启动的成了不带子命令的 meme.exe（只打印帮助就退出）→ pm2 无限重启。
    # 走 .cmd 用 %* 原样转发，`--` 和 run 都能完整到达 pm2。
    if ($c.Source -and $c.Source -notlike '*\WindowsApps\*' -and $c.Source -notlike '*.ps1') { return $c.Source }
  }
  foreach ($p in $fallbacks) {
    if ($p -and (Test-Path $p)) { return $p }
  }
  return $null
}

<# 找 3.9+ 的 python.exe：PATH → py 启动器登记的版本 → 常见安装目录 #>
function Find-Python {
  $cands = New-Object 'System.Collections.Generic.List[string]'
  foreach ($n in @('python', 'python3')) {
    foreach ($c in @(Get-Command $n -All -ErrorAction SilentlyContinue)) {
      if ($c.Source -and $c.Source -notlike '*\WindowsApps\*') { $cands.Add($c.Source) }
    }
  }
  # py -0p 会列出所有已注册的解释器及其路径，形如「 -V:3.11 *  C:\...\python.exe」，
  # 这是唯一能找到「装了但没进 PATH」那种的官方途径
  if (Get-Command py -ErrorAction SilentlyContinue) {
    foreach ($line in @(& py -0p 2>$null)) {
      $m = [regex]::Match([string]$line, '([A-Za-z]:\\[^\r\n]*python\.exe)')
      if ($m.Success) { $cands.Add($m.Groups[1].Value) }
    }
  }
  foreach ($root in @("$env:LOCALAPPDATA\Programs\Python", $env:ProgramFiles, ${env:ProgramFiles(x86)}, 'C:\')) {
    if (-not $root -or -not (Test-Path $root)) { continue }
    foreach ($d in @(Get-ChildItem $root -Directory -Filter 'Python3*' -ErrorAction SilentlyContinue)) {
      $exe = Join-Path $d.FullName 'python.exe'
      if (Test-Path $exe) { $cands.Add($exe) }
    }
  }
  foreach ($exe in ($cands | Select-Object -Unique)) {
    # 探版本的 python 代码里**一个双引号都不能有**：Windows PowerShell 5.1 把参数
    # 传给原生命令时，会把参数内部的 " 连同它一起吞掉（pwsh 7.3+ 才用
    # $PSNativeCommandArgumentPassing='Standard' 修好这件事）。没装 pwsh 7 的机器上
    # apps/deploy.js 的 winShell() 会退回 powershell.exe，原来的 f"{...}" 到了
    # python 手里就成了 f{...} → SyntaxError → 退出码 1 → 每个候选都被下面这句
    # continue 掉 → Find-Python 返回 $null，于是「明明装了 3.11」也报「需要 3.9+」。
    # 用 sep=chr(46) 拼小数点，全程零引号，两种 PowerShell 下行为一致。
    $ver = & $exe -c 'import sys;print(sys.version_info[0],sys.version_info[1],sep=chr(46))' 2>$null
    if ($LASTEXITCODE -ne 0 -or -not $ver) { continue }
    $parts = ([string]$ver).Trim().Split('.')
    if ($parts.Count -ge 2 -and $parts[0] -eq '3' -and [int]$parts[1] -ge 9) { return $exe }
  }
  return $null
}

# 装完没重启 Yunzai 是最常见的原因，每条缺失提示都得带上这句
$PathHint = '装过了还报这个，就是 Yunzai 进程还拿着旧的 PATH —— 重启 Yunzai 再发一次就行'

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

$Git = Find-Exe 'git' @(
  "$env:ProgramFiles\Git\cmd\git.exe",
  "${env:ProgramFiles(x86)}\Git\cmd\git.exe",
  "$env:LOCALAPPDATA\Programs\Git\cmd\git.exe"
)
if (-not $Git) {
  Fail "缺少 git，请先安装：https://git-scm.com/download/win`n（$PathHint）"
}

# pm2 是 npm 全局包，Windows 上落在 %APPDATA%\npm\pm2.cmd（不是 .exe）
$Pm2 = Find-Exe 'pm2' @(
  "$env:APPDATA\npm\pm2.cmd",
  "$env:ProgramFiles\nodejs\pm2.cmd",
  "$env:ALLUSERSPROFILE\npm\pm2.cmd"
)
if (-not $Pm2) {
  Fail "缺少 pm2，请先安装：npm i -g pm2`n（$PathHint）"
}

$Py = Find-Python
if (-not $Py) {
  Fail "需要 Python 3.9+（PATH、py 启动器、常见安装目录都翻过了）`n装的时候记得勾 Add Python to PATH；$PathHint"
}
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
    & $Git -C $target pull --quiet 2>&1 | Out-Null
    Write-Output "  ✓ $($repo.dir) 已更新"
  } else {
    # 把真实报错带出来，别只说「克隆失败」——分不清是网络、分支名还是代理前缀的问题
    $err = & $Git clone --depth 1 -b $repo.branch $fullUrl $target 2>&1
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

$Toml = @"
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
"@
# 必须落成**不带 BOM** 的 UTF-8：Windows PowerShell 5.1 的 `-Encoding UTF8` 是「带 BOM」，
# 而 pwsh 6+ 的 utf8 才是无 BOM（同 Find-Python 那处，都是 5.1 与 7 的语义差异）。
# meme_generator 用 toml 库直接 open() 读这个文件，BOM 会粘在第一个字符上，
# 首行的 # 注释于是被当成 key 名的一部分：
#   TomlDecodeError: Found invalid character in key name: '#' (line 1 column 2)
# 结果 meme run 一启动就抛异常 → pm2 反复重启到 errored，端口始终不监听。
# 用 .NET 显式指定 UTF8Encoding($false)，两种 PowerShell 下都无 BOM。
[System.IO.File]::WriteAllText($ConfigFile, ($Toml + "`n"), (New-Object System.Text.UTF8Encoding($false)))
Ok "配置已写入 $ConfigFile"

# ── 6. 下载内置表情资源 ───────────────────────────────
Step '下载内置表情素材'
& $VenvMeme download 2>&1 | Out-Null
if ($LASTEXITCODE -eq 0) { Ok '素材下载完成' } else { Write-Output '  ⚠️ 素材下载有失败项，多数表情仍可用' }

# ── 7. pm2 起服务 ─────────────────────────────────────
Step '启动 meme 服务'
& $Pm2 describe $Pm2Name 2>&1 | Out-Null
if ($LASTEXITCODE -eq 0) {
  & $Pm2 restart $Pm2Name 2>&1 | Out-Null
  if ($LASTEXITCODE -ne 0) { Fail 'pm2 restart 失败' }
  Ok "服务已重启（$Pm2Name）"
} else {
  # Windows 上 pm2 起 .exe 要显式给解释器，直接 pm2 start meme.exe 会被当脚本
  & $Pm2 start $VenvMeme --name $Pm2Name --cwd $DataDir --interpreter none -- run 2>&1 | Out-Null
  if ($LASTEXITCODE -ne 0) { Fail 'pm2 start 失败' }
  Ok "服务已启动（$Pm2Name）"
}
& $Pm2 save 2>&1 | Out-Null
if ($LASTEXITCODE -eq 0) { Ok 'pm2 配置已保存（重启机器后自动拉起）' }

Write-Output '::DONE::部署完成'



