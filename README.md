# meme-plugin

Yunzai 表情包插件。对接 [meme-generator](https://github.com/MemeCrafters/meme-generator) 服务，
带 **Web 在线预览站**、搜索出图、分页列表、黑名单、资源自动更新，以及**可选的一键部署**。

当前实测规模：**944 个表情 / 1332 个关键词 / 33 个分类**（取决于你订阅了哪些表情仓库）。

## 特性

- **Web 预览站** —— 浏览器里看每个表情长什么样，搜索、筛分类、点一下复制指令，**按最近更新倒序**排列，手机端优化
- **搜索出真图** —— `#meme搜索 鸣潮` 出的是带真实预览图的网格，同时匹配关键词、分类和英文代码。服务端自带的列表图只画关键词和占位图标，所以这张图是插件自己拼的
- **名字用文字补发** —— 结果超过 8 个时，表情名另外发一份文字。QQ 气泡里图片最宽只显示约 420px，格子一多每格只剩几十像素、名字根本读不了，文字不受缩放影响还能直接复制
- **最长匹配** —— 「摸鱼」不会被「摸」抢走。1332 个关键词里有 51 个短词会吃掉 75 个长词，按长度降序匹配才能都打得出来
- **参数全支持** —— 直接读服务端的 JSON Schema，带参表情全部可传参，`#表情名详情` 出图查支持哪些参数
- **黑名单** —— 可以拉黑用户和表情。表情黑名单过滤做在索引层，生成、搜索、分类、列表、随机、Web 站一处配置全都生效
- **群级开关** —— `#meme关闭` 按群关，群管理员就能发，不必找主人
- **用量排行** —— `#meme排行` 出图看哪个表情最火、谁最能整活，带真实缩略图和头像、最近 7 天趋势
- **一条指令更新** —— `#meme更新` 自动完成 拉仓库 → 登记 `meme_dirs` → 重启服务 → 热加载索引，不用重启 Yunzai
- **可选一键部署** —— 没有 meme 服务的话，`#meme部署` 自动建 venv、装依赖、拉资源、起 pm2，全程幂等

## 安装

```bash
cd Yunzai/plugins
git clone https://gitcode.com/ccxhan/meme-plugin.git
# 或者
git clone https://github.com/cchanlan/meme-plugin.git
```

重启 Yunzai 即可。**无需 npm install** —— 插件不引入任何新依赖，用的都是 Yunzai 主仓库已有的
（yaml / chokidar / lodash / puppeteer / sharp / node-fetch）。

## meme 服务

插件本身不含表情生成能力，需要一个 meme-generator 服务。三种方式任选：

**1. 已经有服务** —— 把配置 `memeApiUrl` 指向它即可，比如 `http://192.168.1.5:2233`。
远程服务、别人的服务都行，插件只调 HTTP 接口。

**2. 一键部署（可选）** —— 发 `#meme部署`，脚本会自动完成：

```
检查环境(python3.9+/git/pm2) → 建 venv → 装 meme-generator
→ 拉 5 个表情仓库 → 写 config.toml(原有配置会先备份) → pm2 起服务并 save
```

全程幂等可重复执行。用独立的 pm2 进程名 `meme-plugin`，不影响机器上已有的 meme 进程。

**3. 手动部署** —— 嫌自动的不放心就手动来：

```bash
python3 -m venv venv && ./venv/bin/pip install meme-generator
./venv/bin/meme download          # 下载内置表情素材
pm2 start ./venv/bin/meme --name meme -- run && pm2 save
```

再把表情仓库克隆到任意位置，写进 `~/.config/meme_generator/config.toml` 的 `meme_dirs`。
注意 meme-generator **只在进程启动时扫描 `meme_dirs`**，改完必须重启它。

## 跨平台

Linux / macOS / Windows 都能跑，差异集中在路径和部署脚本上：

| | Linux | macOS | Windows |
|---|---|---|---|
| `config.toml` | `$XDG_CONFIG_HOME/meme_generator/`，未设则 `~/.config/meme_generator/` | `~/Library/Application Support/meme_generator/` | `%APPDATA%\meme_generator\` |
| venv 可执行文件 | `venv/bin/meme` | 同 Linux | `venv\Scripts\meme.exe` |
| 一键部署脚本 | `deploy.sh`（bash） | 同 Linux | `deploy.ps1`（PowerShell） |

`config.toml` 的位置不是插件定的，是 meme-generator 用 nonebot plugin-localstore 那套规则
算出来的（`user_config_dir` 默认 `roaming=True`，所以 Windows 是 **Roaming** 不是 Local）。
插件按同一套规则定位，`#meme更新` 才能把 `meme_dirs` 写进服务真正会读的那个文件。

> Windows 的 `deploy.ps1` 是逐步对照 `deploy.sh` 写的、输出同一套 `::STEP::` 标记，
> 但**没有在真机上跑过**（开发机是 Linux）。Linux 路径已完整验证过一遍。

## 指令

### 做表情

| 指令 | 说明 |
|---|---|
| `#摸头` | 用自己头像 |
| `#摸头 @某人` | 用对方头像 |
| 引用图片 + `#摸头` | 用图里的图 |
| `#一巴掌 笨蛋` | 带文字 |
| `#高低情商 会说话/不会说话` | 多段文字用 `/` 隔开 |
| `#爬#33` | 带参数，`#` 后面是参数值 |
| `#一直#循环` | 参数是枚举时直接写选项名 |
| `#摸头详情` | 出图看这个表情支持什么参数，带真实预览 |

### 找表情

| 指令 | 说明 |
|---|---|
| `#meme搜索 猫` | 出预览图网格，超过 8 个会附带可复制的名字列表 |
| `#meme列表` / `#meme列表 3` | 分页浏览，每页 24 个的预览图网格 |
| `#meme分类` | 列出全部分类及各自表情数 |
| `#meme分类 鸣潮` | 出该分类的预览图网格 |
| `#随机meme` | 随机来一个 |
| `#meme排行` | 出图看用量榜：表情榜 + 玩家榜 + 最近 7 天趋势 |
| `#meme帮助` | 完整说明 |

指令前缀 `#` 可以通过 `forceSharp` 配置关掉，但关掉后「摸头」这类词容易误触发，建议保持开启。

### 管理

| 指令 | 权限 | 说明 |
|---|---|---|
| `#meme开启` / `#meme关闭` | 群管或主人 | 本群开关。关掉后除 `#meme开关` 外的表情指令一律**静默不响应** |
| `#meme开关` | 所有人 | 看本群当前是开还是关 |
| `#meme更新` | 仅主人 | 拉取新表情：git pull → 登记 `meme_dirs` → 重启 meme 服务 → 热加载索引 |
| `#meme刷新` / `#meme重载` | 仅主人 | 只重建索引、清出图缓存，不动仓库（服务端已经是新的时用这个更快） |
| `#meme部署状态` | 仅主人 | 查看服务连通性、索引规模、venv/仓库/pm2 健康度 |
| `#meme清缓存` | 仅主人 | 清空预览图/缩略图缓存（平时每 6 小时按 `maxCacheMB` 自动淘汰一次，这个是手动立刻清） |
| `#meme清空统计` | 仅主人 | 排行榜清零重来 |
| `#meme部署` | 仅主人 | 可选：在本机部署一套 meme 服务 |

## Web 预览站

默认开在 `3132` 端口，`enableWeb` 可关。群里发的链接用 `webUrl` 配的地址，留空则用 localhost。

- 卡片带真实预览图，懒加载（IntersectionObserver），预览图落盘缓存
- 搜索框三路过滤：关键词 / 分类 / 英文代码
- 分类 chips 只显示表情数达到 `tagMinCount` 的（tag 很碎，90 个 tag 里 57 个只含 1 个表情）
- 点卡片复制指令，详情弹层显示参数说明
- **按最近更新倒序**，新拉的表情排最前面

站点是公开的、不带 token —— 里面只有表情元数据和预览图，没有敏感信息。要对外访问记得配
`webUrl` 为公网地址并在防火墙放行端口。

## 黑名单与群开关

`#meme关闭` 按群关，群管理员和主人都能发。存的是「关掉的群」（配置项 `disabledGroups`）
而不是「开启的群」，所以默认全开、新入的群不用先开一遍。关掉的群里除了 `#meme开关`，
其余表情指令**静默不响应**；主人的管理指令不受影响，关掉的群里照样能 `#meme更新`。

黑名单有两个配置项，锅巴面板里用标签输入，也可以直接改 `config/config.yaml`：

| 配置 | 说明 |
|---|---|
| `blackUsers` | 拉黑的 QQ 号。这些人发表情相关指令一律不响应，且是**静默放行**不回提示 —— 回「你被拉黑了」反而给了对方刷屏的抓手 |
| `blackMemes` | 拉黑的表情。填英文 key（如 `petpet`）或中文关键词（如 `摸头`）都行 |

`blackMemes` 按关键词拉黑时，屏蔽的是它背后的**整个表情**，所以该表情的其他别名也一起失效，
不会从另一个名字绕进来。过滤统一做在索引层，所以生成、搜索、分类、列表、随机、Web 站
全都查不到，配一处就够。

## 配置

改 `config/config.yaml`，或用锅巴面板可视化配置（改完热重载，不用重启）。

| 配置 | 默认 | 说明 |
|---|---|---|
| `memeApiUrl` | `http://127.0.0.1:2233` | meme 服务地址 |
| `apiTimeout` | `30000` | 单次请求超时（毫秒） |
| `forceSharp` | `true` | 是否必须带 `#` 前缀 |
| `replyWithQuote` | `false` | 发表情时是否引用回复 |
| `maxFileSize` | `10` | 输入图片大小上限（MB），超了直接拒收不下载 |
| `imageTimeout` | `15000` | 单张图片下载超时（毫秒） |
| `masterProtect` | `true` | 撅主人会被反撅 |
| `protectList` | 41 项 | 参与上面这条保护的表情 key |
| `blackUsers` | `[]` | 拉黑的 QQ 号 |
| `blackMemes` | `[]` | 拉黑的表情（key 或关键词） |
| `disabledGroups` | `[]` | 关掉表情的群号，一般由 `#meme关闭` 自动维护 |
| `pageSize` | `24` | 列表每页数量，和搜索一样出带预览图的网格图 |
| `searchMaxPreview` | `24` | 搜索/分类最多出几个的预览图 |
| `tagMinCount` | `2` | 分类至少要有几个表情才显示 |
| `enableWeb` | `true` | Web 预览站开关 |
| `webPort` | `3132` | Web 端口 |
| `webUrl` | 空 | 对外地址，群里发的链接用它 |
| `enablePreviewCache` | `true` | 预览图落盘缓存（服务端没有缓存，建议开） |
| `maxCacheMB` | `300` | 预览图/缩略图缓存各自的容量上限，超了淘汰最久没读到的，`0` 不限 |
| `memePm2Name` | `meme` | meme 服务的 pm2 **进程名** |
| `reposDir` | 空 | 表情仓库目录，机器上已有仓库时**必须**填 |
| `repos` | 5 项 | 订阅的表情仓库，含 `memeSubDir` |
| `gitProxy` | 空 | GitHub 前缀代理，**建议留空直连** |
| `deployPm2Name` | `meme-plugin` | 一键部署用的进程名 |
| `pipIndexUrl` | 清华源 | 仅一键部署时用到 |

## 四个容易踩的坑

**`reposDir` 不填会白更新。** 留空时插件把仓库克隆到 `data/meme-plugin/repos/`。但如果机器上
**本来就有**一份（比如装 meme-generator 时克隆在 `/opt/meme`），一定要填成那个路径 —— 否则
`#meme更新` 更新的是插件自己那份副本，而服务端 `config.toml` 里 `meme_dirs` 指向的还是原来那份，
**更新了也不生效，还白占一份磁盘**（这几个仓库合计约 1.8G）。

**`memePm2Name` 必须填名字，不能填数字 ID。** pm2 的数字 ID 会随进程增删而错位 —— 曾经写死
`pm2 restart 2`，结果一直在重启另一个不相干的服务，meme 服务从未重启过，新拉的表情因此永远
加载不进去。判断方法：`pm2 jlist` 看目标进程的 `restart_time` 有没有涨。

**`gitProxy` 建议留空。** 这类 GitHub 前缀镜像（`https://xxx/https://github.com/...`）经常失效，
挂掉时表现为 git 报 **403 / 522 / 直接卡死**，很容易误判成网络不通。如果机器上已经有系统级代理
（`git config --global http.https://github.com/.proxy`），留空直连就是最稳的。

**`searchMaxPreview` / `pageSize` 别调大。** 列表、搜索、分类都出带预览图的网格图，
QQ 气泡里图片最宽只显示约 420px，每格实际宽度就是 `420 ÷ 列数`：24 个约每格 70px，
80 个（12 列）只剩 35px、字号 2.9px，名字彻底读不了（所以名字都另发一份文字版）。
想一次看全应该去 Web 预览站，调大这两个数只会更糊。

## 表情仓库与致谢

插件本身只是个壳，真正好玩的表情全都来自这些作者的辛苦维护，**在此致谢** 🙏

| 仓库 | 表情子目录 | 说明 |
|---|---|---|
| [MeetWq/meme-generator](https://github.com/MeetWq/meme-generator) | — | 表情生成引擎本体，一切的基础 |
| [MemeCrafters/meme-generator-contrib](https://github.com/MemeCrafters/meme-generator-contrib) | `memes` | 社区贡献的表情合集 |
| [anyliew/meme_emoji](https://github.com/anyliew/meme_emoji) | `emoji` | 大量 emoji 风格表情 |
| [anyliew/crazy_emoji](https://github.com/anyliew/crazy_emoji) | `emoji` | 成人向补充包，建议配合 `protectList` / `blackMemes`。同作者的 [meme_emoji_nsfw](https://github.com/anyliew/meme_emoji_nsfw) 内容完全一致（36 个 key 一模一样），二选一即可 |
| [jinjiao007/meme-generator-jj](https://github.com/jinjiao007/meme-generator-jj) | `memes` | 又一批社区表情 |
| [LRZ9712/tudou-meme](https://github.com/LRZ9712/tudou-meme) | `meme` | 土豆表情包，鸣潮/米哈游系列很全 |

`memeSubDir` 各仓库不一样（`emoji` / `memes` / `meme`），加新仓库前先确认一下 ——
填错会让 `meme_dirs` 指向不存在的路径，服务扫不到表情。

**加仓库前建议先量净增量。** meme-generator 按表情 key 全局去重、先加载的赢，仓库之间重复很多：
实测 `crazy_emoji` 和同作者的 `meme_emoji_nsfw` 那 36 个 key **一模一样**，两个都装净增 0；
而 `tudou-meme` 自带 111 个、净新增 **107**。另外表情的 key 来自源码里 `add_meme("key", ...)`
的第一个参数，**不是目录名**，别拿目录名去比对。

## 常见问题

**新拉的表情打不出来？**
表情更新链条有三个必过环节：仓库 `git pull` 成功 → 仓库目录登记进 `config.toml` 的 `meme_dirs`
并重启 meme 服务（它只在进程启动时扫描）→ 刷新插件本地索引。`#meme更新` 会自动走完这三步，
失败时先确认 `memePm2Name` 是否真的匹配 pm2 里的进程名。

**刚重启完 meme 服务，表情数变成个位数？**
别急，它正在扫描 `meme_dirs`，大约要 10 秒。这期间 `/memes/keys` 会返回很小的数字，
等一会儿再查就恢复了。

**Web 站打不开？**
先看日志有没有 `EADDRINUSE`（端口被占，改 `webPort`）。要让别人访问得把 `webUrl` 配成公网
地址，并确保端口在防火墙放行。

**表情数量对不上？**
`#meme部署状态` 会同时显示服务端和本地索引的数量，不一致就发 `#meme刷新`。

## 数据目录

一切数据落在 `Yunzai/data/meme-plugin/`：

```
keyMap.json / infos.json   表情索引缓存，启动时从这里载入
stats.json                 用量统计（内存累加，5 秒防抖写盘）
preview_cache/             Web 预览图缓存（服务端没有缓存，所以本地存一份）
list_cache/                列表 / 搜索 / 分类的出图缓存
original/  result/         生成表情时的临时文件，用完即删
repos/                     表情资源仓库（reposDir 留空时）
venv/                      一键部署时创建的 Python 虚拟环境
```

## 目录结构

```
apps/       指令入口（生成 / 列表 / 搜索 / 开关 / 排行 / 更新 / 部署 / 帮助）
model/      配置、API 封装、表情索引、预览图、用量统计
utils/      参数解析、文件、网格出图、详情出图、榜单出图、meme_dirs 同步、黑名单与群开关
server/     Web 预览站
resources/  Web 前端 + 一键部署脚本
config/     system/ 是默认值，同级的 config.yaml 是用户配置（已 gitignore）
```

用户配置 `config/config.yaml` 不进版本库，改坏了删掉它会从 `config/system/config.yaml`
重新生成。





