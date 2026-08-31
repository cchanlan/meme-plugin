/**
 * 用户信息与头像。
 *
 * 这里刻意不碰任何适配器的私有接口。原来那句 `Bot.sendApi('get_group_member_info', ...)`
 * 是错的：`sendApi` 是各适配器挂在 **bot 实例** 上的（`e.bot.sendApi` / `Bot[uin].sendApi`，
 * 见 plugins/adapter/OneBotv11.js 的 getMemberInfo），全局 `Bot` 上从来没有这个方法。
 * 所以不论 icqq 还是 OneBot，每次 @人 都稳定抛 `Bot.sendApi is not a function`，
 * 名片和性别拿不到、名字退化成「用户12345」，而且错误只进日志、用户侧毫无察觉。
 *
 * 改成走 Yunzai 各适配器都实现的那套：`e.group.pickMember(uid)` → `getInfo()` / `getAvatarUrl()`。
 * 顺序是「本地缓存 → 适配器接口 → 消息里带的昵称 → 兜底」，能不发网络请求就不发。
 */

import { logPrefix } from '../constants/path.js'

/** 纯数字才可能是 QQ 号。官方 bot 的 openid、微信 wxid 拿去拼 qlogo 只会得到一张灰头像 */
const isQQ = uid => /^\d{5,}$/.test(String(uid ?? ''))

/**
 * QQ 公开头像地址。给「只有 QQ 号、拿不到 e」的地方（排行榜、网页版填号取头像）用，
 * 事件里能拿到 e 的一律走下面的 getAvatarUrl，先问适配器。
 *
 * 默认 s=640 是原图档：原来 at 来的头像写死 s=160、自己的头像却是 s=0（等于原图），
 * 同一个表情里两张脸一个清一个糊。榜单那种小圆头像才需要传小尺寸。
 */
export const qqAvatar = (uid, size = 640) => `https://q1.qlogo.cn/g?b=qq&s=${size}&nk=${uid}`

/** 取群成员对象（不发请求，只是拿到带方法的壳），拿不到返回 null */
function pickMember (e, uid) {
  try {
    if (typeof e.group?.pickMember === 'function') return e.group.pickMember(uid)
    if (e.group_id && typeof e.bot?.pickMember === 'function') {
      return e.bot.pickMember(e.group_id, uid)
    }
  } catch {
    // 有的适配器在非群场景直接抛，交给下一级兜底
  }
  return null
}

/** 取用户对象（私聊 / 非群场景） */
function pickUser (e, uid) {
  try {
    if (typeof e.bot?.pickUser === 'function') return e.bot.pickUser(uid)
    if (typeof e.bot?.pickFriend === 'function') return e.bot.pickFriend(uid)
  } catch {
    // 同上
  }
  return null
}

/** 调用可能是同步、可能是异步、也可能不存在的 getAvatarUrl */
async function tryGetAvatarUrl (obj) {
  if (typeof obj?.getAvatarUrl !== 'function') return ''
  try {
    const url = await obj.getAvatarUrl(0)
    return typeof url === 'string' ? url : ''
  } catch {
    return ''
  }
}

/**
 * 群成员缓存（gml）里现成的那份，命中就一次网络请求都不用发。
 * uid 要试两种类型：消息里的 at.qq 常是字符串，而 gml 的 key 是适配器塞进去的
 * `user_id`（OneBot 那边是数字），Map 是严格相等，类型不对就白白 miss。
 */
function memberCache (e, uid) {
  const gml = e.bot?.gml
  if (typeof gml?.get !== 'function') return null
  const map = gml.get(e.group_id) ?? gml.get(Number(e.group_id)) ?? gml.get(String(e.group_id))
  if (typeof map?.get !== 'function') return null
  return map.get(uid) ?? map.get(Number(uid)) ?? map.get(String(uid)) ?? null
}

