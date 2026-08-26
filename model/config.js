import fs from 'node:fs'
import path from 'node:path'
import YAML from 'yaml'
import chokidar from 'chokidar'
import { pluginPath, logPrefix } from '../constants/path.js'

const defaultFile = path.join(pluginPath, 'config/system/config.yaml')
const userFile = path.join(pluginPath, 'config/config.yaml')

if (!fs.existsSync(userFile)) {
  fs.copyFileSync(defaultFile, userFile)
}

let cache = null

function readYaml (file) {
  try {
    return YAML.parse(fs.readFileSync(file, 'utf8')) || {}
  } catch (err) {
    logger.error(`${logPrefix} 读取配置失败 ${file}: ${err.message}`)
    return {}
  }
}

function writeYaml (file, data) {
  fs.writeFileSync(file, YAML.stringify(data), 'utf-8')
}

chokidar.watch(userFile).on('change', () => {
  cache = null
  logger.mark(`${logPrefix} 配置文件变更，已重载`)
})

/**
 * 只改用户配置里的一个键。
 *
 * 走 Document API 而不是「parse → 改对象 → stringify」：后者会把 yaml 里的
 * **注释全部抹掉**。默认配置带 68 行说明（每个字段是干什么的、单位是什么），
 * 复制给用户之后只要触发过一次写入（`#meme开关`、部署成功回写地址都会），
 * 用户手上那份就变成一堆没有任何解释的裸键值，想手改配置只能回去翻文档。
 */
function writeUserValue (key, value) {
  try {
    const doc = YAML.parseDocument(fs.readFileSync(userFile, 'utf8'))
    doc.set(key, value)
    fs.writeFileSync(userFile, String(doc), 'utf-8')
    return true
  } catch (err) {
    logger.error(`${logPrefix} 写配置失败（已回退成整体覆盖）${key}: ${err.message}`)
    return false
  }
}

/**
 * 默认值 + 用户值。
 *
 * 用户侧的 `null` 要跳过，不能直接 `{...def, ...user}` 覆盖过去：
 * yaml 里把一项写成 `webPort:`（后面空着）、或者面板上把输入框清空再保存，
 * 解析出来就是 `null`，浅展开会把默认值顶掉。调用方大多写了 `|| 默认值` 兜着，
 * 但 `replyWithQuote`、`serviceMode`、`memePm2Name` 这些没兜 ——
 * 表现是「配置里明明有这一项，行为却像没配」，很难查。
 *
 * 空串不算：`gitProxy: ''`、`reposDir: ''` 是「我就是要留空」的明确表达。
 */
function merge (def, user) {
  const out = { ...def }
  for (const [k, v] of Object.entries(user)) {
    if (v === null || v === undefined) continue
    out[k] = v
  }
  return out
}

const Config = {
  /** 默认值与用户值合并后的完整配置 */
  getAll () {
    if (!cache) cache = merge(readYaml(defaultFile), readYaml(userFile))
    return cache
  },

  get (key) {
    return this.getAll()[key]
  },

  set (key, value) {
    if (!writeUserValue(key, value)) {
      const user = readYaml(userFile)
      user[key] = value
      writeYaml(userFile, user)
    }
    cache = null
  },

  /** meme 服务地址，去掉尾部斜杠 */
  getApiUrl () {
    return String(this.get('memeApiUrl') || 'http://127.0.0.1:2233').replace(/\/+$/, '')
  },

  /** 群里发的 web 链接前缀 */
  getWebUrl () {
    const raw = String(this.get('webUrl') || '').trim().replace(/\/+$/, '')
    if (raw) {
      // 已经自带端口或是 https 就原样用
      if (/:\d+$/.test(raw) || raw.startsWith('https://')) return raw
      return `${raw}:${this.get('webPort')}`
    }
    return `http://localhost:${this.get('webPort')}`
  },

  /** 给 git 地址套上代理前缀 */
  proxyUrl (url) {
    const proxy = String(this.get('gitProxy') || '').trim()
    if (!proxy) return url
    return proxy.replace(/\/+$/, '') + '/' + url
  },

  /**
   * meme 服务是不是「本机这套、插件管得着的」。
   *
   * 这个判断决定 #meme更新 要不要拉仓库。表情资源（几个 G 的 git 仓库）、
   * config.toml 的 meme_dirs、pm2 重启，这三件事全都只对**跑在本机、由本插件管**
   * 的服务有效：填了别人的服务地址还去拉仓库，等于白下几个 G 到自己盘上，
   * 没有任何进程会去扫它，还要被 clone 失败的报错刷一脸。
   *
   * auto 只看 host 是不是回环地址 —— 局域网另一台机器上的服务同样管不着，算远端。
   * 本机 docker 里跑服务是 auto 判不出来的（host 也是 127.0.0.1，但仓库和
   * config.toml 在容器里面），这种要手动设 remote；反过来服务在别的机器上、
   * 但资源目录挂载到了本机，设 local。
   */
  isLocalService () {
    const mode = String(this.get('serviceMode') || 'auto').trim().toLowerCase()
    if (mode === 'local') return true
    if (mode === 'remote') return false
    let host
    try {
      host = new URL(this.getApiUrl()).hostname
    } catch {
      return false
    }
    // URL 会把 IPv6 的 host 带上方括号
    host = host.replace(/^\[|\]$/g, '').toLowerCase()
    return host === 'localhost' || host === '::1' || host === '0.0.0.0' ||
      /^127\./.test(host)
  }
}

export default Config
