import Config from './config.js'
import { logPrefix } from '../constants/path.js'

/**
 * 连不上时把 undici 那句 `fetch failed` 翻译成人话。
 *
 * 原样抛出去的话，用户看到的就是「表情生成失败: fetch failed」—— 既不知道是哪个
 * 地址连不上，也不知道该去看服务还是改配置。卸载掉本机服务之后每次生成都是这句，
 * 而列表和 Web 站靠本地索引照旧显示 944 个表情，很容易以为是插件坏了。
 */
function netError (err) {
  const timeout = Config.get('apiTimeout') || 30000
  if (err?.name === 'AbortError') {
    return new Error(`meme 服务 ${Config.getApiUrl()} 超过 ${timeout}ms 没响应，可能正在扫描表情目录，等十几秒再试`)
  }
  const code = err?.cause?.code || err?.code || ''
  if (/^(ECONNREFUSED|ENOTFOUND|EHOSTUNREACH|ECONNRESET|EAI_AGAIN|ETIMEDOUT|UND_ERR)/.test(code) ||
    /fetch failed/i.test(err?.message || '')) {
    return new Error(
      `连不上 meme 服务 ${Config.getApiUrl()}${code ? `（${code}）` : ''}\n` +
      '服务没在跑，或者配置 memeApiUrl 填的地址不对。发 #meme部署状态 看一眼；' +
      '本机没有服务的话发 #meme部署 装一套，或把 memeApiUrl 指向现成的服务'
    )
  }
  return err
}

/** 带超时的 fetch */
async function request (path, options = {}) {
  const url = Config.getApiUrl() + path
  const timeout = Config.get('apiTimeout') || 30000
  const ctrl = new AbortController()
  const timer = setTimeout(() => ctrl.abort(), timeout)
  try {
    return await fetch(url, { ...options, signal: ctrl.signal })
  } catch (err) {
    throw netError(err)
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
    if (!r.ok) {
      // 404 基本都是地址填错：这个路径 meme-generator 一定有，
      // 反代到了别的站（最常见是填成本插件自己的 Web 预览站）才会 404
      const hint = r.status === 404
        ? `\n（${Config.getApiUrl()} 上没有 /memes/keys，这地址多半不是 meme-generator 服务本体，别填成 Web 预览站的地址）`
        : ''
      throw new Error(`获取表情列表失败: HTTP ${r.status}${hint}`)
    }
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
   *
   * 单个失败只记日志不中断（跨公网连服务时个别超时很正常），但要把
   * 失败的 key 报给调用方 —— 不然表情数悄悄少一截，用户只会以为服务缺表情。
   */
  async fetchAll (batchSize = 20) {
    const keys = await this.getKeys()
    const keyMap = {}
    const infos = {}
    const failed = []
    for (let i = 0; i < keys.length; i += batchSize) {
      const results = await Promise.all(keys.slice(i, i + batchSize).map(async key => {
        try {
          return [key, await this.getInfo(key)]
        } catch (err) {
          logger.error(`${logPrefix} 拉取 ${key} 的 info 失败: ${err.message}`)
          return [key, null]
        }
      }))
      for (const item of results) {
        if (!item) continue
        const [key, info] = item
        if (!info?.keywords) {
          failed.push(key)
          continue
        }
        info.keywords.forEach(kw => { keyMap[kw] = key })
        infos[key] = info
      }
    }
    return { keyMap, infos, failed }
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