/**
 * 某个用户的头像地址。
 *
 * 先问适配器要 —— 这是唯一能同时照顾到微信、Satori、官方 bot 的路子，
 * 那些平台的 uid 不是 QQ 号，拼 qlogo 地址等于给张灰头像。
 * 问不到才退回 QQ 公开头像（uid 得先像个 QQ 号）。
 */
export async function getAvatarUrl (e, uid) {
  const cached = memberCache(e, uid)?.avatar
  if (typeof cached === 'string' && cached) return cached

  let url = await tryGetAvatarUrl(pickMember(e, uid))
  if (!url) url = await tryGetAvatarUrl(pickUser(e, uid))
  if (!url && isQQ(uid)) url = qqAvatar(uid)
  return url
}

/**
 * 发消息这个人自己的头像。
 * `e.getAvatarUrl` 是部分适配器直接挂在事件上的快捷方式，有就先用它。
 */
export async function getSelfAvatarUrl (e) {
  const uid = e.sender?.user_id ?? e.user_id
  if (typeof e.getAvatarUrl === 'function') {
    const url = await e.getAvatarUrl(0).catch(() => '')
    if (url) return url
  }
  if (typeof e.sender?.avatar === 'string' && e.sender.avatar) return e.sender.avatar
  return await getAvatarUrl(e, uid)
}

/**
 * 群成员 uid 列表，给「随机抽群友」用。
 *
 * 先吃 gml 缓存（一次请求都不发），没有再问适配器要 getMemberMap()。
 * 拿不到就返回空数组 —— 调用方要能在「只有发起人」的情况下退化，
 * 私聊、官方 bot 这些场景本来就没有群成员名单。
 *
 * 机器人自己要剔掉：抽到它自己去跟人贴贴很怪，而且它的头像多半是张 logo。
 *
 * @returns {Promise<string[]>}
 */
export async function getMemberList (e) {
  if (!e.group_id) return []
  let ids = []

  const gml = e.bot?.gml
  const cached = typeof gml?.get === 'function'
    ? (gml.get(e.group_id) ?? gml.get(Number(e.group_id)) ?? gml.get(String(e.group_id)))
    : null
  if (cached && typeof cached.keys === 'function') ids = [...cached.keys()]

  if (!ids.length && typeof e.group?.getMemberMap === 'function') {
    try {
      const map = await e.group.getMemberMap()
      if (map && typeof map.keys === 'function') ids = [...map.keys()]
      else if (map) ids = Object.keys(map)
    } catch (err) {
      logger.debug(`${logPrefix} 取群成员列表失败：${err.message}`)
    }
  }

  const self = String(e.self_id ?? e.bot?.uin ?? '')
  return ids.map(String).filter(id => id && id !== self)
}

/**
 * 群名。榜单上只印群号谁也认不出是哪个群，所以要拿真名。
 *
 * 取法按代价从低到高：事件自带 → 群列表缓存（gl）→ 问适配器。
 * gl 的 key 类型和 gml 一样不可靠（OneBot 塞的是数字 group_id，
 * 而 e.group_id 在有些适配器上是字符串），所以两种都试。
 */

/** 一个群信息对象里的名字，字段名各适配器不一样 */
function nameOfGroupInfo (info) {
  const name = info?.group_name || info?.name || info?.title
  return typeof name === 'string' ? name.trim() : ''
}

/** 从 gl（群列表缓存）里查，不发请求。gl 为 getter 的实现每次访问都重建 Map，所以只读一次 */
function groupFromCache (gl, gid) {
  if (typeof gl?.get !== 'function') return null
  return gl.get(gid) ?? gl.get(Number(gid)) ?? gl.get(String(gid)) ?? null
}

/**
 * 本群群名，全同步、不发请求 —— 给记统计这种高频路径用，
 * 拿不到就返回空串（调用方不要用空串盖掉上次存下来的名字）。
 */
export function groupNameOf (e) {
  if (!e?.group_id) return ''
  const direct = e.group_name || nameOfGroupInfo(e.group)
  if (direct) return String(direct).trim()
  return nameOfGroupInfo(groupFromCache(e.bot?.gl, e.group_id))
}

