import fs from 'node:fs'
import path from 'node:path'
import _ from 'lodash'
import { dataDir, logPrefix } from '../constants/path.js'

/** 递归建目录 */
export function mkdirs (dirname) {
  if (fs.existsSync(dirname)) return true
  if (mkdirs(path.dirname(dirname))) {
    fs.mkdirSync(dirname)
    return true
  }
  return false
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
