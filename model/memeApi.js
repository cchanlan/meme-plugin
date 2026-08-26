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

/**
 * 服务端拒绝生成时，把 JSON 报错翻成能发到群里的话。
 *
 * 原来是 `error: await r.text()`，用户看到的是整坨响应体：
 *   {"detail":"图片加载失败（cannot identify image file <_io.BytesIO object at 0x7fa860…>）"}
 * 参数类型不对时更长 —— pydantic 会连校验器名字和文档链接一起吐出来：
 *   {"detail":"参数模型验证失败（1 validation error for Model\ncircle\n  Input should be
 *    a valid boolean … https://errors.pydantic.dev/2.12/v/bool_parsing）"}
 * 群里刷这么一段，主人既看不出是自己参数写错了，还以为插件崩了。
 *
 * detail 里「图片数量不符」「文本数量不符」这类本来就是中文人话，保留原文；
 * 只把带 Python 内部细节的两类收拾干净。
 */
function apiError (status, text) {
  let detail = ''
  try {
    const j = JSON.parse(text)
    // 422 的 detail 是 [{loc, msg, type}]，其余是字符串
    detail = Array.isArray(j?.detail)
      ? j.detail.map(d => d?.msg || '').filter(Boolean).join('；')
      : String(j?.detail ?? j?.message ?? '')
  } catch {
    detail = String(text || '')
  }
  detail = detail.trim()
  if (!detail) return `服务端拒绝了这次生成（HTTP ${status}）`

  // 服务端说没这个表情：本地索引比服务端旧了（对方更新时删掉/改名了这个表情），
  // 而列表和 Web 站照旧显示着它，用户只会看到一句英文 Not Found 摸不着头脑
  if (status === 404 || /^not found$/i.test(detail)) {
    return '服务端没有这个表情，本地索引可能过期了 —— 发 #meme刷新 同步一下'
  }
  if (/cannot identify image file|图片加载失败/.test(detail)) {
    return '有张图片读不出来 😵 可能不是图片、下载不完整或者格式太偏门，换一张再试'
  }
  if (/validation error|参数模型验证失败/.test(detail)) {
    // pydantic 的第一行是「N validation error for Model」，字段名在第二行
    const field = detail.split('\n').map(s => s.trim()).find(s => /^\w+$/.test(s))
    return `参数不对${field ? `（${field}）` : ''}，发「表情名详情」看这个表情支持哪些参数`
  }
  // 兜底：去掉 Python 对象地址这类噪音，再截断 —— 群消息不该甩一屏 traceback
  const clean = detail.replace(/<[\w.]+ object at 0x[0-9a-f]+>/gi, '（内部对象）').replace(/\s*\n\s*/g, ' ')
  return clean.length > 160 ? `${clean.slice(0, 160)}…` : clean
}

/**
 * 带超时的请求。
 *
 * body 也必须在同一个超时窗口里读完，所以由这里统一读掉，不把 Response 交出去：
 * 原来 `clearTimeout` 一到手就执行，只管住了「响应头多久到」——
 * 服务端把头发回来、body 传一半卡住（跨公网连远端服务、服务正在被 kill
 * 都会这样）就再也没人管了。生成表情那条路上没有第二道超时，
 * 会一路挂到长任务锁 20 分钟过期为止，期间 `#meme更新` 之类全被挡着。
 * AbortController 的 signal 对 undici 的 body 流同样生效，所以不清定时器就够了。
 *
 * @param {string} path
 * @param {{read?: 'none'|'json'|'buffer', method?: string, body?: any}} options
 *        read 只在 res.ok 时生效；失败时一律读成文本放进 errText
 * @returns {Promise<{res: Response, data?: any, errText: string}>}
 */
async function request (path, { read = 'none', ...options } = {}) {
  const url = Config.getApiUrl() + path
  const timeout = Config.get('apiTimeout') || 30000
  const ctrl = new AbortController()
  const timer = setTimeout(() => ctrl.abort(), timeout)
  try {
    const res = await fetch(url, { ...options, signal: ctrl.signal })
    if (!res.ok) {
      // 报错响应一律读掉：留着不读会把这条连接一直占着不还给连接池
      return { res, errText: await res.text().catch(() => '') }
    }
    let data
    if (read === 'json') data = await res.json()
    else if (read === 'buffer') data = Buffer.from(await res.arrayBuffer())
    else await res.body?.cancel().catch(() => {})
    return { res, data, errText: '' }
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
      const { res } = await request('/memes/keys')
      return res.ok
    } catch {
      return false
    }
  },

  /** 当前注册的表情数；服务没起来或响应异常返回 -1 */
  async countKeys () {
    try {
      const { res, data } = await request('/memes/keys', { read: 'json' })
      if (!res.ok) return -1
      return Array.isArray(data) ? data.length : -1
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
    const { res, data } = await request('/memes/keys', { read: 'json' })
    if (!res.ok) {
      // 404 基本都是地址填错：这个路径 meme-generator 一定有，
      // 反代到了别的站（最常见是填成本插件自己的 Web 预览站）才会 404
      const hint = res.status === 404
        ? `\n（${Config.getApiUrl()} 上没有 /memes/keys，这地址多半不是 meme-generator 服务本体，别填成 Web 预览站的地址）`
        : ''
      throw new Error(`获取表情列表失败: HTTP ${res.status}${hint}`)
    }
    return data
  },

  async getInfo (key) {
    const { res, data } = await request(`/memes/${encodeURIComponent(key)}/info`, { read: 'json' })
    if (!res.ok) throw new Error(`获取 ${key} 信息失败: HTTP ${res.status}`)
    return data
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
    const { res, data } = await request(`/memes/${encodeURIComponent(key)}/preview`, { read: 'buffer' })
    if (!res.ok) throw new Error(`获取 ${key} 预览图失败: HTTP ${res.status}`)
    return {
      buffer: data,
      contentType: res.headers.get('Content-Type') || 'image/png'
    }
  },

  /**
   * 生成表情
   * @returns {Promise<{ok: boolean, buffer?: Buffer, contentType?: string, error?: string}>}
   */
  async generate (key, formData) {
    const { res, data, errText } = await request(`/memes/${encodeURIComponent(key)}/`, {
      method: 'POST',
      body: formData,
      read: 'buffer'
    })
    if (!res.ok) {
      // 原文只进日志：排查时要看得到 pydantic 说了什么，但别发到群里
      logger.debug(`${logPrefix} 生成 ${key} 被服务端拒绝 HTTP ${res.status}: ${errText.slice(0, 500)}`)
      return { ok: false, error: apiError(res.status, errText) }
    }
    return {
      ok: true,
      buffer: data,
      contentType: res.headers.get('Content-Type') || 'image/gif'
    }
  }
}

export default MemeApi