/**
 * 取任意群的名字，允许发请求（出图前批量补名字用）。
 * 拿不到就返回空串，出图侧退回显示群号 —— 不能因为一个群名把整张图卡住。
 *
 * @param {object} e 消息事件（可能拿不到，允许传 null）
 * @param {string|number} gid 群号
 * @param {Map} [gl] 预先取好的群列表缓存，批量取名时复用同一份
 */
export async function getGroupName (e, gid, gl) {
  if (!gid) return ''
  if (e?.group_id && String(e.group_id) === String(gid)) {
    const own = groupNameOf(e)
    if (own) return own
  }
  const cached = nameOfGroupInfo(groupFromCache(gl ?? e?.bot?.gl, gid))
  if (cached) return cached

  // 缓存里没有：可能是 bot 已经退了的群，也可能是别的 bot 账号的群。
  // 用 strict 版 pickGroup（宿主 lib/bot.js 支持）先问「到底有没有这个群」，
  // 免得对着一个不存在的群号白发一次网络请求。
  let group = null
  try {
    if (typeof global.Bot?.pickGroup === 'function') group = global.Bot.pickGroup(gid, true) || null
    if (!group && typeof e?.bot?.pickGroup === 'function') group = e.bot.pickGroup(gid)
  } catch {
    // 适配器在群不存在时可能直接抛，当成拿不到
  }
  if (typeof group?.getInfo !== 'function') return nameOfGroupInfo(group)
  try {
    return nameOfGroupInfo(await group.getInfo()) || nameOfGroupInfo(group)
  } catch (err) {
    logger.debug(`${logPrefix} 取群 ${gid} 名字失败：${err.message}`)
    return nameOfGroupInfo(group)
  }
}

/**
 * 批量取群名，给群排行榜用。
 * 群列表缓存只取一次；剩下要发请求的那几个并行跑，串行会把出图等成一串。
 *
 * @returns {Promise<Record<string, string>>} 群号 → 群名（拿不到的不进结果）
 */
export async function getGroupNames (e, gids) {
  let gl = e?.bot?.gl
  if (typeof gl?.get !== 'function') {
    // 全局 Bot.gl 是个 getter，每次访问都要遍历所有 bot 重建 Map，所以只在这里取一次
    try {
      gl = global.Bot?.gl
    } catch {
      gl = undefined
    }
  }
  const out = {}
  await Promise.all([...new Set(gids.map(String))].map(async gid => {
    const name = await getGroupName(e, gid, gl)
    if (name) out[gid] = name
  }))
  return out
}

/**
 * 群成员的名片与性别，给表情的 user_infos 用。
 *
 * @param {object} e 消息事件
 * @param {string|number} uid 目标用户
 * @param {string} [fallbackName] 消息里 @ 段自带的昵称，比「用户12345」好看得多
 * @returns {Promise<{qq, gender, text}>}
 */
export async function getMemberInfo (e, uid, fallbackName = '') {
  const clean = String(fallbackName || '').replace(/^@/, '').trim()
  const out = { qq: uid, gender: 'unknown', text: clean || `用户${uid}` }

  // 1. 群成员缓存里已经有就直接用，一次请求都不发
  const cached = memberCache(e, uid)
  const from = info => {
    if (!info) return false
    const name = info.card || info.nickname || info.name || info.user_displayname
    if (name) out.text = String(name)
    if (info.sex) out.gender = info.sex
    else if (info.gender) out.gender = info.gender
    return Boolean(name)
  }
  if (from(cached)) return out

  // 2. 问适配器。这一步会走网络，失败不影响出图，只是名字用兜底的
  const member = pickMember(e, uid)
  if (typeof member?.getInfo === 'function') {
    try {
      from(await member.getInfo())
      return out
    } catch (err) {
      logger.debug(`${logPrefix} 取群成员 ${uid} 信息失败：${err.message}`)
    }
  }
  // pickMember 展开出来的壳本身常常已经带着缓存字段（OneBot 适配器就是这么拼的）
  if (member) from(member)
  return out
}
