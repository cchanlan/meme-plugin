import fs from 'node:fs'
import path from 'node:path'
import MemeIndex from './memeIndex.js'
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
 *
 * 计数分两个尺度，同一次生成两边都加：
 * - 顶层（total/memes/users/days）是跨群总账，`#meme总排行` 看这个；
 * - `g[群号]` 是每个群自己的一份同构小账，`#meme排行` 只看本群那一份。
 *   群里的人只关心「我们群谁最能整活」，掺进别的群的数据榜就没意义了。
 * 顶层的 `groups[群号]` 是群总次数，和 `g[群号].total` 冗余但保留：
 * 旧版本只有它，这样老数据在总榜的群排行里不会凭空消失。
 * 群名单独放 `names[群号]`，不塞进 `g` 里：名字是元数据，
 * 老数据的群没有明细也得有名字可显示（榜上只印群号谁也认不出是哪个群）。
 */

const FILE = () => path.join(dataDir, 'stats.json')

/** days 只留最近 30 天、users 上限 1000、groups 上限 500，防止文件无限长 */
const KEEP_DAYS = 30
const MAX_USERS = 1000
const MAX_GROUPS = 500
/**
 * 每群明细的上限。这一层是「群数 × 每群条目数」的乘积，不设限的话
 * 文件会比原来大一两个数量级（几百个群 × 几百个表情 code）。
 * 明细只留最活跃的 150 个群，每群各榜也只留够出图的量（榜单只取前 10）。
 * 实测 200 群 × 300 表情 × 200 人的极端情况会让 stats.json 涨到 2.3MB，
 * 而写盘是同步的 —— 这几个数就是按「最坏情况别超过 1.5MB」定的。
 */
const MAX_GROUP_DETAIL = 150
const MAX_MEMES_PER_GROUP = 250
const MAX_USERS_PER_GROUP = 150

let data = null
let timer = null

/** 一个统计尺度的空壳（顶层和每群共用同一套结构，出图代码就能一份通吃） */
function emptyScope () {
  return { since: Date.now(), total: 0, memes: {}, users: {}, days: {} }
}

function empty () {
  return { ...emptyScope(), groups: {}, names: {}, g: {} }
}

