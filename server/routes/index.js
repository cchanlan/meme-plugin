import fs from 'node:fs'
import path from 'node:path'
import crypto from 'node:crypto'
import Config from '../../model/config.js'
import MemeIndex from '../../model/memeIndex.js'
import Preview from '../../model/preview.js'
import { pluginResources, logPrefix } from '../../constants/path.js'
import { postMake } from './make.js'
import { postSend } from './send.js'

const WEB_DIR = path.join(pluginResources, 'web')

const FAVICON = "<svg xmlns='http://www.w3.org/2000/svg' viewBox='0 0 100 100'><text y='.9em' font-size='90'>🌸</text></svg>"

const MIME = {
  '.html': 'text/html; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.js': 'application/javascript; charset=utf-8'
}

/**
 * css/js 的内容指纹。
 *
 * HTML 里的 `/memes/index.js` 是不带版本号的固定 URL，前端改了之后浏览器
 * 照样吃旧缓存（`max-age` 生效期内根本不回源），用户看到的是旧界面 ——
 * 「明明加好按钮了，打开却没有」就是这么来的。给引用的 URL 挂上内容指纹，
 * 前端一改 URL 就变，浏览器只能重新下。
 */
let assetCache = { key: '', ver: '' }
function assetVersion () {
  const key = ['index.js', 'index.css'].map(name => {
    try {
      const st = fs.statSync(path.join(WEB_DIR, name))
      return `${st.size}:${st.mtimeMs}`
    } catch {
      return '0'
    }
  }).join('|')
  if (assetCache.key !== key) {
    assetCache = { key, ver: crypto.createHash('md5').update(key).digest('hex').slice(0, 10) }
  }
  return assetCache.ver
}

