#!/usr/bin/env bash
# meme-generator 一键部署脚本（可选）
#
# 由 meme-plugin 的 #meme部署 指令调用，也可以手动执行。
# 全程幂等：venv 在就复用、仓库在就 pull、pm2 有同名就 restart，可重复运行。
#
# 用法: deploy.sh <数据目录> <pm2进程名> [pip镜像] [git代理前缀] [监听端口]

set -o pipefail

DATA_DIR="${1:?缺少数据目录参数}"
PM2_NAME="${2:-meme-plugin}"
PIP_INDEX="${3:-}"
GIT_PROXY="${4:-}"
# 端口做成参数：机器上已经有一个 meme 服务占着 2233 时，
# 新装的这套必须换端口，否则起来就撞端口、pm2 反复重启
PORT="${5:-2233}"

VENV_DIR="$DATA_DIR/venv"
REPOS_DIR="$DATA_DIR/repos"
# config.toml 的位置必须和 meme-generator（nonebot plugin-localstore）算出来的一致，
# 写到别处就是白写：服务照旧读它自己那份，meme_dirs 永远登记不上、只剩内置表情。
# 早先这里写死 $HOME/.config，两种机器上会写错地方 ——
# 设过 XDG_CONFIG_HOME 的 Linux，以及 macOS（它用 ~/Library/Application Support）。
# 插件 Node 侧 utils/memeDirs.js 的 tomlPath() 就是按这套规则找的，两边得对得上。
if [ "$(uname -s)" = "Darwin" ]; then
  CONFIG_DIR="$HOME/Library/Application Support/meme_generator"
else
  CONFIG_DIR="${XDG_CONFIG_HOME:-$HOME/.config}/meme_generator"
fi
CONFIG_FILE="$CONFIG_DIR/config.toml"

# 订阅的表情仓库：目录名|git地址|分支|表情子目录
# 子目录各仓库不一样（emoji / memes / meme），加新仓库前先确认一下，
# 填错的话 meme_dirs 会指向不存在的路径，服务扫不到表情。
REPOS=(
  "meme_emoji|https://github.com/anyliew/meme_emoji|main|emoji"
  "crazy_emoji|https://github.com/anyliew/crazy_emoji|main|emoji"
  "meme-generator-contrib|https://github.com/MemeCrafters/meme-generator-contrib|main|memes"
  "meme-generator-jj|https://github.com/jinjiao007/meme-generator-jj|master|memes"
  "tudou-meme|https://github.com/LRZ9712/tudou-meme|main|meme"
)

step () { echo "::STEP::$1"; }
ok ()   { echo "::OK::$1"; }
fail () { echo "::FAIL::$1"; exit 1; }

# ── 1. 环境自检 ────────────────────────────────────────
step "检查运行环境"

# 找一个可执行文件：PATH 之外再按常见位置翻一遍。
# 起 Yunzai 的那个环境不一定加载过 nvm/profile —— pm2 明明装了却 command -v 找不到，
# 就是因为它在 ~/.nvm/versions/node/vXX/bin 里而这个目录没进 PATH。
find_bin () {
  local name="$1"; shift
  if command -v "$name" >/dev/null 2>&1; then command -v "$name"; return 0; fi
  local p
  for p in "$@"; do
    [ -n "$p" ] && [ -x "$p" ] && { echo "$p"; return 0; }
  done
  return 1
}

# node 自己所在的目录：npm i -g 装的东西都落在这里
NODE_BIN_DIR=""
command -v node >/dev/null 2>&1 && NODE_BIN_DIR="$(dirname "$(command -v node)")"

# 装包要 root。容器里一般本来就是 root；普通用户只要有免密 sudo 也行 ——
# 要密码的那种就别指望无人值守了，让用户自己跑一条命令比卡在这儿强
as_root () {
  if [ "$(id -u)" = 0 ]; then "$@"
  elif command -v sudo >/dev/null 2>&1 && sudo -n true 2>/dev/null; then sudo -n "$@"
  else return 127
  fi
}

# 按系统自带的包管理器装。
# 现在的常见场景是 TRSS 的容器 / WSL 里跑云崽，这些环境基本没预装 git，
# 用户发一条 #meme部署 却卡在「请先安装 git」，他并不知道该用什么命令。
install_pkg () {
  local pkgs="$*" log=/tmp/meme-deploy-pkg.log
  if command -v apt-get >/dev/null 2>&1; then
    as_root apt-get update -qq >"$log" 2>&1
    as_root env DEBIAN_FRONTEND=noninteractive apt-get install -y -qq $pkgs >>"$log" 2>&1
  elif command -v dnf >/dev/null 2>&1; then
    as_root dnf install -y -q $pkgs >"$log" 2>&1
  elif command -v yum >/dev/null 2>&1; then
    as_root yum install -y -q $pkgs >"$log" 2>&1
  elif command -v pacman >/dev/null 2>&1; then
    as_root pacman -Sy --noconfirm --needed $pkgs >"$log" 2>&1
  elif command -v apk >/dev/null 2>&1; then
    as_root apk add --no-cache $pkgs >"$log" 2>&1
  else
    echo "  没有识别到 apt / dnf / yum / pacman / apk" >&2
    return 127
  fi
}

