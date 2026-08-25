import Config from './config.js'
import { logPrefix } from '../constants/path.js'

/** 带超时的 fetch */
async function request (path, options = {}) {
  const url = Config.getApiUrl() + path
  const timeout = Config.get('apiTimeout') || 30000
  const ctrl = new AbortController()
  const timer = setTimeout(() => ctrl.abort(), timeout)
  try {
    return await fetch(url, { ...options, signal: ctrl.signal })
  } finally {
    clearTimeout(timer)
  }
}

const MemeApi = {
  /** 服务是否可用 */
  async ping () {
    try {
      const r = await request('/memes/keys')
      return r.ok
    } catch {
      return false
    }
  },

  /** 当前注册的表情数；服务没起来或响应异常返回 -1 */
  async countKeys () {
    try {
      const r = await request('/memes/keys')
      if (!r.ok) return -1
      const list = await r.json()
      return Array.isArray(list) ? list.length : -1
    } catch {
      return -1
    }
  },

  /**
   * 轮询等服务真正就绪。
   *
   * 实测（v0.1.14）meme-generator 是**扫完 meme_dirs 才开始监听**的：
   * 重启后约 7 秒内连接直接被拒，一旦能响应就已经是完整的 944 个。
   * 所以只等 HTTP 200 目前并不会读到残缺列表。
   *
   * 但这里仍然多等一拍「数量没变」才放行 —— 万一哪天它改成边扫边服务，
   * 残缺列表会被 refreshFromApi 写盘覆盖掉好索引，用户侧表现是大量表情突然失效，
   * 那个代价比多等一秒高得多。
   */
  async waitReady (maxSeconds = 60, stableSeconds = 2) {
    let prev = -1
    let stable = 0
    for (let i = 0; i < maxSeconds; i++) {
      const n = await this.countKeys()
      if (n > 0 && n === prev) {
        if (++stable >= stableSeconds) return true
      } else {
        stable = 0
      }
      prev = n
      await new Promise(r => setTimeout(r, 1000))
    }
    // 超时但服务确实在响应：让调用方自己决定要不要继续
    return prev > 0
  },

  /** 全部表情 key */
  async getKeys () {
    const r = await request('/memes/keys')
    if (!r.ok) throw new Error(`获取表情列表失败: HTTP ${r.status}`)
    return r.json()
  },

  async getInfo (key) {
    const r = await request(`/memes/${key}/info`)
    if (!r.ok) throw new Error(`获取 ${key} 信息失败: HTTP ${r.status}`)
    return r.json()
  },

  /**
   * 拉取全部表情的 info。
   * 分批并发，837 个表情从约 9 秒压到 1 秒内。
   * 服务端没有 /memes/static/*.json（实测 404），只能逐个拉。
   */
  async fetchAll (batchSize = 20) {
    const keys = await this.getKeys()
    const keyMap = {}
    const infos = {}
    for (let i = 0; i < keys.length; i += batchSize) {
      const results = await Promise.all(keys.slice(i, i + batchSize).map(async key => {
        try {
          return [key, await this.getInfo(key)]
        } catch (err) {
          logger.error(`${logPrefix} 拉取 ${key} 的 info 失败: ${err.message}`)
          return null
        }
      }))
      for (const item of results) {
        if (!item) continue
        const [key, info] = item
        if (!info?.keywords) continue
        info.keywords.forEach(kw => { keyMap[kw] = key })
        infos[key] = info
      }
    }
    return { keyMap, infos }
  },

  /** 表情的官方预览图 */
  async getPreview (key) {
    const r = await request(`/memes/${key}/preview`)
    if (!r.ok) throw new Error(`获取 ${key} 预览图失败: HTTP ${r.status}`)
    return {
      buffer: Buffer.from(await r.arrayBuffer()),
      contentType: r.headers.get('Content-Type') || 'image/png'
    }
  },

  /**
   * 渲染表情列表图。
   * 服务端字号固定不随数量缩放，所以只能靠传子集来放大字。
   * @param {string[]} keys 要渲染的表情 key，不传则全部
   */
  async renderList (keys) {
    const body = keys
      ? JSON.stringify({ meme_list: keys.map(k => ({ meme_key: k, disabled: false, labels: [] })) })
      : undefined
    const r = await request('/memes/render_list', {
      method: 'POST',
      headers: body ? { 'Content-Type': 'application/json' } : undefined,
      body
    })
    if (!r.ok) throw new Error(`渲染列表失败: HTTP ${r.status}`)
    return {
      buffer: Buffer.from(await r.arrayBuffer()),
      contentType: r.headers.get('Content-Type') || 'image/png'
    }
  },

  /**
   * 生成表情
   * @returns {Promise<{ok: boolean, buffer?: Buffer, contentType?: string, error?: string}>}
   */
  async generate (key, formData) {
    const r = await request(`/memes/${key}/`, { method: 'POST', body: formData })
    if (!r.ok) {
      return { ok: false, error: await r.text() }
    }
    return {
      ok: true,
      buffer: Buffer.from(await r.arrayBuffer()),
      contentType: r.headers.get('Content-Type') || 'image/gif'
    }
  }
}

export default MemeApi