/** 首页 */
async function getIndexPage (req, res) {
  const file = path.join(WEB_DIR, 'index.html')
  if (!fs.existsSync(file)) {
    // 第二个参数传字符串会被 Node 当成 statusMessage，Content-Type 根本没设上，
    // 浏览器只好去猜编码 —— 这里的中文会显示成乱码
    res.writeHead(500, { 'Content-Type': MIME['.html'] })
    res.end('<h1>页面模板缺失</h1>')
    return
  }
  const html = fs.readFileSync(file, 'utf8')
    .replace(/(\/memes\/index\.(?:css|js))"/g, `$1?v=${assetVersion()}"`)
  // HTML 必须回源验证，否则改完前端要等缓存过期才生效（它才是引着带指纹资源的那张纸）
  res.writeHead(200, { 'Content-Type': MIME['.html'], 'Cache-Control': 'no-cache' })
  res.end(html)
}

/** 静态资源（css/js） */
async function getStatic (req, res, urlObj) {
  const name = path.basename(urlObj.pathname)
  const file = path.join(WEB_DIR, name)
  // 只允许读 web 目录下的文件
  if (!file.startsWith(WEB_DIR) || !fs.existsSync(file)) {
    res.writeHead(404)
    res.end('Not Found')
    return
  }
  const body = fs.readFileSync(file)
  const etag = `W/"${crypto.createHash('md5').update(body).digest('hex').slice(0, 16)}"`
  // 带 `?v=` 指纹的 URL 内容永不变（改了前端指纹就变），可以放心长缓存；
  // 不带指纹的（老 HTML 里的裸 URL）每次都回源验证，靠 ETag 拿 304
  const versioned = urlObj.searchParams.has('v')
  const cache = versioned ? 'public, max-age=31536000, immutable' : 'no-cache'
  if (!versioned && req.headers['if-none-match'] === etag) {
    res.writeHead(304, { ETag: etag, 'Cache-Control': cache })
    res.end()
    return
  }
  res.writeHead(200, {
    'Content-Type': MIME[path.extname(name)] || 'application/octet-stream',
    ETag: etag,
    'Cache-Control': cache
  })
  res.end(body)
}

/**
 * 表情元数据。
 *
 * 原来挂 `max-age=300` 的固定缓存：`#meme更新` 之后 5 分钟内打开站，
 * 浏览器直接吃本地副本，新表情看不见 —— 「更新完了站上还是旧的」就是这么来的。
 * 改成按内容算 ETag + `no-cache`：每次都问一次服务器，
 * 内容没变就回 304（几十字节），变了才传那 170KB。既不会看到旧数据，也不白传。
 */
async function getData (req, res) {
  const body = JSON.stringify({
    total: MemeIndex.memeCount,
    keywords: MemeIndex.keywordCount,
    // 前端要据此决定显不显示「在线生成」那一块
    canMake: !!Config.get('enableWebMake'),
    maxFileSize: Config.get('maxFileSize') || 10,
    tags: MemeIndex.getTags(),
    memes: MemeIndex.toWebData()
  })
  const etag = `W/"${crypto.createHash('md5').update(body).digest('hex').slice(0, 16)}"`

  if (req.headers['if-none-match'] === etag) {
    res.writeHead(304, { ETag: etag, 'Cache-Control': 'no-cache' })
    res.end()
    return
  }
  res.writeHead(200, {
    'Content-Type': 'application/json; charset=utf-8',
    ETag: etag,
    // no-cache ≠ 不缓存：允许存，但每次用前必须回源验证（靠上面的 ETag 拿 304）
    'Cache-Control': 'no-cache'
  })
  res.end(body)
}

/**
 * 从 /memes/thumb/xxx、/memes/preview/xxx 里取表情 key。
 *
 * 拉黑的表情要一起挡掉：黑名单的语义是「屏蔽整个表情」，data.json 里
 * （toWebData）和站内生成（postMake）都过滤了，图片这两条路原来只判了
 * `infos[key]` 存不存在 —— 知道 code 的人直接敲 URL 照样能看到预览图，
 * 拿它挡 NSFW 仓库就等于没挡。
 *
 * decodeURIComponent 要包起来：`/memes/thumb/%ZZ` 这种非法转义会抛 URIError，
 * 冒到外层就是一条 500 加一条 error 日志，随手敲个坏 URL 就能刷日志。
 */
function keyFromPath (urlObj) {
  let key
  try {
    key = decodeURIComponent(urlObj.pathname.split('/').pop() || '')
  } catch {
    return ''
  }
  if (!key || !MemeIndex.infos[key] || MemeIndex.isBlocked(key)) return ''
  return key
}

/**
 * 缩略图（列表用）。原始预览图平均 281KB、最大 1.38MB，
 * 837 张合计约 230MB，手机加载原图会卡死，所以列表统一走压缩后的 webp。
 */
async function getThumb (req, res, urlObj) {
  const key = keyFromPath(urlObj)
  if (!key) {
    res.writeHead(404)
    res.end('Not Found')
    return
  }
  const w = Math.min(Math.max(parseInt(urlObj.searchParams.get('w')) || 260, 80), 600)
  try {
    const { buffer, contentType } = await Preview.getThumb(key, w)
    res.writeHead(200, { 'Content-Type': contentType, 'Cache-Control': 'public, max-age=604800' })
    res.end(buffer)
  } catch (err) {
    logger.debug(`${logPrefix} 缩略图失败 ${key}: ${err.message}`)
    res.writeHead(502)
    res.end('Preview unavailable')
  }
}

/** 原图（详情弹层用） */
async function getPreview (req, res, urlObj) {
  const key = keyFromPath(urlObj)
  if (!key) {
    res.writeHead(404)
    res.end('Not Found')
    return
  }
  try {
    const { buffer, contentType } = await Preview.getFull(key)
    res.writeHead(200, { 'Content-Type': contentType, 'Cache-Control': 'public, max-age=86400' })
    res.end(buffer)
  } catch (err) {
    logger.debug(`${logPrefix} 获取预览图失败 ${key}: ${err.message}`)
    res.writeHead(502)
    res.end('Preview unavailable')
  }
}

function getFavicon (req, res) {
  res.writeHead(200, {
    'Content-Type': 'image/svg+xml; charset=utf-8',
    'Cache-Control': 'public, max-age=86400'
  })
  res.end(FAVICON)
}

const table = {
  'GET /': getIndexPage,
  'GET /memes': getIndexPage,
  'GET /memes/': getIndexPage,
  'GET /memes/data.json': getData,
  'GET /favicon.ico': getFavicon
}

export function getRoute (pathname, method) {
  const exact = table[`${method} ${pathname}`]
  if (exact) return exact
  if (method === 'POST' && pathname.startsWith('/memes/make/')) return postMake
  if (method === 'POST' && pathname === '/memes/send') return postSend
  if (method === 'GET' && pathname.startsWith('/memes/thumb/')) return getThumb
  if (method === 'GET' && pathname.startsWith('/memes/preview/')) return getPreview
  if (method === 'GET' && /^\/memes\/[\w.-]+\.(css|js)$/.test(pathname)) return getStatic
  return null
}
