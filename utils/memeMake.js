import fs from 'node:fs'
import { File, FormData } from 'node-fetch'
import Config from '../model/config.js'
import MemeApi from '../model/memeApi.js'
import MemeIndex from '../model/memeIndex.js'
import { handleArgs } from './args.js'
import { fetchImage } from './download.js'
import { dataPath, ensureDir, uniqueName, unlinkQuietly } from './file.js'
import { getAvatarUrl, getSelfAvatarUrl } from './user.js'
import { logPrefix } from '../constants/path.js'

/**
 * 「插件替用户挑表情」这类玩法的公共零件。
 *
 * 原来这几个函数是 apps/fun.js 的本地函数，猜表情（apps/guess.js）也要用同一套，
 * 而 apps 下的文件互相 import 不了 —— index.js 只取每个模块的第一个导出，
 * 一个文件只能有一个 plugin 类。所以搬到 utils 里给两边共用，顺带也好脱机测。
 */

/** 一个表情的第一个中文名，用于文案 */
export const nameOf = code => MemeIndex.infos[code]?.keywords?.[0] || code

/** 某人的头像 buffer，拿不到返回 null（不抛，调用方要能报人话） */
export async function avatarBuffer (e, uid) {
  const url = String(uid) === String(e.sender?.user_id)
    ? await getSelfAvatarUrl(e)
    : await getAvatarUrl(e, uid)
  if (!url) return null
  const maxBytes = (Config.get('maxFileSize') || 10) * 1024 * 1024
  try {
    const { buffer } = await fetchImage(url, maxBytes, Config.get('imageTimeout') || 15000)
    return buffer
  } catch (err) {
    logger.error(`${logPrefix} 下载 ${uid} 的头像失败: ${err.message}`)
    return null
  }
}

/** 用现成的图片 buffer 生成一个表情 */
export async function makeOne (code, buffers, userInfos) {
  const fd = new FormData()
  // 顺序有语义（双人表情里谁在上谁在下），按数组下标原样 append
  buffers.forEach((b, i) => fd.append('images', new File([b], `avatar_${i}.jpg`, { type: 'image/jpeg' })))
  const argsStr = handleArgs(code, MemeIndex.infos[code], '', userInfos)
  if (argsStr) fd.set('args', argsStr)
  return await MemeApi.generate(code, fd)
}

/** 生成结果落盘再发。segment.image 各适配器对 Buffer 的支持不一，走文件最稳（和 apps/meme.js 一致） */
export async function replyImage (e, buffer, tail, contentType = 'image/gif') {
  ensureDir('result')
  const loc = dataPath('result', uniqueName(contentType.split('/')[1] || 'gif'))
  fs.writeFileSync(loc, buffer)
  try {
    await e.reply(tail ? [segment.image(`file://${loc}`), tail] : segment.image(`file://${loc}`))
  } finally {
    unlinkQuietly(loc)
  }
}

/**
 * 限并发跑一批任务，回调能拿到原下标。
 *
 * meme 服务是单进程 Python，一次「整活」要连做 6~9 张，全丢过去只会一起变慢，
 * 还会把同一时间发 `#摸头` 的人一起堵住。Web 站的在线生成同样固定不超过 2 个。
 *
 * 下标必须在 await **之前**取走并自增 —— 放到 await 之后的话，
 * 几个 worker 会同时读到同一个 cursor，一起做第 0 项。
 */
export async function mapLimit (items, limit, fn) {
  let cursor = 0
  const worker = async () => {
    while (cursor < items.length) {
      const idx = cursor++
      await fn(items[idx], idx)
    }
  }
  await Promise.all(Array.from({ length: Math.min(limit, items.length) }, worker))
}
