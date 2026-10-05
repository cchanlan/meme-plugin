/**
 * puppeteer 浏览器实例的统一管理。
 *
 * 搜索网格图和帮助图都要出图，各自 launch 一次会白占一份 Chromium 内存，
 * 所以放到这里共用一个实例。
 *
 * 实例不是永久留着的：出图任务全跑完之后按 browserIdleSec 计时关掉，
 * 免得没人玩表情的时候还挂着一份 200MB+ 的 Chromium。
 */

import fs from 'node:fs'
import process from 'node:process'
import Config from '../model/config.js'
import { logPrefix } from '../constants/path.js'

let browserPromise = null
/** 当前实例，用来判断 disconnected 事件是不是「现役」那一个发出来的 */
let current = null
/** 正在出图的任务数。>0 时不能关浏览器，否则会把别人正用的实例拽掉 */
let activeTasks = 0
let idleTimer = null

/**
 * 宿主配了 chromium 路径就用它。puppeteer 自带的 Chromium 常常没下载成功
 * （国内网络、或宿主装依赖时跳过了下载），这时不读宿主配置就只能 launch 失败。
 * 宿主 lib 路径在各 fork 上不一定一样，所以整段 try 掉，读不到就用 puppeteer 默认行为
 */
async function hostChromiumPath () {
  if (process.env.PUPPETEER_EXECUTABLE_PATH) return process.env.PUPPETEER_EXECUTABLE_PATH
  try {
    const cfg = (await import('../../../lib/config/config.js')).default
    return cfg?.bot?.chromium_path || ''
  } catch {
    return ''
  }
}

async function doLaunch () {
  const puppeteer = (await import('puppeteer')).default
  // --no-sandbox / --disable-dev-shm-usage 是 Linux（尤其容器里 /dev/shm 太小）才需要的，
  // Windows 和 macOS 上传了没用；--disable-gpu 三个平台都留着，无头下本来也用不到 GPU
  const args = ['--disable-gpu']
  if (process.platform === 'linux') args.unshift('--no-sandbox', '--disable-dev-shm-usage')
  // headless: true 从 puppeteer 22 起就等价于旧的 'new'，而 'new' 已被标记废弃
  const opts = { headless: true, args }
  const executablePath = await hostChromiumPath()
  if (executablePath) opts.executablePath = executablePath
  const b = await puppeteer.launch(opts)
  current = b
  // 只有现役实例掉线才清缓存：关掉旧实例时若无条件清，会把刚建好的新实例一起作废
  b.on('disconnected', () => {
    if (current === b) {
      current = null
      browserPromise = null
      // 实例已经没了，待关闭的定时器留着也没意义
      cancelIdleClose()
    }
  })
  return b
}

/**
 * 取浏览器，实例复用；已断开则重新 launch。
 *
 * 这里刻意不碰空闲定时器 —— 谁开的任务谁负责配平计数，否则一次
 * 不走 shotHtml 的调用就能把浏览器变成永久常驻。要长时间占着实例
 * 就照 shotHtml 那样自己 activeTasks++ / -- 再 scheduleIdleClose()。
 */
export async function getBrowser () {
  if (browserPromise) {
    try {
      const b = await browserPromise
      if (b.connected !== false) return b
    } catch {}
  }
  // 赋值必须同步做在前面：doLaunch 里有 `await import('puppeteer')`，
  // 两个请求同时进来都会穿过上面的判断各自 launch 一个 Chromium，
  // 先建好的那个从此没人引用、也没人关，一份 200MB+ 就这么漏掉了
  // （榜单图和搜索图同时被触发是很常见的）。
  browserPromise = doLaunch()
  return await browserPromise
}

export async function closeBrowser () {
  cancelIdleClose()
  if (!browserPromise) return
  const p = browserPromise
  browserPromise = null
  current = null
  try {
    const b = await p
    await b.close()
  } catch {}
}

/**
 * 出图完成后再空闲多久就关掉浏览器（秒），0 表示每张图出完立刻关。
 *
 * 一份 Chromium 常驻要 200MB+，而出图是「一阵一阵」的：没人发指令时留着纯属白占。
 * 反过来每张都关又要重付一次启动开销（实测 1~2 秒），连发几个表情、
 * 榜单图紧跟搜索图这种连续场景会被拖慢，所以默认留一小段空闲窗口。
 */
function idleCloseMs () {
  const sec = Number(Config.get('browserIdleSec'))
  return Number.isFinite(sec) && sec >= 0 ? sec * 1000 : 60000
}

function cancelIdleClose () {
  if (idleTimer) {
    clearTimeout(idleTimer)
    idleTimer = null
  }
}