function load () {
  if (data) return data
  try {
    if (fs.existsSync(FILE())) {
      const raw = JSON.parse(fs.readFileSync(FILE(), 'utf-8'))
      data = { ...empty(), ...raw }
      // 旧版本的文件里没有 g（每群明细），本群榜就从这次起开始攒；
      // 顺手补齐残缺的项，免得后面每处都要防一遍 undefined
      for (const [gid, g] of Object.entries(data.g)) {
        data.g[gid] = { ...emptyScope(), ...(g || {}) }
      }
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

/** 把一个尺度（顶层或某个群）里的天数、用户、表情裁到上限内 */
function trimScope (scope, maxMemes, maxUsers) {
  const days = Object.keys(scope.days).sort().slice(-KEEP_DAYS)
  const kept = {}
  for (const d of days) kept[d] = scope.days[d]
  scope.days = kept
  scope.users = trimObj(scope.users, maxUsers, u => u.n || 0)
  if (maxMemes) scope.memes = trimObj(scope.memes, maxMemes)
}

function flush () {
  timer = null
  if (!data) return
  try {
    trimScope(data, 0, MAX_USERS)
    // 群也要裁：进了上千个群的 bot，这个对象会跟群数一起长，而榜单只取前 10
    data.groups = trimObj(data.groups, MAX_GROUPS)
    // 明细比计数贵得多，所以留得更少；先按 total 砍掉冷群，再裁每个群内部
    data.g = trimObj(data.g, MAX_GROUP_DETAIL, g => g.total || 0)
    for (const g of Object.values(data.g)) {
      trimScope(g, MAX_MEMES_PER_GROUP, MAX_USERS_PER_GROUP)
    }
    // 群名只对还在计数里的群有用，裁掉的群顺手把名字也扔了
    const names = {}
    for (const gid of Object.keys(data.groups)) {
      if (data.names[gid]) names[gid] = data.names[gid]
    }
    data.names = names
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

/** 按值降序取前 n 名 */
function rank (obj, valueOf = v => v, top = 10) {
  return Object.entries(obj)
    .map(([k, v]) => ({ key: k, n: valueOf(v), raw: v }))
    .sort((a, b) => b.n - a.n)
    .slice(0, top)
}

/**
 * 把一个尺度整理成出图要的形状。顶层和每群结构相同，所以这里一份通吃。
 *
 * 拉黑的表情要从榜单里摘掉。计数是历史留下的，拉黑之前用过就一直在 memes 里，
 * 不过滤的话 `#meme统计` 会照样打出它的关键词，出图时还会去拉它的预览图
 * （utils/statsImage.js 每个条目配一张 120px 缩略图）——拿黑名单挡 NSFW 就白挡了。
 * total 不动：那是「一共出了多少张」的事实，跟要不要展示某个表情是两回事。
 */
function scopeSummary (scope, top) {
  const memes = {}
  for (const [k, v] of Object.entries(scope.memes)) {
    if (!MemeIndex.isBlocked(k)) memes[k] = v
  }
  return {
    total: scope.total,
    since: scope.since,
    todayCount: scope.days[today()] || 0,
    activeDays: Object.keys(scope.days).length,
    memeKinds: Object.keys(memes).length,
    userCount: Object.keys(scope.users).length,
    memes: rank(memes, undefined, top),
    users: rank(scope.users, v => v.n || 0, top),
    // 最近 7 天，缺的日期补 0，出图时画趋势条
    recent: (() => {
      const out = []
      for (let i = 6; i >= 0; i--) {
        const t = new Date()
        t.setDate(t.getDate() - i)
        const p = n => String(n).padStart(2, '0')
        const key = `${t.getFullYear()}-${p(t.getMonth() + 1)}-${p(t.getDate())}`
        out.push({ day: key, n: scope.days[key] || 0 })
      }
      return out
    })()
  }
}

/** 往一个尺度里记一次 */
function bump (scope, it, day) {
  scope.total++
  scope.memes[it.code] = (scope.memes[it.code] || 0) + 1
  scope.days[day] = (scope.days[day] || 0) + 1
  if (it.userId) {
    const u = scope.users[String(it.userId)] || { n: 0, name: '' }
    u.n++
    // 昵称每次都刷新：改了名之后榜单跟着变，比留着旧名好
    if (it.name) u.name = String(it.name).slice(0, 16)
    scope.users[String(it.userId)] = u
  }
}

const Stats = {
  /**
   * 记一次成功生成
   * @param {{code:string, userId?:string|number, groupId?:string|number, name?:string, groupName?:string}} it
   */
  record (it) {
    const d = load()
    const day = today()
    bump(d, it, day)
    if (it.groupId) {
      const gid = String(it.groupId)
      d.groups[gid] = (d.groups[gid] || 0) + 1
      // 群名每次都刷新，跟昵称同理；拿不到就别用空串盖掉上次拿到的
      if (it.groupName) d.names[gid] = String(it.groupName).slice(0, 24)
      if (!d.g[gid]) d.g[gid] = emptyScope()
      bump(d.g[gid], it, day)
    }
    if (!timer) timer = setTimeout(flush, 5000)
  },

  /**
   * 出图时问适配器要到的真群名，顺手存下来，下次出图就不用再问一遍。
   */
  rememberGroupName (groupId, name) {
    if (!groupId || !name) return
    const d = load()
    const gid = String(groupId)
    const val = String(name).slice(0, 24)
    if (d.names[gid] === val) return
    d.names[gid] = val
    if (!timer) timer = setTimeout(flush, 5000)
  },

  /**
   * 榜单数据（跨群总账）
   * @param {number} top 各榜取前几名
   */
  summary (top = 10) {
    const d = load()
    return {
      ...scopeSummary(d, top),
      groupCount: Object.keys(d.groups).length,
      // 群榜的名字优先用存下来的真名，没有（老数据）就交给上层去问适配器
      groups: rank(d.groups, undefined, top)
        .map(g => ({ ...g, name: d.names[g.key] || '' }))
    }
  },

  /**
   * 某个群自己的榜单。没记录过返回 total 为 0 的空壳。
   * @param {string|number} groupId
   * @param {number} top
   */
  groupSummary (groupId, top = 10) {
    const d = load()
    const gid = String(groupId)
    const g = d.g[gid]
    return {
      ...scopeSummary(g || emptyScope(), top),
      groupId: gid,
      groupName: d.names[gid] || '',
      groups: [],
      groupCount: 0
    }
  },

  /** 某个群自己贡献了多少次（含明细建立之前的老计数） */
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
