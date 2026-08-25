#!/usr/bin/env bash
# meme-generator 一键部署脚本（可选）
#
# 由 meme-plugin 的 #meme部署 指令调用，也可以手动执行。
# 全程幂等：venv 在就复用、仓库在就 pull、pm2 有同名就 restart，可重复运行。
#
# 用法: deploy.sh <数据目录> <pm2进程名> [pip镜像] [git代理前缀]

set -o pipefail

DATA_DIR="${1:?缺少数据目录参数}"
PM2_NAME="${2:-meme-plugin}"
PIP_INDEX="${3:-}"
GIT_PROXY="${4:-}"

VENV_DIR="$DATA_DIR/venv"
REPOS_DIR="$DATA_DIR/repos"
CONFIG_DIR="$HOME/.config/meme_generator"
CONFIG_FILE="$CONFIG_DIR/config.toml"

# 订阅的表情仓库：目录名|git地址|分支|表情子目录
# 子目录各仓库不一样（emoji / memes / meme），加新仓库前先确认一下，
# 填错的话 meme_dirs 会指向不存在的路径，服务扫不到表情。
REPOS=(
  "meme_emoji|https://github.com/anyliew/meme_emoji|main|emoji"
  "meme_emoji_nsfw|https://github.com/anyliew/meme_emoji_nsfw|main|emoji"
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

command -v git >/dev/null 2>&1 || fail "缺少 git，请先安装：apt install git"
command -v pm2 >/dev/null 2>&1 || fail "缺少 pm2，请先安装：npm i -g pm2"

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
  ok "meme-generator 已安装（$("$VENV_DIR/bin/meme" --version 2>&1 | head -1)）"
else
  "$VENV_DIR/bin/pip" install --upgrade pip $PIP_ARGS >/dev/null 2>&1
  "$VENV_DIR/bin/pip" install meme-generator $PIP_ARGS 2>&1 | tail -5
  [ -x "$VENV_DIR/bin/meme" ] || fail "meme-generator 安装失败，请看上面的 pip 输出"
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
    if git clone --depth 1 -b "$branch" "$full_url" "$target" >/dev/null 2>&1; then
      echo "  ✓ $dir 克隆完成"
    else
      echo "  ⚠️ $dir 克隆失败，跳过（可稍后 #meme更新 重试）"
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
EOF
ok "配置已写入 $CONFIG_FILE"

# ── 6. 下载内置表情资源 ───────────────────────────────
step "下载内置表情素材"
"$VENV_DIR/bin/meme" download >/dev/null 2>&1 && ok "素材下载完成" || echo "  ⚠️ 素材下载有失败项，多数表情仍可用"

# ── 7. pm2 起服务 ─────────────────────────────────────
step "启动 meme 服务"
if pm2 describe "$PM2_NAME" >/dev/null 2>&1; then
  pm2 restart "$PM2_NAME" >/dev/null 2>&1 || fail "pm2 restart 失败"
  ok "服务已重启（$PM2_NAME）"
else
  pm2 start "$VENV_DIR/bin/meme" --name "$PM2_NAME" --cwd "$DATA_DIR" -- run >/dev/null 2>&1 \
    || fail "pm2 start 失败"
  ok "服务已启动（$PM2_NAME）"
fi
pm2 save >/dev/null 2>&1 && ok "pm2 配置已保存（重启机器后自动拉起）"

echo "::DONE::部署完成"
