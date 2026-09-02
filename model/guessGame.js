import fs from 'node:fs'
import path from 'node:path'
import { dataDir, logPrefix } from '../constants/path.js'
import { mkdirs } from '../utils/file.js'

/**
 * 猜表情：出一张图，谁先说出表情的名字谁赢。
 *
 * 分两块 ——
 * 1. **进行中的题目**放内存 Map。一局只活几十秒，重启丢掉无所谓，
 *    不值得落盘。挂 global 是因为 apps 热更会重新 import 本模块，
 *    模块级变量会跟着归零（和 utils/cooldown.js 同一条坑）。
 * 2. **答对计数**落 data/guess.json，结构照 model/stats.js 那套
 *    「顶层总账 + g[群号] 明细」：群里的人只关心自己群谁最会猜。
 *
 * 超时公布答案的定时器句柄也存在题目里 —— 答对时要能把它撤掉，
 * 不然一局结束后过一会儿还会再刷一条「答案是…」。
 */

const FILE = () => path.join(dataDir, 'guess.json')

/** users 上限，和 stats 同一个量级 */
const MAX_USERS = 1000
const MAX_GROUPS = 500
const MAX_GROUP_DETAIL = 150
const MAX_USERS_PER_GROUP = 150

const GAMES_KEY = 'memePluginGuessGames'

let data = null
let timer = null

/** @returns {Map<string, object>} 会话 key → 进行中的题目 */
function games () {
  if (!global[GAMES_KEY]) global[GAMES_KEY] = new Map()
  return global[GAMES_KEY]
}

function emptyScope () {
  return { since: Date.now(), total: 0, users: {} }
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
      for (const [gid, g] of Object.entries(data.g)) {
        data.g[gid] = { ...emptyScope(), ...(g || {}) }
      }
    } else {
      data = empty()
    }
  } catch (err) {
    logger.error(`${logPrefix} 读取猜表情记分失败，从零开始: ${err.message}`)
    data = empty()
  }
  return data
}

/** 按值降序裁到 n 项 */
function trimObj (obj, n, valueOf = v => v) {
  const keys = Object.keys(obj)
  if (keys.length <= n) return obj
  const kept = keys.sort((a, b) => valueOf(obj[b]) - valueOf(obj[a])).slice(0, n)
  const out = {}
  for (const k of kept) out[k] = obj[k]
  return out
}

function flush () {
  timer = null
  if (!data) return
  try {
    data.users = trimObj(data.users, MAX_USERS, u => u.n || 0)
    data.groups = trimObj(data.groups, MAX_GROUPS)
    data.g = trimObj(data.g, MAX_GROUP_DETAIL, g => g.total || 0)
    for (const g of Object.values(data.g)) {
      g.users = trimObj(g.users, MAX_USERS_PER_GROUP, u => u.n || 0)
    }
    const names = {}
    for (const gid of Object.keys(data.groups)) {
      if (data.names[gid]) names[gid] = data.names[gid]
    }
    data.names = names
    mkdirs(dataDir)
    fs.writeFileSync(FILE(), JSON.stringify(data), 'utf-8')
  } catch (err) {
    logger.error(`${logPrefix} 写入猜表情记分失败: ${err.message}`)
  }
}

// 退出前补一次写盘，理由同 model/stats.js
if (!global.memePluginGuessExitHook) {
  global.memePluginGuessExitHook = true
  process.once('exit', () => {
    if (timer) {
      clearTimeout(timer)
      flush()
    }
  })
}

function rank (obj, top) {
  return Object.entries(obj)
    .map(([k, v]) => ({ key: k, n: v.n || 0, name: v.name || '' }))
    .sort((a, b) => b.n - a.n)
    .slice(0, top)
}

function bump (scope, userId, name) {
  scope.total++
  const u = scope.users[String(userId)] || { n: 0, name: '' }
  u.n++
  if (name) u.name = String(name).slice(0, 16)
  scope.users[String(userId)] = u
}

const GuessGame = {
  /** 会话 key：群里一局大家一起猜，私聊各算各的 */
  keyOf (e) {
    return e.group_id ? `g:${e.group_id}` : `p:${e.user_id}`
  },

  /** 这里有没有进行中的题目。**同步且不做 IO** —— 每条消息都要过这一下 */
  current (e) {
    return games().get(this.keyOf(e)) || null
  },

  /**
   * 开一局
   * @param {object} e
   * @param {{code:string, keywords:string[], timer?:object}} it
   */
  start (e, it) {
    games().set(this.keyOf(e), {
      code: it.code,
      // 全部小写存好，判定时就不用每次再转一遍
      answers: (it.keywords || []).map(k => String(k).trim().toLowerCase()).filter(Boolean),
      startedAt: Date.now(),
      timer: it.timer || null
    })
  },

  /** 结束这一局，顺手撤掉超时定时器 */
  finish (e) {
    const key = this.keyOf(e)
    const game = games().get(key)
    if (game?.timer) clearTimeout(game.timer)
    games().delete(key)
    return game || null
  },

  /**
   * 这句话是不是正确答案。
   *
   * 要求**完全相等**而不是包含：表情名里有「摸」「贴」这种一个字的，
   * 用包含判会让随便一句闲聊都算猜对。
   */
  isAnswer (game, msg) {
    const s = String(msg || '').trim().toLowerCase()
    if (!s) return false
    return game.answers.includes(s)
  },

  /** 记一次猜对 */
  record (it) {
    const d = load()
    bump(d, it.userId, it.name)
    if (it.groupId) {
      const gid = String(it.groupId)
      d.groups[gid] = (d.groups[gid] || 0) + 1
      if (it.groupName) d.names[gid] = String(it.groupName).slice(0, 24)
      if (!d.g[gid]) d.g[gid] = emptyScope()
      bump(d.g[gid], it.userId, it.name)
    }
    if (!timer) timer = setTimeout(flush, 5000)
  },

  /** 某人猜对过几次（本群） */
  userScore (groupId, userId) {
    const d = load()
    const scope = groupId ? d.g[String(groupId)] : d
    return scope?.users?.[String(userId)]?.n || 0
  },

  /** 跨群总榜 */
  summary (top = 10) {
    const d = load()
    return {
      total: d.total,
      since: d.since,
      userCount: Object.keys(d.users).length,
      groupCount: Object.keys(d.groups).length,
      users: rank(d.users, top),
      groups: Object.entries(d.groups)
        .map(([k, n]) => ({ key: k, n, name: d.names[k] || '' }))
        .sort((a, b) => b.n - a.n)
        .slice(0, top)
    }
  },

  /** 本群榜 */
  groupSummary (groupId, top = 10) {
    const d = load()
    const gid = String(groupId)
    const g = d.g[gid] || emptyScope()
    return {
      total: g.total,
      since: g.since,
      userCount: Object.keys(g.users).length,
      groupName: d.names[gid] || '',
      users: rank(g.users, top),
      groups: []
    }
  },

  /** 清空重来 */
  reset () {
    const before = load().total
    data = empty()
    flush()
    return before
  }
}

export default GuessGame
