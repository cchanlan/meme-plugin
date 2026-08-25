# meme-plugin

Yunzai 表情包插件。接 [meme-generator](https://github.com/MemeCrafters/meme-generator) 服务，
带 **Web 在线预览站**、分页列表、搜索出图、资源自动更新，以及**可选的一键部署**。

## 特性

- **Web 预览站** —— 浏览器里看每个表情长什么样，搜索/筛分类/点一下复制指令，手机端优化
- **搜索出预览图** —— `#表情包搜索 鸣潮` 直接出图，同时匹配关键词、分类和英文代码
- **分页列表** —— 服务端出图字号固定不缩放，全量 830 个会糊成一团；分页每页 80 个，字才清晰
- **最长匹配** —— 「摸鱼」不会被「摸」抢走。1100+ 关键词里有 51 个短词会吃掉 75 个长词
- **参数全支持** —— 直接读服务端 JSON Schema，59 个带参表情全部可传参
- **一条指令更新** —— `#meme更新` 自动 拉仓库 → 重启服务 → 刷新索引，一步到位
- **可选一键部署** —— 没有 meme 服务的话，`#meme部署` 自动建 venv、装依赖、拉资源、起 pm2

## 安装

```bash
cd Yunzai/plugins
git clone <本仓库地址> meme-plugin
```

重启 Yunzai 即可。**无需 npm install**（不引入任何新依赖）。

## meme 服务

插件本身不含表情生成能力，需要一个 meme-generator 服务。三种方式任选：

**1. 已经有服务** —— 改配置 `memeApiUrl` 指向它即可，比如 `http://192.168.1.5:2233`

**2. 一键部署（可选）** —— 发 `#meme部署`，脚本会自动完成：

```
检查环境(python3.9+/git/pm2) → 建 venv → 装 meme-generator
→ 拉 4 个表情仓库 → 写 config.toml(原有配置会先备份) → pm2 起服务并 save
```

全程幂等，可重复执行。用独立的 pm2 进程名 `meme-plugin`，不影响机器上已有的 meme 进程。

**3. 手动部署** —— 嫌自动的不放心就手动来：

```bash
python3 -m venv venv && ./venv/bin/pip install meme-generator
./venv/bin/meme download          # 下载内置表情素材
pm2 start ./venv/bin/meme --name meme -- run && pm2 save
```

再把表情仓库克隆到任意位置，写进 `~/.config/meme_generator/config.toml` 的 `meme_dirs`。

## 指令

### 做表情

| 指令 | 说明 |
|---|---|
| `#摸头` | 用自己头像 |
| `#摸头 @某人` | 用对方头像 |
| 引用图片 + `#摸头` | 用图里的图 |
| `#一巴掌 笨蛋` | 带文字 |
| `#高低情商 会说话/不会说话` | 多段文字用 `/` 隔开 |
| `#爬#33` | 带参数，`#` 后面是参数 |
| `#摸头详情` | 看这个表情支持什么参数 |

### 找表情

| 指令 | 说明 |
|---|---|
| `#表情包搜索 猫` | 出预览图 + 关键词列表 |
| `#表情包列表` / `#表情包列表 3` | 分页浏览 |
| `#表情包分类` / `#表情包分类 鸣潮` | 按作品/系列看 |
| `#随机表情包` | 随机来一个 |
| `#表情包帮助` | 完整说明 |

### 管理（仅主人）

| 指令 | 说明 |
|---|---|
| `#meme更新` | 拉取新表情，自动重启服务 + 刷新索引 |
| `#meme刷新` | 只重建索引，不动仓库 |
| `#meme部署状态` | 查看服务健康度 |
| `#meme部署` | 可选：本机部署一套 meme 服务 |

## 配置

改 `config/config.yaml`，或用锅巴面板可视化配置。关键项：

| 配置 | 默认 | 说明 |
|---|---|---|
| `memeApiUrl` | `http://127.0.0.1:2233` | meme 服务地址 |
| `forceSharp` | `true` | 是否必须带 `#` 前缀 |
| `pageSize` | `80` | 列表每页数量，越多字越小 |
| `enableWeb` | `true` | Web 预览站开关 |
| `webPort` | `3132` | Web 端口 |
| `webUrl` | 空 | 对外地址，群里发的链接用它 |
| `memePm2Name` | `meme` | meme 服务的 pm2 **进程名** |
| `reposDir` | 空 | 表情仓库目录，机器上已有仓库时**必须**填 |
| `gitProxy` | `https://api.fate.vip/` | GitHub 代理前缀，直连就留空 |

### 关于 `reposDir`

留空时插件会把仓库克隆到 `data/meme-plugin/repos/`。但如果机器上**本来就有**一份
（比如装 meme-generator 时克隆在 `/opt/meme`），一定要把它填成那个路径。

否则会出现这种情况：`#meme更新` 更新了插件自己克隆的那份副本，而 meme 服务的
`config.toml` 里 `meme_dirs` 指向的还是原来那份 —— **更新了也不生效，还白占一份磁盘**
（这几个仓库合计约 1.5G）。填好后要和 `config.toml` 的 `meme_dirs` 保持一致。

### 关于 `memePm2Name`

必须填**名字**，不能填 pm2 的数字 ID。数字 ID 会随进程增删而错位 —— 曾经写死
`pm2 restart 2` 结果一直在重启另一个不相干的服务，meme 服务从未重启过，
新拉的表情因此永远加载不进去。

## 表情仓库

默认订阅这 4 个（可在配置里改）：

| 仓库 | 表情子目录 |
|---|---|
| [anyliew/meme_emoji](https://github.com/anyliew/meme_emoji) | `emoji` |
| [anyliew/meme_emoji_nsfw](https://github.com/anyliew/meme_emoji_nsfw) | `emoji` |
| [MemeCrafters/meme-generator-contrib](https://github.com/MemeCrafters/meme-generator-contrib) | `memes` |
| [jinjiao007/meme-generator-jj](https://github.com/jinjiao007/meme-generator-jj) | `memes` |

## 常见问题

**新拉的表情打不出来？**
表情更新有两层缓存，都要刷新：meme 服务端（只在进程启动时扫描 `meme_dirs`）和插件本地索引。
`#meme更新` 会自动处理这两层。如果失败，检查 `memePm2Name` 是不是真的匹配 pm2 里的进程名。

**Web 站打不开？**
先看日志有没有 `EADDRINUSE`（端口被占，改 `webPort`）。要让别人访问得配 `webUrl` 为公网地址，
并确保端口在防火墙放行。

**表情数量对不上？**
`#meme部署状态` 会同时显示服务端和本地索引的数量，不一致就发 `#meme刷新`。

## 数据目录

一切数据落在 `Yunzai/data/meme-plugin/`：

```
keyMap.json / infos.json   表情索引缓存
preview_cache/             Web 预览图缓存（全量约 166MB，服务端没有缓存所以本地存）
list_cache/                列表/搜索出图缓存
original/ result/          临时文件，自动清理
repos/                     表情资源仓库
venv/                      一键部署时创建
```