# 装失败时把最后一行原因带出来：用户至少能看到是网络还是权限
install_pkg_hint () {
  local lines
  lines=$(tail -3 /tmp/meme-deploy-pkg.log 2>/dev/null | tr '\n' ' ')
  echo "${lines:-(没有输出)}"
}

if ! command -v git >/dev/null 2>&1; then
  step "安装 git（拉表情仓库要用）"
  if install_pkg git && command -v git >/dev/null 2>&1; then
    ok "git 安装完成"
  else
    fail "自动装 git 失败：$(install_pkg_hint)｜请手动装好后重发 #meme部署"
  fi
fi

PM2="$(find_bin pm2 \
  "$NODE_BIN_DIR/pm2" \
  /usr/local/bin/pm2 \
  /usr/bin/pm2 \
  "$HOME/.local/bin/pm2")"

# pm2 缺失就装：容器 / WSL 里跑云崽的机器基本都没有它。
# npm i -g 装完落在 npm 的全局 bin 下，那个目录经常不在 PATH 里，所以装完
# 按 npm prefix -g 再找一次，并把该目录补进本次的 PATH（pm2 自己起来时也要用它）
if [ -z "$PM2" ]; then
  step "安装 pm2（进程守护用）"
  NPM="$(find_bin npm "$NODE_BIN_DIR/npm" /usr/local/bin/npm /usr/bin/npm)"
  [ -n "$NPM" ] || fail "缺少 pm2，自动安装还需要 npm：请先装 Node.js，再重发 #meme部署"
  if ! "$NPM" i -g pm2 >/tmp/meme-deploy-pm2.log 2>&1; then
    # 国内网络拉官方源常超时，换镜像再试一次
    "$NPM" i -g pm2 --registry=https://registry.npmmirror.com >>/tmp/meme-deploy-pm2.log 2>&1
  fi
  PREFIX="$("$NPM" prefix -g 2>/dev/null)"
  [ -n "$PREFIX" ] && [ -d "$PREFIX/bin" ] && PATH="$PREFIX/bin:$PATH"
  export PATH
  PM2="$(find_bin pm2 \
    "$PREFIX/bin/pm2" \
    "$NODE_BIN_DIR/pm2" \
    /usr/local/bin/pm2 \
    /usr/bin/pm2 \
    "$HOME/.local/bin/pm2")"
  [ -n "$PM2" ] || fail "自动装 pm2 失败：$(tail -2 /tmp/meme-deploy-pm2.log 2>/dev/null | tr '\n' ' ')"
  ok "pm2 安装完成"
fi

