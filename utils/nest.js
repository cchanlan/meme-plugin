import MemeIndex from '../model/memeIndex.js'
import { makeOne, nameOf } from './memeMake.js'
import { logPrefix } from '../constants/path.js'

/**
 * 表情套娃：把上一层做出来的成品，当成下一层的输入图。
 *
 * 服务端只认「一张图进、一张图出」，所以链式调用天然成立 —— 实测四层连套全部成功。
 * 但**体积是会爆的**：动图逐帧处理 + 有的表情会放大画布，
 * `震惊 → 回旋转 → 恐龙` 第三层就变成 1080×1080 的 6.7MB GIF，
 * 再往下套不但慢，发出去也够呛。所以每层做完都要量一次，超了就停在那一层。
 */

/** 能不能进套娃链：要正好吃一张图、且不需要配文字 */
export function nestable (code) {
  const pt = MemeIndex.infos[code]?.params_type
  return !!pt && pt.min_images === 1 && pt.max_images === 1 && pt.min_texts === 0
}

/** 套娃可用的全部表情（调用方还要再过一道 safePool） */
export function nestCandidates () {
  return MemeIndex.allCodes().filter(nestable)
}

/**
 * 把「摸头 踩 恐龙」解析成 code 数组。
 *
 * 分隔符放宽到空格/逗号/顿号/加号 —— 群里怎么打的都有。
 * 顺带去掉「@昵称」这种纯文本 at：有的客户端手打的 @ 不是 at 段，
 * 会原样留在 e.msg 里被当成表情名（这坑在指令锚点上踩过一次）。
 *
 * @returns {{codes: string[], bad: string|null}} bad 是第一个认不出的词
 */
export function parseSteps (text) {
  const cleaned = String(text || '').replace(/@\S+/g, ' ')
  const tokens = cleaned.split(/[\s,，、+＋]+/).map(s => s.trim()).filter(Boolean)
  const codes = []
  for (const token of tokens) {
    // 先按关键词精确查，再允许直接写英文 code
    const code = MemeIndex.keyMap[token] || (token in MemeIndex.infos ? token : null)
    if (!code) return { codes, bad: token }
    codes.push(code)
  }
  return { codes, bad: null }
}

/**
 * 一层层套下去。
 *
 * @param {Buffer} startBuffer 第一层的输入（通常是头像）
 * @param {string[]} codes 依次要套的表情
 * @param {Array<object>} userInfos 给 handleArgs 用的名字/性别
 * @param {{maxBytes:number}} opts
 * @returns {Promise<{steps: Array<{code,buffer,contentType}>, stopped: string|null}>}
 *          stopped 非空表示提前收手了，值是给用户看的原因
 */
export async function runNest (startBuffer, codes, userInfos, opts = {}) {
  const maxBytes = opts.maxBytes || 4 * 1024 * 1024
  const steps = []
  let current = startBuffer
  let stopped = null

  for (const code of codes) {
    const res = await makeOne(code, [current], userInfos)
    if (!res.ok) {
      logger.error(`${logPrefix} 套娃 生成 ${code} 失败: ${res.error}`)
      // 前面几层已经做出来了，就发出去；这一层的失败当作链子到头
      stopped = `#${nameOf(code)} 这层没套上`
      break
    }
    steps.push({ code, buffer: res.buffer, contentType: res.contentType })
    current = res.buffer

    // 量一次再决定要不要继续。这一层的成品是保留的 —— 它已经做出来了，
    // 只是拿它当下一层的输入会更大更慢
    if (current.length > maxBytes && steps.length < codes.length) {
      stopped = `套到第 ${steps.length} 层图就 ${(current.length / 1048576).toFixed(1)}MB 了，再叠下去发不出去`
      break
    }
  }

  return { steps, stopped }
}
