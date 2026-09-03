import fs from 'node:fs'
import path from 'node:path'
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
 * 所以自己记一份：`refreshFromApi()` 本来就在算新旧差集（`added`），
 * 顺手把首见时间存下来，排序时优先用它。
 *
 * 首次建立时（老用户升级到带这个文件的版本）**不能把所有表情都标成「今天」**，
 * 那样 `#meme新增` 会变成随机 24 个。所以初始化时一律回退到作者日期，
 * 只有此后真正新增的才打上真实时间戳。
 */

const FILE = () => path.join(dataDir, 'firstSeen.json')

/** code → 首见时间（毫秒时间戳）。null 表示还没读过 */
let data = null

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
   * 排序用的键：优先本机首见时间，没有就回退作者标注的日期。
   *
   * 返回的是可直接比大小的数字（毫秒）。作者日期是 "2026-08-24T00:00:00"
   * 这种定长 ISO 串，Date.parse 认得；解析失败当 0。
   */
  sortKey (code, info) {
    const seen = this.get(code)
    if (seen) return seen
    const raw = info?.date_modified || info?.date_created || ''
    const t = raw ? Date.parse(raw) : 0
    return Number.isNaN(t) ? 0 : t
  },

  /** 清空（卸载服务时不调用 —— 重装回来那些表情本来就见过，不该都算新的） */
  reset () {
    data = {}
    save()
  }
}

export default FirstSeen
