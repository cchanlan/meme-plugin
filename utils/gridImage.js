import path from 'node:path'
import Preview from '../model/preview.js'
import { dataDir, logPrefix } from '../constants/path.js'
import { mkdirs } from './file.js'
import { shotHtml, THEME_CSS } from './browser.js'

/**
 * 用 puppeteer 把表情渲染成带真实预览图的网格。
 *
 * 服务端的 /memes/render_list 只画关键词加占位图标，看不到表情长什么样，
 * 所以搜索/分类结果自己拼一张。中文标签交给浏览器渲染，字体不会出方框。
 * 配色和 Web 预览站共用 THEME_CSS 那套粉白蓝主题。
 */

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
${THEME_CSS}
body {
  position: relative;
  width: ${columns * 168 + 28}px;
  padding: 14px;
}
.title {
  position: relative;
  padding: 2px 4px 12px;
  font-size: 19px;
  font-weight: 800;
  letter-spacing: .3px;
}
.grid { position: relative; display: grid; grid-template-columns: repeat(${columns}, 1fr); gap: 10px; }
.cell {
  position: relative;
  overflow: hidden;
  background: #fffdfe;
  border: 1px solid #ffd9e8;
  border-radius: 14px;
  box-shadow: 0 1px 4px rgba(214, 158, 186, .09), 0 5px 14px rgba(160, 180, 225, .09);
}
/* 顶部渐变封口条走 absolute，不能占高度 —— 一占 CELL_H 的估算就偏，列数会挑错 */
.cell::before {
  content: "";
  position: absolute; top: 0; right: 0; left: 0; height: 3px; z-index: 2;
  background: linear-gradient(112deg, #f79ac0 0%, #d3b0f2 34%, #b6c8f5 66%, #96c5fa 100%);
  opacity: .8;
}
.pic {
  display: flex; align-items: center; justify-content: center;
  height: 140px; padding: 6px;
  /* 透明格用粉蓝双色棋盘，压得很淡：透明背景的表情占多数，格子一浓就盖过表情本身 */
  background:
    linear-gradient(45deg, rgba(255,168,200,.07) 25%, transparent 25% 75%, rgba(255,168,200,.07) 75%) 0 0/14px 14px,
    linear-gradient(45deg, rgba(150,197,250,.06) 25%, transparent 25% 75%, rgba(150,197,250,.06) 75%) 7px 7px/14px 14px;
}
.pic img {
  max-width: 100%; max-height: 100%; object-fit: contain;
  filter: drop-shadow(0 2px 4px rgba(150, 130, 148, .14));
}
.pic.none { color: #cfa7bb; font-size: 12px; background: #fff6fa; }
.lb { padding: 7px 9px 9px; }
/* 标签压到最多两行：行高不定的话上面 CELL_H 的估算就不准，
   列数会挑错，出图宽高比跟着飘 */
.lb b {
  display: -webkit-box; -webkit-box-orient: vertical; -webkit-line-clamp: 2; overflow: hidden;
  font-size: 14px; font-weight: 700; color: #55424d; word-break: break-all; line-height: 1.35;
}
.lb i {
  display: block; margin-top: 2px; font-size: 11px; font-style: normal; color: #ab99a5;
  overflow: hidden; text-overflow: ellipsis; white-space: nowrap;
}
.ft {
  position: relative;
  padding: 12px 4px 2px; font-size: 12.5px; color: #93818d; line-height: 1.6;
}
</style></head><body>
${title ? `<div class="title"><span class="grad-text">🌸 ${esc(title)}</span></div>` : ''}
<div class="grid">
${cells.map(c => `<div class="cell">
<div class="pic${c.dataUri ? '' : ' none'}">${c.dataUri ? `<img src="${c.dataUri}">` : '暂无预览'}</div>
<div class="lb"><b>${esc(c.label)}</b>${c.sub ? `<i>${esc(c.sub)}</i>` : ''}</div>
</div>`).join('\n')}
</div>
${footer ? `<div class="ft">${esc(footer)}</div>` : ''}
</body></html>`

  const dir = path.join(dataDir, 'list_cache')
  mkdirs(dir)
  const loc = path.join(dir, `grid_${Date.now()}_${process.pid}.jpg`)
  return shotHtml(html, loc, { width: columns * CELL_W + PAD_W })
}
