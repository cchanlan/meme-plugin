import fs from 'node:fs'
import path from 'node:path'
import os from 'node:os'
import Config from '../model/config.js'
import { dataDir, logPrefix } from '../constants/path.js'

/**
 * 把订阅仓库的表情目录同步进 meme-generator 的 config.toml。
 *
 * meme-generator 只认 config.toml 里的 meme_dirs，仓库 clone 下来了但没登记进去，
 * 服务重启多少次也扫不到 —— 以前加仓库必须手动改这个文件，漏改就是「更新了没反应」。
 *
 * 只动 meme_dirs 这一行，其余配置（disabled_list、resource_urls 等）原样保留。
 */

/**
 * config.toml 的位置。
 *
 * meme-generator 用的是 nonebot plugin-localstore 那套目录规则（见它的 dirs.py，
 * `user_config_dir(appname)` 默认 `roaming=True`），三个平台各不相同：
 *   Windows → %APPDATA%\meme_generator          ← 是 Roaming 不是 Local，容易搞错
 *   macOS   → ~/Library/Application Support/meme_generator
 *   Linux   → $XDG_CONFIG_HOME/meme_generator，未设时才是 ~/.config/meme_generator
 * 早先这里写死了 ~/.config，Windows 上会指向一个服务根本不读的路径，
 * Linux 上设过 XDG_CONFIG_HOME 的机器也会找错。
 */
export function tomlPath () {
  const app = 'meme_generator'
  let dir
  if (process.platform === 'win32') {
    dir = path.join(process.env.APPDATA || path.join(os.homedir(), 'AppData', 'Roaming'), app)
  } else if (process.platform === 'darwin') {
    dir = path.join(os.homedir(), 'Library', 'Application Support', app)
  } else {
    dir = path.join(process.env.XDG_CONFIG_HOME || path.join(os.homedir(), '.config'), app)
  }
  return path.join(dir, 'config.toml')
}

/** 仓库根目录：优先配置的 reposDir，否则插件数据目录 */
export function reposRoot () {
  const custom = String(Config.get('reposDir') || '').trim()
  // 尾部斜杠两种都要清 —— Windows 上用户很可能填 D:\meme\
  return custom ? custom.replace(/[\\/]+$/, '') : path.join(dataDir, 'repos')
}

/**
 * 按订阅列表算出应该写进 meme_dirs 的路径。
 * 只收真实存在的目录 —— memeSubDir 填错时宁可少一条，
 * 也不要把不存在的路径塞进去让服务启动时报错。
 */
export function expectedDirs () {
  const root = reposRoot()
  const dirs = []
  const skipped = []
  for (const repo of Config.get('repos') || []) {
    if (!repo?.dir) continue
    const sub = String(repo.memeSubDir || '').trim()
    const full = sub ? path.join(root, repo.dir, sub) : path.join(root, repo.dir)
    if (fs.existsSync(full)) dirs.push(full)
    else skipped.push({ name: repo.name || repo.dir, path: full })
  }
  return { dirs, skipped }
}

/** 从 toml 文本里取出当前的 meme_dirs 数组 */
function parseCurrent (text) {
  const m = text.match(/^[ \t]*meme_dirs[ \t]*=[ \t]*\[([\s\S]*?)\]/m)
  if (!m) return null
  return [...m[1].matchAll(/["']([^"']+)["']/g)].map(x => x[1])
}

/**
 * 同步 meme_dirs。
 * @returns {{ok:boolean, changed:boolean, reason?:string, added?:string[], removed?:string[], dirs?:string[], skipped?:Array}}
 */
export function syncMemeDirs () {
  const file = tomlPath()
  const { dirs, skipped } = expectedDirs()

  if (!fs.existsSync(file)) {
    return { ok: false, changed: false, reason: `找不到 ${file}`, skipped }
  }

  let text
  try {
    text = fs.readFileSync(file, 'utf-8')
  } catch (err) {
    return { ok: false, changed: false, reason: `读取失败：${err.message}`, skipped }
  }

  const current = parseCurrent(text)
  if (current === null) {
    return { ok: false, changed: false, reason: 'config.toml 里没有 meme_dirs 行', skipped }
  }

  // 配置里没登记、但用户自己往 meme_dirs 加过的路径要留着，别把人家的手工配置抹了
  const managed = new Set(dirs)
  const foreign = current.filter(d => !managed.has(d) && !d.startsWith(reposRoot() + path.sep))
  const final = [...dirs, ...foreign]

  const added = final.filter(d => !current.includes(d))
  const removed = current.filter(d => !final.includes(d))
  if (added.length === 0 && removed.length === 0) {
    return { ok: true, changed: false, dirs: final, skipped }
  }

  const line = `meme_dirs = [${final.map(d => JSON.stringify(d)).join(',')}]`
  // 用函数形式返回替换文本：字符串形式里 `$` 是特殊字符（`$&`、`$'`…），
  // 路径里带 $ 的机器（reposDir 填成 /data/$user/repos 之类）会被替换成别的东西
  const next = text.replace(/^[ \t]*meme_dirs[ \t]*=[ \t]*\[[\s\S]*?\]/m, () => line)

  try {
    // 改前留一份，写坏了还能还原
    fs.copyFileSync(file, `${file}.bak`)
    fs.writeFileSync(file, next, 'utf-8')
  } catch (err) {
    return { ok: false, changed: false, reason: `写入失败：${err.message}`, skipped }
  }

  logger.mark(`${logPrefix} meme_dirs 已同步：+${added.length} -${removed.length}`)
  return { ok: true, changed: true, added, removed, dirs: final, skipped }
}
