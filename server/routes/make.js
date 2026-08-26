import { File, FormData } from 'node-fetch'
import Config from '../../model/config.js'
import MemeApi from '../../model/memeApi.js'
import MemeIndex from '../../model/memeIndex.js'
import { argSchemas, getEnum } from '../../utils/args.js'
import { qqAvatar } from '../../utils/user.js'
import { logPrefix } from '../../constants/path.js'

/**
 * 站内在线生成：POST /memes/make/:key
 *
 * 走 JSON + base64 而不是 multipart：Node 原生 http 不带表单解析，
 * 自己写 multipart 边界解析是纯粹的风险来源，而 base64 膨胀那 33%
 * 在单张 10MB 的量级上无所谓。
 *
 * 这个站是公开的、不带 token，所以三道闸都得有：
 * 单次请求体上限、每 IP 每分钟次数、同时进行的生成数。
 * 少了任何一道，一个人挂个脚本就能把 meme 服务的 CPU 吃满。
 */

const WINDOW = 60000
/** 同时进行的生成数上限：meme 服务是单进程 Python，堆并发只会一起变慢 */
const MAX_RUNNING = 2

const hits = new Map()
let running = 0

/** 取真实来源 IP，反代后面看 x-forwarded-for 的第一段 */
function clientIp (req) {
  const fwd = req.headers['x-forwarded-for']
  if (fwd) return String(fwd).split(',')[0].trim()
  return req.socket?.remoteAddress || 'unknown'
}

function tooMany (ip) {
  const limit = Config.get('webMakeLimit') || 10
  const now = Date.now()
  const arr = (hits.get(ip) || []).filter(t => now - t < WINDOW)
  if (arr.length >= limit) {
    hits.set(ip, arr)
    return true
  }
  arr.push(now)
  hits.set(ip, arr)
  // 这个 Map 的键是访客 IP，不清会一直长；顺手把过期的整条删掉
  if (hits.size > 500) {
    for (const [k, v] of hits) {
      if (!v.some(t => now - t < WINDOW)) hits.delete(k)
    }
  }
  return false
}

/** 边收边算大小，超了立刻停止累积 —— 不能等 Buffer.concat 之后才发现 */
function readBody (req, maxBytes) {
  return new Promise((resolve, reject) => {
    const chunks = []
    let len = 0
    let stopped = false
    req.on('data', c => {
      if (stopped) return
      len += c.length
      if (len > maxBytes) {
        stopped = true
        // 已收的先扔掉，别在等请求收尾的这段时间里还占着内存
        chunks.length = 0
        const err = new Error(`请求体超过 ${(maxBytes / 1048576).toFixed(0)}MB`)
        err.status = 413
        reject(err)
        // 剩下的数据继续收但直接丢：直接 destroy 的话响应发不出去，
        // 客户端只会看到连接被重置，不知道是自己传太大了
        req.resume()
        return
      }
      chunks.push(c)
    })
    req.on('end', () => {
      if (!stopped) resolve(Buffer.concat(chunks))
    })
    req.on('error', reject)
  })
}

/** 图片相关的错误一律算客户端问题，不能报成 500 */
function bad (msg) {
  const err = new Error(msg)
  err.status = 400
  return err
}

/**
 * 一个图片槽转成 buffer。前端只会传两种东西：
 * data URL（用户选的文件）或纯数字（QQ 号，取头像）
 */
async function slotToBuffer (raw, maxBytes) {
  const s = String(raw || '').trim()
  if (!s) return null

  if (/^\d{5,12}$/.test(s)) {
    const timeout = Config.get('imageTimeout') || 15000
    const r = await fetch(qqAvatar(s), {
      signal: AbortSignal.timeout(timeout)
    })
    if (!r.ok) throw bad(`取 QQ ${s} 的头像失败：HTTP ${r.status}`)
    const buf = Buffer.from(await r.arrayBuffer())
    if (buf.length >= maxBytes) throw bad('头像异常过大')
    return buf
  }

  const m = /^data:([\w/+.-]+);base64,([\s\S]+)$/.exec(s)
  if (!m) throw bad('图片格式不认识')
  if (!m[1].startsWith('image/')) throw bad('只收图片')
  const buf = Buffer.from(m[2], 'base64')
  if (!buf.length) throw bad('图片是空的')
  if (buf.length >= maxBytes) {
    throw bad(`图片 ${(buf.length / 1048576).toFixed(1)}MB，超过 ${(maxBytes / 1048576).toFixed(0)}MB 限制`)
  }
  return buf
}

