import path from 'node:path'
import Config from '../model/config.js'
import { dataDir, logPrefix } from '../constants/path.js'
import { cleanupStale, trimCacheDir } from './file.js'

/**
 * 一轮缓存维护。四类文件寿命完全不同，所以规则也不一样：
 * - original / result 是单次生成的中间产物，正常路径里当场就删，这里只兜漏
 *   （进程被 kill、或下载完在生成阶段崩了留下的）
 * - list_cache 的分页图会被翻页反复命中，留一天
 * - preview_cache / thumb_cache 是「越攒越值钱」的，不按时间清，只卡总容量
 * @returns {{stale:number, deleted:number, freed:number}}
 */
export function runCleanup () {
  const stale =
    cleanupStale(path.join(dataDir, 'original')) +
    cleanupStale(path.join(dataDir, 'result')) +
    cleanupStale(path.join(dataDir, 'list_cache'), 24 * 3600 * 1000)

  const maxBytes = (Config.get('maxCacheMB') || 0) * 1024 * 1024
  let deleted = 0
  let freed = 0
  for (const sub of ['preview_cache', 'thumb_cache']) {
    const r = trimCacheDir(path.join(dataDir, sub), maxBytes)
    deleted += r.deleted
    freed += r.freed
  }
  return { stale, deleted, freed }
}

/**
 * 挂上定时维护。
 *
 * 句柄存 global 并先清掉旧的：apps 热更会把 index.js 重新跑一遍，
 * 不清就会叠出好几个定时器一起删文件。
 */
export function startCleanupTimer (hours = 6) {
  if (global.memePluginCleanupTimer) clearInterval(global.memePluginCleanupTimer)
  global.memePluginCleanupTimer = setInterval(() => {
    const r = runCleanup()
    if (r.stale + r.deleted > 0) {
      logger.mark(
        `${logPrefix} 缓存维护：清理 ${r.stale} 个临时文件` +
        (r.deleted ? `，淘汰 ${r.deleted} 张预览图（腾出 ${(r.freed / 1048576).toFixed(1)}MB）` : '')
      )
    }
  }, hours * 3600 * 1000)
}
