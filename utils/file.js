import fs from 'node:fs'
import path from 'node:path'
import _ from 'lodash'
import { dataDir, logPrefix } from '../constants/path.js'

/**
 * 递归建目录。
 *
 * 用 `recursive: true` 而不是自己递归：目录已存在时它不抛，而
 * 「existsSync 判一下再 mkdirSync」在并发下会撞 EEXIST
 * （dataPath 每次调用都会走一遍，出图并发时是真会撞上的）。
 */
export function mkdirs (dirname) {
  try {
    fs.mkdirSync(dirname, { recursive: true })
    return true
  } catch (err) {
    logger.error(`${logPrefix} 创建目录失败 ${dirname}: ${err.message}`)
    return false
  }
}

/**
 * 文件名带上 pid 与随机数，避免同毫秒的并发请求互相覆盖
 * @param {string} ext 扩展名，不含点
 */
export function uniqueName (ext) {
  return `${Date.now()}_${process.pid}_${_.random(100000, 999999, false)}.${ext || 'gif'}`
}

/** 删文件，失败只记日志不抛 */
export function unlinkQuietly (loc) {
  try {
    if (loc && fs.existsSync(loc)) fs.unlinkSync(loc)
  } catch (err) {
    logger.error(`${logPrefix} 删除临时文件失败 ${loc}: ${err.message}`)
  }
}

/**
 * 清理超时的遗留文件。
 * 旧版本多图时只删最后一张，原图会不断堆积（曾积压 112 个 / 44MB）
 * @param {string} dir 目录
 * @param {number} maxAgeMs 超过多久算过期
 */
export function cleanupStale (dir, maxAgeMs = 3600 * 1000) {
  try {
    if (!fs.existsSync(dir)) return 0
    const deadline = Date.now() - maxAgeMs
    let n = 0
    for (const f of fs.readdirSync(dir)) {
      const p = path.join(dir, f)
      try {
        if (fs.statSync(p).mtimeMs < deadline) {
          fs.unlinkSync(p)
          n++
        }
      } catch {}
    }
    return n
  } catch (err) {
    logger.error(`${logPrefix} 清理 ${dir} 失败: ${err.message}`)
    return 0
  }
}

/**
 * 按容量给缓存目录设上限，超了就删最久没被读到的，一直删到 80%。
 *
 * preview_cache 全量约 166MB、thumb_cache 还要再加一份，
 * 而这两个目录原来只在 #meme更新 时才清，平时只增不减、也没有上限。
 * 留 80% 而不是刚好卡在线上，是免得每加一张图就触发一轮删除。
 * @returns {{deleted:number, freed:number}}
 */
export function trimCacheDir (dir, maxBytes) {
  try {
    if (!fs.existsSync(dir) || !(maxBytes > 0)) return { deleted: 0, freed: 0 }
    const files = []
    let total = 0
    for (const f of fs.readdirSync(dir)) {
      const p = path.join(dir, f)
      try {
        const st = fs.statSync(p)
        if (!st.isFile()) continue
        files.push({ p, size: st.size, at: Math.max(st.atimeMs, st.mtimeMs) })
        total += st.size
      } catch {}
    }
    if (total <= maxBytes) return { deleted: 0, freed: 0 }
    files.sort((a, b) => a.at - b.at)
    const target = maxBytes * 0.8
    let deleted = 0
    let freed = 0
    for (const f of files) {
      if (total - freed <= target) break
      try {
        fs.unlinkSync(f.p)
        deleted++
        freed += f.size
      } catch {}
    }
    return { deleted, freed }
  } catch (err) {
    logger.error(`${logPrefix} 裁剪缓存 ${dir} 失败: ${err.message}`)
    return { deleted: 0, freed: 0 }
  }
}

/** data/meme-plugin 下的子目录，自动创建 */
export function dataPath (...parts) {
  const p = path.join(dataDir, ...parts)
  mkdirs(path.dirname(p))
  return p
}

/** 确保目录存在并返回 */
export function ensureDir (...parts) {
  const p = path.join(dataDir, ...parts)
  mkdirs(p)
  return p
}
