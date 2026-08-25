import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import Config from './model/config.js'
import MemeIndex from './model/memeIndex.js'
import MemeApi from './model/memeApi.js'
import { startWebServer } from './server/index.js'
import { logPrefix, dataDir } from './constants/path.js'
import { mkdirs } from './utils/file.js'
import { runCleanup, startCleanupTimer } from './utils/cleanup.js'

const __dirname = path.dirname(fileURLToPath(import.meta.url))

mkdirs(dataDir)

// ── 载入索引 ──
// 先读磁盘缓存，让插件立刻可用；缓存为空再去服务端拉
const count = MemeIndex.loadFromDisk()
if (count > 0) {
  logger.info(`${logPrefix} 已载入 ${MemeIndex.memeCount} 个表情 / ${count} 个关键词`)
} else {
  logger.mark(`${logPrefix} 本地无缓存，尝试从 ${Config.getApiUrl()} 拉取…`)
  MemeApi.ping().then(async alive => {
    if (!alive) {
      logger.warn(`${logPrefix} 连不上 meme 服务（${Config.getApiUrl()}）`)
      logger.warn(`${logPrefix} 已有服务：改配置 memeApiUrl；没有服务：发 #meme部署 一键装（可选）`)
      return
    }
    try {
      const r = await MemeIndex.refreshFromApi()
      logger.info(`${logPrefix} 已拉取 ${r.count} 个表情 / ${r.keywordCount} 个关键词`)
    } catch (err) {
      logger.error(`${logPrefix} 拉取表情数据失败: ${err.message}`)
    }
  })
}

// 清掉上次运行残留的临时文件，并挂上定时维护
// （preview_cache / thumb_cache 原来只在 #meme更新 时才清，平时只增不减）
const cleaned = runCleanup()
if (cleaned.stale + cleaned.deleted > 0) {
  logger.mark(
    `${logPrefix} 清理了 ${cleaned.stale} 个遗留临时文件` +
    (cleaned.deleted ? `，淘汰 ${cleaned.deleted} 张超额预览图（${(cleaned.freed / 1048576).toFixed(1)}MB）` : '')
  )
}
startCleanupTimer(6)

// ── 加载 apps ──
const appsDir = path.join(__dirname, 'apps')
const files = fs.readdirSync(appsDir).filter(f => f.endsWith('.js'))
const settled = await Promise.allSettled(files.map(f => import(`./apps/${f}`)))

const apps = {}
for (let i = 0; i < files.length; i++) {
  const name = files[i].replace('.js', '')
  if (settled[i].status !== 'fulfilled') {
    logger.error(`${logPrefix} 载入 apps/${name} 失败`)
    logger.error(settled[i].reason)
    continue
  }
  const mod = settled[i].value
  const key = Object.keys(mod)[0]
  if (key) apps[name] = mod[key]
}

// ── Web 预览站 ──
if (Config.get('enableWeb')) {
  startWebServer()
}

logger.info(`${logPrefix} 插件载入完毕`)

export { apps }
