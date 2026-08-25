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

  /** 轮询等服务就绪（重启后要重新扫描 meme_dirs，需要几秒） */
  async waitReady (maxSeconds = 30) {
    for (let i = 0; i < maxSeconds; i++) {
      if (await this.ping()) return true
      await new Promise(r => setTimeout(r, 1000))
    }
    return false
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
