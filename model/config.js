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

const Config = {
  /** 默认值与用户值合并后的完整配置 */
  getAll () {
    if (!cache) cache = { ...readYaml(defaultFile), ...readYaml(userFile) }
    return cache
  },

  get (key) {
    return this.getAll()[key]
  },

  set (key, value) {
    const user = readYaml(userFile)
    user[key] = value
    writeYaml(userFile, user)
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
  }
}

export default Config