/** 没有在跑的出图任务了，安排把浏览器关掉 */
function scheduleIdleClose () {
  cancelIdleClose()
  if (activeTasks > 0) return
  const ms = idleCloseMs()
  if (ms === 0) {
    closeBrowser()
    return
  }
  idleTimer = setTimeout(() => {
    idleTimer = null
    // 排上定时器之后又来了新任务，就不能关
    if (activeTasks === 0) closeBrowser()
  }, ms)
  // 这个定时器不该拖着 Node 不让退出
  idleTimer.unref?.()
}

/** 出图格式的可选值（跟锅巴「输出图片类型」下拉一致） */
const IMG_TYPES = ['jpeg', 'png', 'webp']

/**
 * 出图格式，读配置项 `img_type`，默认 jpeg。
 *
 * 原来是写死的 webp 常量。webp 在 QQ 上很好（同一张图实测 scale 2.5 + webp q82
 * 比原来 scale 2 + jpeg q92 体积更小、分辨率更高、失真更低，q82 视觉上相当于 jpeg q90+），
 * 但**微信（ComWeChat）适配器的图片接口不认 webp**：会把它降级成「文件」发出去，
 * 群友收到的是 xxx.webp 文件卡片而不是图。所以默认改成最保险的 jpeg。
 *
 * ⚠️ 必须是**函数**而不是常量：meme 插件支持热更（apps 重新加载），
 * 常量只在模块首次加载时求一次值，用户在锅巴里改完格式得重启进程才生效。
 * 函数每次都重新读配置，改完下次出图就生效。
 */
export function getImgFormat () {
  try {
    const raw = String(Config.get('img_type') ?? '').trim().toLowerCase()
    if (raw === 'jpg' || raw === 'image/jpeg') return 'jpeg'
    return IMG_TYPES.includes(raw) ? raw : 'jpeg'
  } catch (_) {
    return 'jpeg'
  }
}

/**
 * 当前格式的扩展名（带点）。
 *
 * 必须跟内容一致 —— NapCat 上传按后缀判 MIME，后缀写错会被当成别的类型。
 * 所以文件名统一从这里取，别在调用点手写 `.webp`。
 */
export function getImgExt () {
  return `.${getImgFormat()}`
}

/** 默认质量：webp / jpeg 都用它。png 是无损的，用不上 */
export const IMG_QUALITY = 82

/** sharp 是主仓库自带的，缺了也要能跑——退回 Chromium 内置编码器 */
let sharpMod = null
let sharpChecked = false
async function getSharp () {
  if (sharpChecked) return sharpMod
  sharpChecked = true
  try {
    sharpMod = (await import('sharp')).default
  } catch (err) {
    sharpMod = null
  }
  return sharpMod
}

/**
 * 把一张无损 png 编成目标格式。
 *
 * 走「渲染器出 png → sharp 二次编码」而不是让 Chromium 直接出目标格式：
 * Chromium 用的是内置编码器，实测 mozjpeg 同 quality 下比它小约 18%、webp 更小得多；
 * png 是无损的所以二次编码不累积失真。
 *
 * jpeg 优先用 mozjpeg，失败退回普通编码器 —— 这选项依赖 sharp 编译时带上 mozjpeg，
 * 个别平台 / 自编译的 sharp 会直接抛，不能让它把整张图搞没。
 *
 * @param {Buffer} png 源图（无损 png 最理想）
 * @param {{format?:'jpeg'|'png'|'webp', quality?:number}} opts
 * @returns {Promise<Buffer|null>} 编码失败返回 null，调用方自己决定退路
 */
export async function encodeShot (png, { format = getImgFormat(), quality = IMG_QUALITY } = {}) {
  const sharp = await getSharp()
  if (!sharp) return null
  try {
    if (format === 'png') return await sharp(png).png().toBuffer()
    if (format === 'webp') return await sharp(png).webp({ quality }).toBuffer()
    try {
      return await sharp(png).jpeg({ quality, chromaSubsampling: '4:4:4', mozjpeg: true }).toBuffer()
    } catch (_) {
      return await sharp(png).jpeg({ quality, chromaSubsampling: '4:4:4' }).toBuffer()
    }
  } catch (err) {
    logger.debug(`${logPrefix} 编码 ${format} 失败: ${err.message}`)
    return null
  }
}

