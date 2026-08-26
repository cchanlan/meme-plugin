import fs from 'node:fs'
import path from 'node:path'
import { dataDir, logPrefix } from '../constants/path.js'
import { mkdirs } from '../utils/file.js'

/**
 * 表情用量统计。
 *
 * 只在「生成成功」时记一次（失败、参数不够、被拉黑都不算），
 * 所以榜单反映的是真正发出去的表情。
 *
 * 落盘策略是内存累加 + 5 秒防抖写盘：出表情是高频操作，
 * 每次同步 writeFileSync 会把生成的耗时白搭在 IO 上；
 * 代价是硬杀进程可能丢最后几秒的计数，对榜单无所谓。
 */

const FILE = () => path.join(dataDir, 'stats.json')

/** days 只留最近 30 天、users 上限 1000、groups 上限 500，防止文件无限长 */
const KEEP_DAYS = 30
const MAX_USERS = 1000
const MAX_GROUPS = 500

let data = null
let timer = null

function empty () {
  return { since: Date.now(), total: 0, memes: {}, users: {}, groups: {}, days: {} }
}

function load () {
  if (data) return data
  try {
    if (fs.existsSync(FILE())) {
      const raw = JSON.parse(fs.readFileSync(FILE(), 'utf-8'))
      data = { ...empty(), ...raw }
    } else {
      data = empty()
    }
  } catch (err) {
    logger.error(`${logPrefix} 读取统计失败，从零开始: ${err.message}`)
    data = empty()
  }
  return data
}

function today () {
  // 用本地日期而不是 UTC：榜单上的「今日」要跟人的作息对得上
  const d = new Date()
  const p = n => String(n).padStart(2, '0')
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}`
}

/** 按值降序裁到 n 项 */
function trimObj (obj, n, valueOf = v => v) {
  const keys = Object.keys(obj)
  if (keys.length <= n) return obj
  const kept = keys
    .sort((a, b) => valueOf(obj[b]) - valueOf(obj[a]))
    .slice(0, n)
  const out = {}
  for (const k of kept) out[k] = obj[k]
  return out
}

function flush () {
  timer = null
  if (!data) return
  try {
    const days = Object.keys(data.days).sort().slice(-KEEP_DAYS)
    const kept = {}
    for (const d of days) kept[d] = data.days[d]
    data.days = kept
    data.users = trimObj(data.users, MAX_USERS, u => u.n || 0)
    // 群也要裁：进了上千个群的 bot，这个对象会跟群数一起长，而榜单只取前 10
    data.groups = trimObj(data.groups, MAX_GROUPS)
    mkdirs(dataDir)
    fs.writeFileSync(FILE(), JSON.stringify(data), 'utf-8')
  } catch (err) {
    logger.error(`${logPrefix} 写入统计失败: ${err.message}`)
  }
}

/**
 * 退出前补一次写盘。
 *
 * 防抖窗口是 5 秒，而 `#meme插件更新` 之后紧跟着重启 Yunzai —— 刚出的那几张
 * 表情正好落在窗口里，重启一次就少几次计数。exit 钩子里只能跑同步 IO，
 * flush 本身就是 writeFileSync，正好合用。
 *
 * 挂在 global 上判重：apps 热更会重新 import 本模块，不判会一路叠加监听器，
 * Node 到 11 个就开始刷 MaxListenersExceededWarning。
 */
if (!global.memePluginStatsExitHook) {
  global.memePluginStatsExitHook = true
  process.once('exit', () => {
    if (timer) {
      clearTimeout(timer)
      flush()
    }
  })
}

const Stats = {
  /**
   * 记一次成功生成
   * @param {{code:string, userId?:string|number, groupId?:string|number, name?:string}} it
   */
  record (it) {
    const d = load()
    d.total++
    d.memes[it.code] = (d.memes[it.code] || 0) + 1
    d.days[today()] = (d.days[today()] || 0) + 1
    if (it.userId) {
      const u = d.users[String(it.userId)] || { n: 0, name: '' }
      u.n++
      // 昵称每次都刷新：改了名之后榜单跟着变，比留着旧名好
      if (it.name) u.name = String(it.name).slice(0, 16)
      d.users[String(it.userId)] = u
    }
    if (it.groupId) {
      const g = String(it.groupId)
      d.groups[g] = (d.groups[g] || 0) + 1
    }
    if (!timer) timer = setTimeout(flush, 5000)
  },

  /**
   * 榜单数据
   * @param {number} top 各榜取前几名
   */
  summary (top = 10) {
    const d = load()
    const rank = (obj, valueOf = v => v) => Object.entries(obj)
      .map(([k, v]) => ({ key: k, n: valueOf(v), raw: v }))
      .sort((a, b) => b.n - a.n)
      .slice(0, top)
    const days = Object.keys(d.days).sort()
    return {
      total: d.total,
      since: d.since,
      todayCount: d.days[today()] || 0,
      activeDays: days.length,
      memeKinds: Object.keys(d.memes).length,
      userCount: Object.keys(d.users).length,
      groupCount: Object.keys(d.groups).length,
      memes: rank(d.memes),
      users: rank(d.users, v => v.n || 0),
      groups: rank(d.groups),
      // 最近 7 天，缺的日期补 0，出图时画趋势条
      recent: (() => {
        const out = []
        for (let i = 6; i >= 0; i--) {
          const t = new Date()
          t.setDate(t.getDate() - i)
          const p = n => String(n).padStart(2, '0')
          const key = `${t.getFullYear()}-${p(t.getMonth() + 1)}-${p(t.getDate())}`
          out.push({ day: key, n: d.days[key] || 0 })
        }
        return out
      })()
    }
  },

  /** 某个群自己贡献了多少次 */
  groupTotal (groupId) {
    return load().groups[String(groupId)] || 0
  },

  /** 清空重来（主人手动） */
  reset () {
    const before = load().total
    data = empty()
    flush()
    return before
  }
}

export default Stats
