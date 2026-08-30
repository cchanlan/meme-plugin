/**
 * puppeteer 浏览器实例的统一管理。
 *
 * 搜索网格图和帮助图都要出图，各自 launch 一次会白占一份 Chromium 内存，
 * 所以放到这里共用一个实例。
 */

import process from 'node:process'

let browserPromise = null
/** 当前实例，用来判断 disconnected 事件是不是「现役」那一个发出来的 */
let current = null

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
    }
  })
  return b
}

/** 取浏览器，实例复用；已断开则重新 launch */
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
 * 渲染一段 HTML 并截图。
 *
 * 截 body 而不是 fullPage：内容撑不满 viewport 时 fullPage 会在底下补一片空白，
 * 小结果图会多出一大截白边，还把宽高比算歪、在 QQ 里宽度顶不满气泡。
 *
 * @param {string} html 完整 HTML
 * @param {string} loc 输出路径（.jpg）
 * @param {{width:number, scale?:number, quality?:number}} opts
 */
export async function shotHtml (html, loc, opts = {}) {
  const { width, scale = 1.5, quality = 88 } = opts
  const browser = await getBrowser()
  const page = await browser.newPage()
  try {
    await page.setViewport({ width, height: 200, deviceScaleFactor: scale })
    await page.setContent(html, { waitUntil: 'load', timeout: 60000 })
    const body = await page.$('body')
    // jpeg 体积约为 png 的 1/5，表情图和帮助图用它足够
    await body.screenshot({ path: loc, type: 'jpeg', quality })
    return loc
  } finally {
    await page.close().catch(() => {})
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
