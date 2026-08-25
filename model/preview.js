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

    const { buffer, contentType } = await MemeApi.getPreview(key)
    if (useCache) {
      try {
        mkdirs(dir)
        const ext = contentType.split('/')[1]?.split(';')[0] || 'png'
        fs.writeFileSync(path.join(dir, `${key}.${ext}`), buffer)
      } catch (err) {
        logger.debug(`${logPrefix} 预览图缓存写入失败 ${key}: ${err.message}`)
      }
    }
    return { buffer, contentType }
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
        fs.writeFileSync(cached, buffer)
      } catch (err) {
        logger.debug(`${logPrefix} 缩略图写入失败 ${key}: ${err.message}`)
      }
      return { buffer, contentType: 'image/webp' }
    } catch (err) {
      logger.debug(`${logPrefix} 缩略图生成失败 ${key}，回退原图: ${err.message}`)
      return full
    }
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