/**
 * 拼 args。
 * 群里那套要把「左」「圆」这类中文推成枚举值，Web 端不用：
 * 下拉框给的本来就是 schema 里的原值，这里只做类型收敛和枚举白名单校验
 * —— 值必须落在 enum 里，不然等于把任意字符串直通服务端。
 */
function buildArgs (info, argsIn, nick) {
  const out = {}
  for (const [name, schema] of argSchemas(info)) {
    if (!(name in argsIn)) continue
    const enums = getEnum(schema)
    let v = argsIn[name]
    if (schema.type === 'integer') {
      v = parseInt(v)
      if (Number.isNaN(v)) continue
    } else if (schema.type === 'number') {
      v = Number(v)
      if (Number.isNaN(v)) continue
    } else if (schema.type === 'boolean') {
      v = v === true || v === 'true'
    } else {
      v = String(v)
    }
    if (enums && !enums.includes(v)) continue
    out[name] = v
  }
  // user_infos 服务端一律接受，Web 端没有真实用户，昵称让访客自己填
  out.user_infos = [{ name: String(nick || '').slice(0, 24), gender: 'unknown' }]
  return JSON.stringify(out)
}

function fail (res, status, msg) {
  res.writeHead(status, { 'Content-Type': 'application/json; charset=utf-8' })
  res.end(JSON.stringify({ error: msg }))
}

export async function postMake (req, res, urlObj) {
  if (!Config.get('enableWebMake')) return fail(res, 403, '站内生成已关闭')

  const key = decodeURIComponent(urlObj.pathname.split('/').pop() || '')
  const info = MemeIndex.infos[key]
  if (!info || MemeIndex.isBlocked(key)) return fail(res, 404, '没有这个表情')

  const ip = clientIp(req)
  if (tooMany(ip)) {
    return fail(res, 429, `手速太快了，每分钟最多 ${Config.get('webMakeLimit') || 10} 次`)
  }
  if (running >= MAX_RUNNING) return fail(res, 503, '正在给别人做表情，稍等一下再点')

  const maxBytes = (Config.get('maxFileSize') || 10) * 1024 * 1024
  const pt = info.params_type || {}

  running++
  try {
    // base64 后体积涨 1/3，再留点富余给文字和参数。
    // 但总量要封顶：max_images 有 9 的表情，按张数乘出去就是 126MB 一个请求，
    // 光是收下来就够把内存撑爆，何况还有并发
    const bodyLimit = Math.min(
      Math.ceil(maxBytes * 1.4) * Math.max(1, pt.max_images || 1),
      50 * 1024 * 1024
    )
    const body = await readBody(req, bodyLimit)
    let payload
    try {
      payload = JSON.parse(body.toString('utf8'))
    } catch {
      return fail(res, 400, '请求格式不对')
    }

    const rawImages = Array.isArray(payload.images) ? payload.images.slice(0, pt.max_images || 0) : []
    const texts = (Array.isArray(payload.texts) ? payload.texts : [])
      .slice(0, pt.max_texts || 0)
      .map(t => String(t ?? '').slice(0, 200))

    if (texts.length < (pt.min_texts || 0)) {
      return fail(res, 400, `至少要填 ${pt.min_texts} 段文字`)
    }

    const buffers = []
    for (const item of rawImages) {
      const buf = await slotToBuffer(item, maxBytes)
      if (buf) buffers.push(buf)
    }
    if (buffers.length < (pt.min_images || 0)) {
      return fail(res, 400, `至少要 ${pt.min_images} 张图`)
    }

    const formData = new FormData()
    buffers.forEach((buf, i) => {
      formData.append('images', new File([buf], `web_${i}.jpg`, { type: 'image/jpeg' }))
    })
    texts.forEach(t => formData.append('texts', t))
    const argsStr = buildArgs(info, payload.args && typeof payload.args === 'object' ? payload.args : {}, payload.nick)
    if (argsStr) formData.set('args', argsStr)

    const result = await MemeApi.generate(key, formData)
    if (!result.ok) {
      logger.debug(`${logPrefix} 站内生成 ${key} 被服务端拒绝: ${result.error}`)
      return fail(res, 400, String(result.error || '生成失败').slice(0, 200))
    }

    res.writeHead(200, {
      'Content-Type': result.contentType,
      'Content-Length': result.buffer.length,
      'Cache-Control': 'no-store'
    })
    res.end(result.buffer)
  } catch (err) {
    if (res.headersSent) return
    logger.debug(`${logPrefix} 站内生成 ${key} 失败: ${err.message}`)
    fail(res, err.status || 500, err.message || '生成失败')
  } finally {
    running--
  }
}
