import fs from 'node:fs'
import Config from '../../model/config.js'
import { verifySendTarget } from '../../utils/webLink.js'
import { dataPath, uniqueName, unlinkQuietly } from '../../utils/file.js'
import { readBody } from './make.js'
import { logPrefix } from '../../constants/path.js'

/**
 * 站内生成后直接发到群里 / 私发：POST /memes/send?g=&u=&e=&s=&to=group|user
 *
 * 目标不是页面填的，而是从机器人发的链接里带回来的签名（见 utils/webLink.js）。
 * 图片走原始二进制 body 而不是 base64：前端手上本来就是生成结果的 Blob，
 * 再包一层 base64 只会白白多传 1/3。
 *
 * 频率按「目标」限 —— 链接在群里谁都能点，同一个人连点几下就能把群刷屏；
 * 按 IP 限挡不住换网络的人，按目标限才是保护群的那一道。
 */

const WINDOW = 60000
const MAX_BYTES = 20 * 1024 * 1024

const EXT = {
  'image/gif': 'gif',
  'image/png': 'png',
  'image/jpeg': 'jpg',
  'image/webp': 'webp'
}

const hits = new Map()

function tooMany (key, limit) {
  const now = Date.now()
  const arr = (hits.get(key) || []).filter(t => now - t < WINDOW)
  if (arr.length >= limit) {
    hits.set(key, arr)
    return true
  }
  arr.push(now)
  hits.set(key, arr)
  // 键是群号/QQ 号，不清会一直长；顺手把过期的整条删掉
  if (hits.size > 500) {
    for (const [k, v] of hits) {
      if (!v.some(t => now - t < WINDOW)) hits.delete(k)
    }
  }
  return false
}

function fail (res, status, msg) {
  if (res.headersSent) return
  res.writeHead(status, { 'Content-Type': 'application/json; charset=utf-8' })
  res.end(JSON.stringify({ error: msg }))
}

export async function postSend (req, res, urlObj) {
  if (!Config.get('enableWebSend')) return fail(res, 403, '站内发送已关闭')

  const target = verifySendTarget(urlObj.searchParams)
  if (!target) {
    return fail(res, 403, '链接过期了：在群里再发一次 #meme列表 拿新链接')
  }

  const to = urlObj.searchParams.get('to') === 'user' ? 'user' : 'group'
  if (to === 'group' && !target.group) return fail(res, 400, '这个链接发不到群')
  if (to === 'user' && !target.user) return fail(res, 400, '这个链接不知道要发给谁')

  if (to === 'group' && (Config.get('disabledGroups') || []).map(String).includes(target.group)) {
    return fail(res, 403, '这个群已经关掉表情了')
  }

  const id = to === 'group' ? target.group : target.user
  const limit = Config.get('webSendLimit') || 6
  if (tooMany(`${to}:${id}`, limit)) {
    return fail(res, 429, `发得太快了，每分钟最多 ${limit} 张`)
  }

  const BotRef = globalThis.Bot
  const Seg = globalThis.segment
  if (!BotRef?.pickGroup || !Seg?.image) return fail(res, 503, '机器人还没连上，稍后再试')

  let buf
  try {
    buf = await readBody(req, MAX_BYTES)
  } catch (err) {
    return fail(res, err.status || 400, String(err.message || '图片没传上来'))
  }
  if (!buf?.length) return fail(res, 400, '图片是空的')

  const type = String(req.headers['content-type'] || '').split(';')[0].trim().toLowerCase()
  const ext = EXT[type]
  if (!ext) return fail(res, 415, '只收图片')

  // 和群里生成那条路一样落盘再发：segment.image 对 Buffer 的支持各适配器不一
  const loc = dataPath('result', uniqueName(ext))
  try {
    fs.writeFileSync(loc, buf)
    const img = Seg.image(`file://${loc}`)
    if (to === 'group') {
      const group = BotRef.pickGroup(target.group, true)
      if (!group) return fail(res, 404, '机器人已经不在这个群里了')
      await group.sendMsg(img)
    } else {
      const friend = BotRef.pickFriend(target.user, true)
      if (!friend) return fail(res, 404, '机器人发不到这个人，让他先在群里发一句')
      try {
        await friend.sendMsg(img)
      } catch (err) {
        // icqq 只能给好友发主动私聊。而框架的 pickFriend 对「不在好友表、但在某个群里」
        // 的人照样返回一个 Friend 对象（见 lib/bot.js），失败落在发送这一步 ——
        // 那种情况再报「稍后再试」只会让人一直重试
        const notFriend = BotRef.fl?.has && !BotRef.fl.has(Number(target.user))
        if (notFriend) return fail(res, 400, '私聊发不出去：对方不是机器人的好友')
        throw err
      }
    }
    res.writeHead(200, { 'Content-Type': 'application/json; charset=utf-8' })
    res.end(JSON.stringify({ ok: true }))
  } catch (err) {
    logger.error(`${logPrefix} 站内发送失败(${to}:${id}): ${err.stack || err.message}`)
    fail(res, 500, '没发出去，稍后再试')
  } finally {
    unlinkQuietly(loc)
  }
}
