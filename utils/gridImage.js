import fs from 'node:fs'
import path from 'node:path'
import Preview from '../model/preview.js'
import { dataDir, logPrefix } from '../constants/path.js'
import { mkdirs } from './file.js'

/**
 * 用 puppeteer 把表情渲染成带真实预览图的网格。
 *
 * 服务端的 /memes/render_list 只画关键词加占位图标，看不到表情长什么样，
 * 所以搜索/分类结果自己拼一张。中文标签交给浏览器渲染，字体不会出方框。
 */

let browserPromise = null

/** 浏览器实例复用，避免每次搜索都启动一次 Chromium */
async function getBrowser () {
  if (browserPromise) {
    try {
      const b = await browserPromise
      if (b.connected !== false) return b
    } catch {}
  }
  const puppeteer = (await import('puppeteer')).default
  browserPromise = puppeteer.launch({
    headless: 'new',
    args: ['--no-sandbox', '--disable-dev-shm-usage', '--disable-gpu']
  })
  const b = await browserPromise
  b.on('disconnected', () => { browserPromise = null })
  return b
}

export async function closeBrowser () {
  if (!browserPromise) return
  try {
    const b = await browserPromise
    await b.close()
  } catch {}
  browserPromise = null
}

function esc (s) {
  return String(s).replace(/[&<>"']/g, c => (
    { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]
  ))
}

/** 单元格实测尺寸：宽 168（含 gap）；高 = 预览区 140 + 标签区 + 边框 + gap，标签最多两行 */
const CELL_W = 168
const CELL_H = 210
/** body 左右 padding 之和 */
const PAD_W = 28
/** 标题 + 上下 padding 占的高度 */
const PAD_H = 56

/**
 * 目标宽高比。
 *
 * QQ 气泡里的图受最大宽、最大高两个上限同时约束，按 contain 缩放：
 * 图比「最大宽/最大高」这个比值更高时，缩放由高度决定，宽度就顶不满气泡；
 * 更宽时才由宽度决定，显示宽度恒定 —— 这样每张搜索图都和下面那行链接齐平。
 * 实测那个比值约 1.1，取 1.15 留一点余量。
 */
const TARGET_RATIO = 1.15

/**
 * 挑列数：取「宽高比达标」的最小列数。
 *
 * 达标的前提下列数越少，单元格在最终显示里占的比例就越大、缩略图越清楚，
 * 所以是找下界而不是找最接近某个值的那个。
 */
function bestColumns (n) {
  const max = Math.min(14, n)
  for (let c = 1; c <= max; c++) {
    const rows = Math.ceil(n / c)
    if ((c * CELL_W + PAD_W) / (rows * CELL_H + PAD_H) >= TARGET_RATIO) return c
  }
  // 数量太少时（1 个）怎么排都到不了目标比例，全放一行
  return max
}

/**
 * 渲染表情网格图
 * @param {Array<{key:string, label:string, sub?:string}>} items
 * @param {{title?:string, footer?:string, columns?:number, thumbWidth?:number}} opts
 * @returns {Promise<string>} 生成的图片路径
 */
export async function renderGrid (items, opts = {}) {
  const {
    title = '',
    footer = '',
    columns = bestColumns(items.length),
    thumbWidth = 200
  } = opts

  // 先把缩略图都准备好，转成 data URI 直接内联，
  // 免得 puppeteer 去请求本地 HTTP 服务（多一层依赖、还可能撞上并发限制）
  const cells = []
  for (const it of items) {
    let dataUri = ''
    try {
      const { buffer, contentType } = await Preview.getThumb(it.key, thumbWidth)
      dataUri = `data:${contentType};base64,${buffer.toString('base64')}`
    } catch (err) {
      logger.debug(`${logPrefix} 取缩略图失败 ${it.key}: ${err.message}`)
    }
    cells.push({ ...it, dataUri })
  }

  const html = `<!DOCTYPE html><html><head><meta charset="utf-8"><style>
* { box-sizing: border-box; margin: 0; padding: 0; }
body {
  width: ${columns * 168 + 28}px;
  padding: 14px;
  background: #f7f8fa;
  font-family: "Noto Sans CJK SC", "Noto Sans CJK", "PingFang SC", "Microsoft YaHei", sans-serif;
}
.title { padding: 2px 4px 12px; font-size: 19px; font-weight: 700; color: #1f2328; }
.grid { display: grid; grid-template-columns: repeat(${columns}, 1fr); gap: 10px; }
.cell {
  overflow: hidden;
  background: #fff;
  border: 1px solid #e4e7eb;
  border-radius: 12px;
}
.pic {
  display: flex; align-items: center; justify-content: center;
  height: 140px; padding: 6px;
  background: repeating-conic-gradient(#0000 0 25%, #8881 0 50%) 0 0/14px 14px;
}
.pic img { max-width: 100%; max-height: 100%; object-fit: contain; }
.pic.none { color: #b8bec7; font-size: 12px; background: #f2f3f5; }
.lb { padding: 7px 9px 9px; }
/* 标签压到最多两行：行高不定的话上面 CELL_H 的估算就不准，
   列数会挑错，出图宽高比跟着飘 */
.lb b {
  display: -webkit-box; -webkit-box-orient: vertical; -webkit-line-clamp: 2; overflow: hidden;
  font-size: 14px; font-weight: 600; color: #1f2328; word-break: break-all; line-height: 1.35;
}
.lb i {
  display: block; margin-top: 2px; font-size: 11px; font-style: normal; color: #7b828c;
  overflow: hidden; text-overflow: ellipsis; white-space: nowrap;
}
.ft { padding: 12px 4px 2px; font-size: 12.5px; color: #656d76; line-height: 1.6; }
</style></head><body>
${title ? `<div class="title">${esc(title)}</div>` : ''}
<div class="grid">
${cells.map(c => `<div class="cell">
<div class="pic${c.dataUri ? '' : ' none'}">${c.dataUri ? `<img src="${c.dataUri}">` : '暂无预览'}</div>
<div class="lb"><b>${esc(c.label)}</b>${c.sub ? `<i>${esc(c.sub)}</i>` : ''}</div>
</div>`).join('\n')}
</div>
${footer ? `<div class="ft">${esc(footer)}</div>` : ''}
</body></html>`

  const browser = await getBrowser()
  const page = await browser.newPage()
  try {
    await page.setViewport({ width: columns * CELL_W + PAD_W, height: 200, deviceScaleFactor: 1.5 })
    await page.setContent(html, { waitUntil: 'load', timeout: 60000 })
    const dir = path.join(dataDir, 'list_cache')
    mkdirs(dir)
    const loc = path.join(dir, `grid_${Date.now()}_${process.pid}.jpg`)
    // 截 body 而不是 fullPage：内容撑不满 viewport 时 fullPage 会在底下补一片空白
    // ——5 个表情那种小结果图会多出一大截白边，还把宽高比算歪、宽度顶不满气泡。
    // jpeg 体积约为 png 的 1/5，表情网格用它足够
    const body = await page.$('body')
    await body.screenshot({ path: loc, type: 'jpeg', quality: 88 })
    return loc
  } finally {
    await page.close().catch(() => {})
  }
}
