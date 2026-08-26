import fs from 'node:fs'
import path from 'node:path'
import MemeApi from './memeApi.js'
import Config from './config.js'
import { dataDir, logPrefix } from '../constants/path.js'
import { mkdirs } from '../utils/file.js'

const CACHE_DIR = () => path.join(dataDir, 'preview_cache')
const THUMB_DIR = () => path.join(dataDir, 'thumb_cache')

let sharp = null
let sharpChecked = false

/** sharp 是主仓库自带的，但缺了也要能降级运行 */
async function getSharp () {
  if (sharpChecked) return sharp
  sharpChecked = true
  try {
    sharp = (await import('sharp')).default
  } catch (err) {
    logger.warn(`${logPrefix} sharp 不可用，缩略图功能关闭，将直接返回原图: ${err.message}`)
    sharp = null
  }
  return sharp
}

const EXTS = ['gif', 'png', 'jpeg', 'jpg', 'webp']

function findCached (dir, key) {
  for (const ext of EXTS) {
    const f = path.join(dir, `${key}.${ext}`)
    if (fs.existsSync(f)) {
      return { file: f, contentType: `image/${ext === 'jpg' ? 'jpeg' : ext}` }
    }
  }
  return null
}

/**
 * 先写临时文件再改名，而不是直接 writeFileSync 到目标路径。
 *
 * 缓存的判断是「文件存在就直接读」，而网页版列表一次并发拉几十张缩略图，
 * 同一个 key 完全可能一边在写、一边被另一个请求 readFileSync ——
 * 读到的是写了一半的图，浏览器显示成破图，更糟的是**这个截断文件会一直留着**，
 * 后面每次都命中它。同目录内的 rename 是原子的，读者只会看到完整文件。
 */
function writeAtomic (file, buffer) {
  const tmp = `${file}.${process.pid}_${Date.now()}.tmp`
  try {
    fs.writeFileSync(tmp, buffer)
    fs.renameSync(tmp, file)
  } catch (err) {
    try { fs.unlinkSync(tmp) } catch {}
    throw err
  }
}

/**
 * 同一个 key 的并发请求合并成一次。
 *
 * 不合并的话，网页版列表首次打开会对同一张图发出多个请求（浏览器重试、
 * 快速滚动触发的重复 IntersectionObserver 回调），每个都要走一趟服务端
 * preview + 一次 sharp 压缩，白烧几倍 CPU。
 */
const inflight = new Map()

function once (id, fn) {
  const running = inflight.get(id)
  if (running) return running
  const p = fn().finally(() => inflight.delete(id))
  inflight.set(id, p)
  return p
}

const Preview = {
  /**
   * 原图。服务端 preview 接口没有缓存（同一 key 连续请求耗时一致），所以落盘。
   */
  async getFull (key) {
    const useCache = Config.get('enablePreviewCache')
    const dir = CACHE_DIR()

    if (useCache) {
      const hit = findCached(dir, key)
      if (hit) return { buffer: fs.readFileSync(hit.file), contentType: hit.contentType }
    }

    return await once(`full:${key}`, async () => {
      const { buffer, contentType } = await MemeApi.getPreview(key)
      if (useCache) {
        try {
          mkdirs(dir)
          const ext = contentType.split('/')[1]?.split(';')[0] || 'png'
          writeAtomic(path.join(dir, `${key}.${ext}`), buffer)
        } catch (err) {
          logger.debug(`${logPrefix} 预览图缓存写入失败 ${key}: ${err.message}`)
        }
      }
      return { buffer, contentType }
    })
  },

  /**
   * 缩略图。原始预览图平均 281KB、最大 1.38MB，837 张合计约 230MB，
   * 手机上直接加载原图根本刷不动。这里压成小尺寸 webp，
   * 动图只取首帧（列表里不需要动起来，点开详情才看原图）。
   */
  async getThumb (key, width = 260) {
    const dir = THUMB_DIR()
    const cached = path.join(dir, `${key}_${width}.webp`)
    if (fs.existsSync(cached)) {
      return { buffer: fs.readFileSync(cached), contentType: 'image/webp' }
    }

    return await once(`thumb:${key}_${width}`, async () => {
      const s = await getSharp()
      const full = await this.getFull(key)
      if (!s) return full

      try {
        const buffer = await s(full.buffer, { animated: false })
          .resize({ width, height: width, fit: 'inside', withoutEnlargement: true })
          .webp({ quality: 72, effort: 4 })
          .toBuffer()
        try {
          mkdirs(dir)
          writeAtomic(cached, buffer)
        } catch (err) {
          logger.debug(`${logPrefix} 缩略图写入失败 ${key}: ${err.message}`)
        }
        return { buffer, contentType: 'image/webp' }
      } catch (err) {
        logger.debug(`${logPrefix} 缩略图生成失败 ${key}，回退原图: ${err.message}`)
        return full
      }
    })
  },

  /** 缓存统计，给部署状态用 */
  stats () {
    const count = dir => {
      try {
        return fs.existsSync(dir) ? fs.readdirSync(dir).length : 0
      } catch { return 0 }
    }
    const size = dir => {
      try {
        if (!fs.existsSync(dir)) return 0
        return fs.readdirSync(dir)
          .reduce((s, f) => s + (fs.statSync(path.join(dir, f)).size || 0), 0)
      } catch { return 0 }
    }
    return {
      full: count(CACHE_DIR()),
      fullSize: size(CACHE_DIR()),
      thumb: count(THUMB_DIR()),
      thumbSize: size(THUMB_DIR())
    }
  }
}

export default Preview
