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
CONFIG_DIR="$HOME/.config/meme_generator"
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

command -v git >/dev/null 2>&1 || fail "缺少 git，请先安装：apt install git"
PM2="$(find_bin pm2 \
  "$NODE_BIN_DIR/pm2" \
  /usr/local/bin/pm2 \
  /usr/bin/pm2 \
  "$HOME/.local/bin/pm2")" \
  || fail "缺少 pm2，请先安装：npm i -g pm2"

PY=""
for c in python3 python; do
  if command -v "$c" >/dev/null 2>&1; then
    ver=$("$c" -c 'import sys;print(f"{sys.version_info[0]}.{sys.version_info[1]}")' 2>/dev/null)
    major=${ver%%.*}; minor=${ver##*.}
    if [ "$major" = "3" ] && [ "$minor" -ge 9 ] 2>/dev/null; then PY="$c"; break; fi
  fi
done
[ -n "$PY" ] || fail "需要 Python 3.9+，当前没找到合适的版本"
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
