import MemeIndex from '../model/memeIndex.js'
import { makeOne, nameOf } from './memeMake.js'
import { logPrefix } from '../constants/path.js'

/**
 * 表情套娃：把上一层做出来的成品，当成下一层的输入图。
 *
 * 服务端只认「一张图进、一张图出」，所以链式调用天然成立 —— 实测四层连套全部成功。
 * 但有两个坑，都是实测撞出来的：
 *
 * 1. **静态表情会把动画压掉**。把 58 帧的动图喂给「国旗」「坐得住」这类静态模板，
 *    出来的是单帧 JPEG —— 它只取第一帧。链子里撞上一个，从那层往后就全是静态图了，
 *    而随机池里静态模板约占 13%（30 个采样里 4 个），三层链撞上的概率接近四成。
 *    所以随机模式下每层都要验一次输出，退化成静态就换个表情重做（`spare` 备胎池）。
 * 2. **体积会爆**。动图逐帧处理 + 有的表情会放大画布，
 *    `震惊 → 回旋转 → 恐龙` 第三层就变成 1080×1080 的 6.7MB GIF，
 *    再往下套不但慢，发出去也够呛。所以每层做完都要量一次，超了就停在那一层。
 *
 * 想靠 preview 图的类型提前筛掉静态模板是不行的：`dinosaur`、`prpr` 的 preview
 * 是 JPG 但真生成出来是 GIF，`slap` 的 preview 能出、拿头像生成却直接报错。
 * 只有真做一次才知道，所以判断放在运行时。
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
 * 是不是多帧动图。
 *
 * GIF 里每一帧前面都有一个「图形控制扩展」块，固定以 21 F9 04 开头，
 * 数它就知道有几帧 —— 不用解码整张图，也不用依赖 sharp。
 * 单帧 GIF 也算静态：套下去照样是不动的。
 */
export function isAnimated (buffer) {
  if (!buffer || buffer.length < 6) return false
  if (buffer.subarray(0, 3).toString('latin1') !== 'GIF') return false
  let frames = 0
  for (let i = 0; i + 2 < buffer.length; i++) {
    if (buffer[i] === 0x21 && buffer[i + 1] === 0xf9 && buffer[i + 2] === 0x04) {
      frames++
      if (frames > 1) return true
    }
  }
  return false
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
 * @param {{maxBytes?:number, spare?:string[], autoPick?:boolean}} opts
 *        spare 备胎表情：某层做出来是静态图时拿它换一个重做（随机模式才给）；
 *        autoPick 表示这条链是插件随机挑的 —— 只有这种情况下才会
 *        「动画被压平就收手」，用户点名的链照单做完（他要的就是那几层）
 * @returns {Promise<{steps, stopped, flattenedBy}>}
 *          stopped 非空 = 提前收手了，值是给用户看的原因；
 *          flattenedBy 非空 = 这个表情把动画压掉了，用来解释为什么后面不动了
 */
export async function runNest (startBuffer, codes, userInfos, opts = {}) {
  const maxBytes = opts.maxBytes || 4 * 1024 * 1024
  const autoPick = !!opts.autoPick
  const spare = [...(opts.spare || [])]
  const steps = []
  let current = startBuffer
  let stopped = null
  let flattenedBy = null

  for (let i = 0; i < codes.length; i++) {
    let code = codes[i]
    let made = null

    // 这一层最多试几次：本来那个 + 几个备胎。生成一次要 0.05~5 秒，
    // 试太多会让整条指令等到用户以为卡住了
    for (let attempt = 0; attempt < 4; attempt++) {
      const res = await makeOne(code, [current], userInfos)
      if (!res.ok) {
        logger.error(`${logPrefix} 套娃 生成 ${code} 失败: ${res.error}`)
        // 换个备胎接着试；没备胎（点名模式）就认了
        const next = spare.shift()
        if (!next) {
          stopped = `#${nameOf(code)} 这层没套上`
          break
        }
        code = next
        continue
      }

      const animated = isAnimated(res.buffer)
      // 静态模板只取输入的第一帧，套完这条链后面就全不动了。
      // 只有「还有下一层」时才值得换 —— 最后一层是静态的无所谓
      if (!animated && i < codes.length - 1 && spare.length) {
        logger.mark(`${logPrefix} 套娃 #${nameOf(code)} 出的是静态图，换一个`)
        code = spare.shift()
        continue
      }
      if (!animated && i < codes.length - 1) flattenedBy = code
      made = { code, buffer: res.buffer, contentType: res.contentType, animated }
      break
    }

    if (!made) break
    steps.push(made)
    current = made.buffer

    // 量一次再决定要不要继续。这一层的成品是保留的 —— 它已经做出来了，
    // 只是拿它当下一层的输入会更大更慢
    if (current.length > maxBytes && i < codes.length - 1) {
      stopped = `套到第 ${steps.length} 层图就 ${(current.length / 1048576).toFixed(1)}MB 了，再叠下去发不出去`
      break
    }
    // 随机模式下动画被压平就收手：反正是插件自己挑的，再叠只是徒增体积。
    // 点名模式不停 —— 用户点了三层就该给三层，只在结尾说明一句为什么不动了
    if (flattenedBy && autoPick) {
      stopped = `#${nameOf(flattenedBy)} 是静态表情，动图叠到这儿就不动了`
      break
    }
  }

  if (flattenedBy && !stopped) {
    stopped = `#${nameOf(flattenedBy)} 是静态表情，从那层起就不动了`
  }
  return { steps, stopped, flattenedBy }
}

