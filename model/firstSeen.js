import fs from 'node:fs'
import path from 'node:path'
import Config from './config.js'
import { reposRoot } from '../utils/memeDirs.js'
import { dataDir, logPrefix } from '../constants/path.js'
import { mkdirs } from '../utils/file.js'

/**
 * 「本机第一次见到这个表情」的时间。
 *
 * 服务端给的 `date_modified` / `date_created` 是**表情作者标注的日期**，
 * 跟「你什么时候装上它」没关系 —— 实测某次 `#meme更新` 拉到的「奶龙打」
 * 作者写的是 2026-07-13，而索引里早就有 8 月、9 月的表情，
 * 于是它在「按日期排」里只排到第 26 位，`#meme新增` 的前 24 名根本看不见它。
 * 「更新完了却看不到新表情」就是这么来的。
 *
 * 时间从两个来源取，优先级从高到低：
 *
 * 1. **表情仓库目录的 mtime**（本机服务才有）。git pull 下来的新表情目录
 *    带着真实的落地时间，实测 655 个目录扫一遍只要 23ms，
 *    而且**回溯有效** —— 装插件之前就拉好的表情也能排出正确顺序。
 *    只能覆盖 562/946：另外那些的目录名和 code 对不上（`add_meme` 里改过 key）。
 * 2. **`refreshFromApi()` 时记的时间戳**。目录名对不上、或者用的是别人的
 *    远程服务时，靠这个补 —— 但它只对「记录建立之后」新增的生效。
 *
 * 两个都没有就回退作者日期（`sortKey`）。
 *
 * 首次建立时（老用户升级到带这个文件的版本）**不能把所有表情都标成「今天」**，
 * 那样 `#meme新增` 会变成随机 24 个。所以初始化时一律记 0，
 * 只有此后真正新增的才打上真实时间戳。
 */

const FILE = () => path.join(dataDir, 'firstSeen.json')

/** 一个表情目录的判据：里面有 __init__.py */
const MEME_MARK = '__init__.py'
/** 扫仓库时跳过的目录名 */
const SKIP_DIRS = new Set(['.git', '__pycache__', 'images', 'docs', 'resources', '.github', 'node_modules'])

/** code → 首见时间（毫秒时间戳）。null 表示还没读过 */
let data = null
/** 仓库目录 mtime 的缓存：code → mtimeMs。扫一次要 20 多毫秒，别每次排序都扫 */
let repoMtimes = null

function load () {
  if (data) return data
  try {
    if (fs.existsSync(FILE())) {
      data = JSON.parse(fs.readFileSync(FILE(), 'utf-8')) || {}
    } else {
      data = {}
    }
  } catch (err) {
    logger.error(`${logPrefix} 读取首见记录失败，从零开始: ${err.message}`)
    data = {}
  }
  return data
}

function save () {
  try {
    mkdirs(dataDir)
    fs.writeFileSync(FILE(), JSON.stringify(data), 'utf-8')
  } catch (err) {
    logger.error(`${logPrefix} 写入首见记录失败: ${err.message}`)
  }
}

/**
 * 扫表情仓库，拿每个表情目录的 mtime。
 *
 * 只在本机自管服务时有意义 —— 用别人的远程服务时本机根本没有仓库目录。
 * 深度限 4 层：各仓库的结构是 `<repo>/emoji/<code>/`、`<repo>/memes/<code>/`、
 * `<repo>/meme/<code>/`，四层够用，再深就是表情自己的 images/ 了。
 */
function scanRepos () {
  if (repoMtimes) return repoMtimes
  repoMtimes = new Map()
  if (!Config.isLocalService()) return repoMtimes

  const root = reposRoot()
  if (!fs.existsSync(root)) return repoMtimes

  const walk = (dir, depth) => {
    if (depth > 4) return
    let ents
    try {
      ents = fs.readdirSync(dir, { withFileTypes: true })
    } catch {
      return
    }
    // 这一层有 __init__.py，说明它就是一个表情，不用再往下钻
    if (ents.some(x => x.isFile() && x.name === MEME_MARK)) {
      try {
        repoMtimes.set(path.basename(dir), fs.statSync(dir).mtimeMs)
      } catch {}
      return
    }
    for (const x of ents) {
      if (x.isDirectory() && !SKIP_DIRS.has(x.name)) walk(path.join(dir, x.name), depth + 1)
    }
  }

  const t0 = Date.now()
  walk(root, 0)
  logger.debug(`${logPrefix} 扫到 ${repoMtimes.size} 个表情目录，耗时 ${Date.now() - t0}ms`)
  return repoMtimes
}

const FirstSeen = {
  /** 某个表情的首见时间，没记录返回 0 */
  get (code) {
    return load()[code] || 0
  },

  /**
   * 跟当前索引对一遍账。
   *
   * @param {string[]} codes 当前索引里的全部表情
   * @param {boolean} initial 是不是首次建立（此前没有这个文件）
   * @returns {string[]} 这次真正新出现的 code
   */
  sync (codes, initial = false) {
    const d = load()
    const now = Date.now()
    const fresh = []
    for (const code of codes) {
      // 判「有没有这个键」而不是判值 —— 首次建立时存的是 0，
      // 用 `if (d[code])` 会因为 0 是 falsy 而把它们全当成新表情，
      // 下一次 sync 就把 900 多个老表情集体标成「刚装的」
      if (Object.hasOwn(d, code)) continue
      // 首次建立时全部记 0：0 会让排序回退到作者日期，
      // 不会把老表情伪装成「刚装的」
      d[code] = initial ? 0 : now
      if (!initial) fresh.push(code)
    }
    // 表情被删掉（仓库移除、拉黑不算）时把记录也清掉，免得文件只增不减
    const alive = new Set(codes)
    for (const code of Object.keys(d)) {
      if (!alive.has(code)) delete d[code]
    }
    save()
    return fresh
  },

  /** 有没有这个文件 —— 用来判断是不是首次建立 */
  exists () {
    return fs.existsSync(FILE())
  },

  /**
   * 排序用的键：仓库目录 mtime > 记下的首见时间 > 作者标注的日期。
   *
   * 返回可直接比大小的毫秒数。作者日期是 "2026-08-24T00:00:00" 这种
   * 定长 ISO 串，Date.parse 认得；解析失败当 0。
   */
  sortKey (code, info) {
    const mtime = scanRepos().get(code)
    if (mtime) return mtime
    const seen = this.get(code)
    if (seen) return seen
    const raw = info?.date_modified || info?.date_created || ''
    const t = raw ? Date.parse(raw) : 0
    return Number.isNaN(t) ? 0 : t
  },

  /**
   * 丢掉仓库扫描缓存。
   * `#meme更新` 拉了新仓库之后要调一次，否则新表情的 mtime 读不到。
   */
  invalidate () {
    repoMtimes = null
  },

  /** 清空（卸载服务时不调用 —— 重装回来那些表情本来就见过，不该都算新的） */
  reset () {
    data = {}
    repoMtimes = null
    save()
  }
}

export default FirstSeen
