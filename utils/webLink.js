import crypto from 'node:crypto'
import Config from '../model/config.js'

/**
 * 网页版「发到本群 / 私发给我」的目标签名。
 *
 * 站点是公开无鉴权的，如果页面能随便填群号发图，等于给所有人开了一个
 * 往机器人所在群刷图的通道。所以目标不让人填，而是**机器人把链接发到哪儿，
 * 链接里就带哪儿**：`?g=<群号>&u=<触发人>&e=<过期时间>&s=<签名>`，
 * 服务端发图前验一遍签名 —— 伪造群号、改过期时间都会验不过。
 *
 * 签名只证明「这个链接是机器人自己发出去的」，不绑定具体某个人：
 * 同一群里任何人拿到这条链接都能往本群发图（他本来也能直接发消息），
 * 别处的人拿不到这条链接。所以发图那条路由还有单独的频率限制兜着。
 */

/** 链接有效期（秒）。翻聊天记录点开旧链接照样能用，7 天足够 */
const TTL = 7 * 24 * 3600

function hmac (group, user, exp, secret) {
  return crypto.createHmac('sha256', secret)
    .update(`${group}|${user}|${exp}`)
    .digest('base64url')
    .slice(0, 32)
}

/**
 * 签名密钥。
 *
 * 首次用到时随机生成写进用户配置：它只用来证明链接是机器人发的，
 * 换掉只是让旧链接失效，不需要用户关心，也不该让所有部署共用同一个值。
 */
function secret () {
  const cur = String(Config.get('webSendSecret') || '').trim()
  if (cur) return cur
  const s = crypto.randomBytes(24).toString('hex')
  Config.set('webSendSecret', s)
  return s
}

/** 给网页链接拼上发送目标。关掉 enableWebSend 时原样返回 */
export function withSendTarget (url, e) {
  if (!Config.get('enableWebSend')) return url
  const group = e?.group_id ? String(e.group_id) : ''
  const user = e?.user_id ? String(e.user_id) : ''
  if (!group && !user) return url

  const exp = Math.floor(Date.now() / 1000) + TTL
  const q = new URLSearchParams()
  if (group) q.set('g', group)
  if (user) q.set('u', user)
  q.set('e', String(exp))
  q.set('s', hmac(group, user, exp, secret()))
  return `${url}?${q}`
}

/**
 * 校验网页带回来的目标。
 * 签名不对、过期、或者一个目标都没有，一律返回 null。
 */
export function verifySendTarget (query) {
  const group = String(query.get('g') || '')
  const user = String(query.get('u') || '')
  const exp = parseInt(query.get('e'), 10)
  const sig = String(query.get('s') || '')
  if (!group && !user) return null
  if (!sig || !(exp > 0) || exp * 1000 < Date.now()) return null

  const want = hmac(group, user, exp, secret())
  const a = Buffer.from(sig)
  const b = Buffer.from(want)
  if (a.length !== b.length || !crypto.timingSafeEqual(a, b)) return null
  return { group, user }
}