PY=""
for c in python3 python; do
  if command -v "$c" >/dev/null 2>&1; then
    ver=$("$c" -c 'import sys;print(f"{sys.version_info[0]}.{sys.version_info[1]}")' 2>/dev/null)
    major=${ver%%.*}; minor=${ver##*.}
    if [ "$major" = "3" ] && [ "$minor" -ge 9 ] 2>/dev/null; then PY="$c"; break; fi
  fi
done

# python 一个都没有（容器镜像里很常见）就装上。Debian / Ubuntu 还要带
# python3-venv，否则下面 python3 -m venv 会报 ensurepip is not available
if [ -z "$PY" ]; then
  step "安装 Python 3（画图服务要用）"
  if install_pkg "python3 python3-venv" || install_pkg python3; then
    for c in python3 python; do
      if command -v "$c" >/dev/null 2>&1; then
        ver=$("$c" -c 'import sys;print(f"{sys.version_info[0]}.{sys.version_info[1]}")' 2>/dev/null)
        major=${ver%%.*}; minor=${ver##*.}
        if [ "$major" = "3" ] && [ "$minor" -ge 9 ] 2>/dev/null; then PY="$c"; break; fi
      fi
    done
  fi
  if [ -z "$PY" ]; then
    fail "自动装 Python 失败：$(install_pkg_hint)｜需要 3.9 以上，装好后重发 #meme部署"
  fi
  ok "Python 安装完成（$($PY --version 2>&1)）"
fi
ok "环境就绪（$($PY --version 2>&1)，git，pm2）"

# ── 2. 建 venv ────────────────────────────────────────
step "准备 Python 虚拟环境"
if [ -x "$VENV_DIR/bin/python" ]; then
  ok "venv 已存在，复用"
else
  mkdir -p "$DATA_DIR"
  "$PY" -m venv "$VENV_DIR" 2>&1 || fail "创建 venv 失败，可能缺少 python3-venv：apt install python3-venv"
  ok "venv 创建完成"
fi

# ── 3. 装 meme-generator ──────────────────────────────
step "安装 meme-generator（skia-python 较大，可能要几分钟）"
PIP_ARGS=""
[ -n "$PIP_INDEX" ] && PIP_ARGS="-i $PIP_INDEX"

if [ -x "$VENV_DIR/bin/meme" ]; then
  # meme --version 之前会先吐一串 Fontconfig 警告，直接 head -1 会把警告当版本号报出来
  ver=$("$VENV_DIR/bin/meme" --version 2>&1 | grep -oE '[0-9]+\.[0-9]+(\.[0-9]+)?' | head -1)
  ok "meme-generator 已安装（${ver:-版本未知}）"
else
  "$VENV_DIR/bin/pip" install --upgrade pip $PIP_ARGS >/dev/null 2>&1
  # 必须锁 0.1.x：0.2 起 meme-generator 被 Rust 重写成了纯库（装出来只有一个
  # abi3.so），既没有 meme 命令也不带 HTTP 服务，而本插件全靠那个 HTTP 接口。
  # 不锁的话 pip 会装上 0.2.x，然后卡在下面这句检查上。
  "$VENV_DIR/bin/pip" install "meme-generator>=0.1,<0.2" $PIP_ARGS 2>&1 | tail -5
  [ -x "$VENV_DIR/bin/meme" ] || fail "meme-generator 安装失败：需要 0.1.x，它依赖 skia-python，Python 版本过新时可能没有预编译包（实测 3.11 可用）"
  ok "meme-generator 安装完成"
fi

# ── 4. 克隆订阅仓库 ───────────────────────────────────
step "拉取表情资源仓库"
mkdir -p "$REPOS_DIR"
MEME_DIRS=""
for item in "${REPOS[@]}"; do
  IFS='|' read -r dir url branch subdir <<< "$item"
  target="$REPOS_DIR/$dir"
  full_url="$url"
  [ -n "$GIT_PROXY" ] && full_url="${GIT_PROXY%/}/$url"

  if [ -d "$target/.git" ]; then
    (cd "$target" && git pull --quiet 2>&1 | tail -2) || echo "  ⚠️ $dir pull 失败，用现有内容"
    echo "  ✓ $dir 已更新"
  else
    if err=$(git clone --depth 1 -b "$branch" "$full_url" "$target" 2>&1); then
      echo "  ✓ $dir 克隆完成"
    else
      # 把真实报错带出来：之前是 >/dev/null 2>&1 全吞掉，
      # 用户只看到「克隆失败」，分不清是网络不通、分支名写错还是代理前缀挂了
      echo "  ⚠️ $dir 克隆失败：$(printf '%s' "$err" | grep -v '^Cloning' | tail -1 | cut -c1-140)"
      continue
    fi
  fi
  [ -d "$target/$subdir" ] && MEME_DIRS="$MEME_DIRS\"$target/$subdir\","
done
ok "资源仓库就绪"

# ── 5. 生成 config.toml ───────────────────────────────
step "写入 meme-generator 配置"
mkdir -p "$CONFIG_DIR"
# 已有配置先备份，绝不静默覆盖用户原有的设置
if [ -f "$CONFIG_FILE" ]; then
  backup="$CONFIG_FILE.bak.$(date +%Y%m%d-%H%M%S)"
  cp "$CONFIG_FILE" "$backup"
  echo "  已备份原配置到 $(basename "$backup")"
fi
MEME_DIRS="${MEME_DIRS%,}"
cat > "$CONFIG_FILE" <<EOF
# 由 meme-plugin 的 #meme部署 生成
[meme]
load_builtin_memes = true
meme_dirs = [$MEME_DIRS]
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
port = $PORT
EOF
ok "配置已写入 $CONFIG_FILE"

# ── 6. 下载内置表情资源 ───────────────────────────────
step "下载内置表情素材"
# 必须加超时：这步要从 GitHub 拉几百个文件，国内无代理时会长时间干等
# （实测 6 分钟一个文件都没落盘）。素材缺失只影响用到它的那部分表情，
# 服务本身照样起得来，所以宁可超时跳过，也不要让整个部署卡死在这里。
if timeout 300 "$VENV_DIR/bin/meme" download >/dev/null 2>&1; then
  ok "素材下载完成"
else
  echo "  ⚠️ 素材下载未完成（超时或有失败项），不影响服务启动"
  echo "  想补齐可稍后手动跑：$VENV_DIR/bin/meme download"
fi

# ── 7. pm2 起服务 ─────────────────────────────────────
step "启动 meme 服务"
if "$PM2" describe "$PM2_NAME" >/dev/null 2>&1; then
  "$PM2" restart "$PM2_NAME" >/dev/null 2>&1 || fail "pm2 restart 失败"
  ok "服务已重启（$PM2_NAME）"
else
  # 必须显式指定解释器：venv/bin/meme 是个没有扩展名的 Python 脚本，
  # pm2 猜不出来就默认拿 node 去跑，报 SyntaxError: Unexpected identifier 'meme_generator'
  "$PM2" start "$VENV_DIR/bin/meme" --name "$PM2_NAME" --cwd "$DATA_DIR" \
    --interpreter "$VENV_DIR/bin/python" -- run >/dev/null 2>&1 \
    || fail "pm2 start 失败"
  ok "服务已启动（$PM2_NAME）"
fi
"$PM2" save >/dev/null 2>&1 && ok "pm2 配置已保存（重启机器后自动拉起）"

echo "::DONE::部署完成"
