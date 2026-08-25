import fs from 'node:fs'
import path from 'node:path'
import MemeIndex from '../../model/memeIndex.js'
import Preview from '../../model/preview.js'
import { pluginResources, logPrefix } from '../../constants/path.js'

const WEB_DIR = path.join(pluginResources, 'web')

const FAVICON = "<svg xmlns='http://www.w3.org/2000/svg' viewBox='0 0 100 100'><text y='.9em' font-size='90'>🌸</text></svg>"

const MIME = {
  '.html': 'text/html; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.js': 'application/javascript; charset=utf-8'
}

/** 首页 */
async function getIndexPage (req, res) {
  const file = path.join(WEB_DIR, 'index.html')
  if (!fs.existsSync(file)) {
    res.writeHead(500, MIME['.html'])
    res.end('<h1>页面模板缺失</h1>')
    return
  }
  res.writeHead(200, { 'Content-Type': MIME['.html'] })
  res.end(fs.readFileSync(file, 'utf8'))
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
  res.writeHead(200, {
    'Content-Type': MIME[path.extname(name)] || 'application/octet-stream',
    'Cache-Control': 'public, max-age=3600'
  })
  res.end(fs.readFileSync(file))
}

/** 表情元数据 */
async function getData (req, res) {
  res.writeHead(200, {
    'Content-Type': 'application/json; charset=utf-8',
    'Cache-Control': 'public, max-age=300'
  })
  res.end(JSON.stringify({
    total: MemeIndex.memeCount,
    keywords: MemeIndex.keywordCount,
    tags: MemeIndex.getTags(),
    memes: MemeIndex.toWebData()
  }))
}

/**
 * 缩略图（列表用）。原始预览图平均 281KB、最大 1.38MB，
 * 837 张合计约 230MB，手机加载原图会卡死，所以列表统一走压缩后的 webp。
 */
async function getThumb (req, res, urlObj) {
  const key = decodeURIComponent(urlObj.pathname.split('/').pop() || '')
  if (!key || !MemeIndex.infos[key]) {
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
  const key = decodeURIComponent(urlObj.pathname.split('/').pop() || '')
  if (!key || !MemeIndex.infos[key]) {
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
  if (method === 'GET' && pathname.startsWith('/memes/thumb/')) return getThumb
  if (method === 'GET' && pathname.startsWith('/memes/preview/')) return getPreview
  if (method === 'GET' && /^\/memes\/[\w.-]+\.(css|js)$/.test(pathname)) return getStatic
  return null
}