/**
 * 渲染一段 HTML 并截图。
 *
 * 截 body 而不是 fullPage：内容撑不满 viewport 时 fullPage 会在底下补一片空白，
 * 小结果图会多出一大截白边，还把宽高比算歪、在 QQ 里宽度顶不满气泡。
 *
 * 出图格式默认读配置（见 getImgFormat），也可以由 opts.format 显式指定。
 *
 * ⚠️ **loc 的扩展名由调用方保证与格式一致**（用 getImgExt()）：NapCat 上传按后缀
 * 判 MIME，`xxx.webp` 里装着 jpeg 会被当成 webp 发。这里刻意不帮调用方改路径 ——
 * gridImage 是「先写临时名再 rename」的，这里偷偷换掉扩展名会让它 rename 失败。
 *
 * 出图完了浏览器不会一直留着：并发的任务都结束后按 browserIdleSec 计时关掉。
 *
 * @param {string} html 完整 HTML
 * @param {string} loc 输出路径
 * @param {{width:number, scale?:number, quality?:number, format?:'jpeg'|'png'|'webp'}} opts
 * @returns {Promise<string>} 写出的路径（就是传入的 loc）
 */
export async function shotHtml (html, loc, opts = {}) {
  const { width, scale = 2, quality = IMG_QUALITY, format = getImgFormat() } = opts
  activeTasks++
  // 先撤掉待关闭的定时器：不然它可能正好在这张图用实例的当口把浏览器关了
  cancelIdleClose()
  let page = null
  try {
    const browser = await getBrowser()
    page = await browser.newPage()
    await page.setViewport({ width, height: 200, deviceScaleFactor: scale })
    await page.setContent(html, { waitUntil: 'load', timeout: 60000 })
    const body = await page.$('body')
    const sharp = await getSharp()
    if (!sharp) {
      // 没有 sharp 只能用 Chromium 内置编码器，它也支持 png / jpeg / webp。
      // ⚠️ png 是无损的，**传 quality 会直接抛错**（puppeteer：「png screenshots
      // do not support 'quality'」，25.x 实测），所以只有有损格式才带上它。
      const shotOpts = { path: loc, type: format }
      if (format !== 'png') shotOpts.quality = quality
      await body.screenshot(shotOpts)
      return loc
    }
    const png = await body.screenshot({ type: 'png' })
    const out = await encodeShot(png, { format, quality })
    if (out) {
      fs.writeFileSync(loc, out)
      return loc
    }
    // sharp 在但编码挂了：别退回 Chromium 再截一次（白多一次页面操作），
    // png 是无损的，直接落原图也能发出去
    fs.writeFileSync(loc, png)
    return loc
  } finally {
    if (page) await page.close().catch(() => {})
    activeTasks--
    // launch 或 newPage 就失败时也要走到这里，否则计数配不平、浏览器再没人关
    scheduleIdleClose()
  }
}

/**
 * 粉白蓝二次元主题的公共样式，网格图和帮助图共用同一套配色。
 *
 * 配色分三系（粉 → 薰衣草紫 → 蓝）各三档深浅，
 * 层次靠档位差拉开，整体压得很淡，避免出图时颜色糊成一片。
 */
export const THEME_CSS = `
* { box-sizing: border-box; margin: 0; padding: 0; }
body {
  color: #5d4b56;
  font-family: "Noto Sans CJK SC", "Noto Sans CJK", "PingFang SC", "Microsoft YaHei", sans-serif;
  /* 四层极淡光斑：左上粉 → 中上薰衣草 → 右上蓝 → 底部一层暖白，比两层渐变更有层次 */
  background:
    radial-gradient(620px 300px at 2% -10%, rgba(255, 168, 200, .26), transparent 64%),
    radial-gradient(560px 260px at 42% -14%, rgba(206, 186, 250, .20), transparent 62%),
    radial-gradient(620px 300px at 99% -6%, rgba(150, 197, 250, .24), transparent 62%),
    radial-gradient(700px 380px at 50% 108%, rgba(255, 240, 246, .75), transparent 66%),
    #fffafc;
}
/* 满屏细点纹理，纯色底容易显得寡淡；三色交错点比单色更有层次 */
body::before {
  content: "";
  position: absolute; inset: 0; pointer-events: none;
  background-image:
    radial-gradient(rgba(255, 168, 200, .13) 1px, transparent 1.4px),
    radial-gradient(rgba(206, 186, 250, .11) 1px, transparent 1.4px),
    radial-gradient(rgba(150, 197, 250, .11) 1px, transparent 1.4px);
  background-size: 30px 30px, 30px 30px, 30px 30px;
  background-position: 0 0, 10px 15px, 20px 8px;
}
.grad-text {
  background: linear-gradient(112deg, #f79ac0 0%, #d3b0f2 34%, #b6c8f5 66%, #96c5fa 100%);
  -webkit-background-clip: text; background-clip: text; -webkit-text-fill-color: transparent;
}
`
