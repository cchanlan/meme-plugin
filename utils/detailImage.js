import path from 'node:path'
import Preview from '../model/preview.js'
import { argSchemas, getEnum } from './args.js'
import { dataDir, logPrefix } from '../constants/path.js'
import { mkdirs } from './file.js'
import { shotHtml, THEME_CSS, IMG_EXT } from './browser.js'

/**
 * 「#摸头详情」的出图版。
 *
 * 纯文字版看不出这个表情长什么样，而「支持哪些参数」恰恰是要对着效果调的，
 * 所以左边直接放真实预览图、右边列参数。数据全部来自服务端 schema（见 utils/args.js），
 * 不硬编码，57 个带参表情都能画。
 *
 * 宽度取 560：详情只有一栏，比网格图窄，缩放后字反而更大；
 * 参数说明可能很长，再窄就要折行折成一坨。
 */

const WIDTH = 560

function esc (s) {
  return String(s).replace(/[&<>"']/g, c => (
    { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]
  ))
}

/** schema 的类型名换成中文，integer/number 都是「数字」，用户不用管区别 */
function typeName (schema) {
  if (getEnum(schema)) return '选项'
  return {
    integer: '数字',
    number: '数字',
    boolean: '开关',
    string: '文字'
  }[schema.type] || schema.type || '文字'
}

/** 一个参数一张小卡：名字 + 类型角标 + 说明 + 可选值 chips + 默认值 */
function argCard (name, schema) {
  const enums = getEnum(schema)
  const rows = []
  if (schema.description) rows.push(`<div class="ad">${esc(schema.description)}</div>`)
  if (enums) {
    rows.push(`<div class="chips">${enums.map(v => `<span>${esc(v)}</span>`).join('')}</div>`)
  }
  if (schema.default !== undefined && schema.default !== '' && schema.default !== null) {
    rows.push(`<div class="adf">默认 ${esc(schema.default)}</div>`)
  }
  return `<div class="arg">
<div class="ah"><code>${esc(name)}</code><span class="ty">${esc(typeName(schema))}</span></div>
${rows.join('')}
</div>`
}

const CSS = `
${THEME_CSS}
body { position: relative; width: ${WIDTH}px; padding: 18px 20px 16px; }
.hd { position: relative; display: flex; align-items: baseline; gap: 10px; }
.hd h1 { font-size: 27px; font-weight: 800; letter-spacing: .5px; }
.hd .code { padding: 2px 9px; font-size: 13px; font-weight: 700; color: #9079c2;
  background: #f4efff; border-radius: 8px; }
.line { position: relative; height: 3px; margin: 10px 0 14px; border-radius: 999px;
  background: linear-gradient(112deg, #f79ac0 0%, #d3b0f2 34%, #b6c8f5 66%, #96c5fa 100%); opacity: .8; }
/* 上半区左图右信息。图固定 200px 宽，信息列自适应 —— 反过来会被长关键词顶散 */
.top { position: relative; display: flex; gap: 14px; align-items: stretch; }
.pic {
  flex: 0 0 200px; display: flex; align-items: center; justify-content: center;
  height: 168px; padding: 8px; overflow: hidden;
  background:
    linear-gradient(45deg, rgba(255,168,200,.07) 25%, transparent 25% 75%, rgba(255,168,200,.07) 75%) 0 0/14px 14px,
    linear-gradient(45deg, rgba(150,197,250,.06) 25%, transparent 25% 75%, rgba(150,197,250,.06) 75%) 7px 7px/14px 14px,
    #fffdfe;
  border: 1.5px solid #ffd9e8; border-radius: 16px;
  box-shadow: 0 2px 8px rgba(214, 158, 186, .10);
}
.pic img { max-width: 100%; max-height: 100%; object-fit: contain;
  filter: drop-shadow(0 2px 5px rgba(150, 130, 148, .16)); }
.pic.none { color: #cfa7bb; font-size: 13px; }
.meta { flex: 1 1 auto; min-width: 0; padding: 12px 14px;
  background: #fffdfeee; border: 1.5px solid #d3e6fd; border-radius: 16px;
  box-shadow: 0 2px 8px rgba(160, 180, 225, .10); }
.mr { display: flex; gap: 8px; padding: 5px 0; font-size: 14.5px; line-height: 1.45; }
.mr + .mr { border-top: 1px dashed #d3e6fd; }
.mr b { flex: 0 0 auto; font-weight: 700; color: #5f95d0; }
.mr span { min-width: 0; color: #6d5b66; word-break: break-all; }
/* 别名和分类都可能有十几个，各压到两行、多的省略 —— 全列出来会把上半区拉高、图反而被挤矮 */
.mr.clamp span { display: -webkit-box; -webkit-box-orient: vertical; -webkit-line-clamp: 2; overflow: hidden; }
.sec { position: relative; margin-top: 14px; }
.sec h2 { display: flex; align-items: center; gap: 7px; margin-bottom: 9px;
  font-size: 18px; font-weight: 800; color: #d96e97; }
.args { display: grid; grid-template-columns: 1fr 1fr; gap: 10px; }
/* 只有一个参数时不分两列，否则右边空一大块 */
.args.one { grid-template-columns: 1fr; }
.arg { padding: 10px 12px; background: #fffdfeee;
  border: 1.5px solid #e4d8fb; border-radius: 14px;
  box-shadow: 0 2px 8px rgba(160, 180, 225, .08); }
.ah { display: flex; align-items: center; gap: 7px; margin-bottom: 5px; }
.ah code { padding: 2px 8px; font-family: "Noto Sans CJK SC", "PingFang SC", monospace;
  font-size: 15px; font-weight: 700; color: #9079c2; background: #f4efff; border-radius: 7px; }
.ah .ty { font-size: 12px; color: #ab99a5; }
.ad { font-size: 13.5px; color: #6d5b66; line-height: 1.5; }
.chips { display: flex; flex-wrap: wrap; gap: 5px; margin-top: 6px; }
.chips span { padding: 2px 8px; font-size: 12.5px; color: #5f95d0;
  background: #e8f2ff; border: 1px solid #d3e6fd; border-radius: 999px; }
.adf { margin-top: 5px; font-size: 12.5px; color: #ab99a5; }
.noarg { padding: 11px 14px; font-size: 14px; color: #93818d;
  background: #fffdfeee; border: 1.5px dashed #ffd9e8; border-radius: 14px; }
.ft { position: relative; margin-top: 14px; padding: 10px 16px; font-size: 14.5px; color: #6d5b66;
  background: linear-gradient(112deg, #ffeaf3 0%, #f4efff 50%, #e8f2ff 100%);
  border: 1.5px solid #ffd9e8; border-radius: 999px;
  box-shadow: 0 4px 12px rgba(214, 158, 186, .14); }
.ft b { font-weight: 800; color: #d96e97; }
.tip { position: relative; margin-top: 9px; font-size: 12.5px; color: #ab99a5; text-align: center; }
`

/**
 * 渲染单个表情的详情图
 * @param {string} code 表情 key
 * @param {object} info 服务端返回的该表情 info
 * @returns {Promise<string>} 图片路径
 */
export async function renderDetail (code, info) {
  const pt = info.params_type || {}
  const keywords = info.keywords || []
  const name = keywords[0] || code
  const schemas = argSchemas(info)

  // 预览图内联成 data URI：让 puppeteer 去请求本地 HTTP 服务多一层依赖，
  // 而且 Web 站可能被关掉（enableWeb=false）
  let dataUri = ''
  try {
    const { buffer, contentType } = await Preview.getThumb(code, 400)
    dataUri = `data:${contentType};base64,${buffer.toString('base64')}`
  } catch (err) {
    logger.debug(`${logPrefix} 详情图取预览失败 ${code}: ${err.message}`)
  }

  const rows = []
  if (keywords.length > 1) {
    rows.push(`<div class="mr clamp"><b>别名</b><span>${esc(keywords.join('、'))}</span></div>`)
  }
  const range = (min, max) => (min === max ? String(min) : `${min}~${max}`)
  rows.push(`<div class="mr"><b>图片</b><span>${pt.max_images > 0
    ? `${range(pt.min_images, pt.max_images)} 张`
    : '不需要'}</span></div>`)
  rows.push(`<div class="mr"><b>文字</b><span>${pt.max_texts > 0
    ? `${range(pt.min_texts, pt.max_texts)} 段${pt.max_texts > 1 ? '（用 / 隔开）' : ''}`
    : '不需要'}</span></div>`)
  if (pt.default_texts?.length) {
    rows.push(`<div class="mr"><b>默认</b><span>${esc(pt.default_texts.join(' / '))}</span></div>`)
  }
  if (info.tags?.length) {
    rows.push(`<div class="mr clamp"><b>分类</b><span>${esc(info.tags.join('、'))}</span></div>`)
  }

  // 用法示例照着这个表情的实际需求拼，而不是给一句通用模板
  const usage = [`#${name}`]
  if (pt.max_images > 0) usage.push(`#${name} @某人`)
  if (pt.max_texts > 0) usage.push(pt.max_texts > 1 ? `#${name} 文字1/文字2` : `#${name} 文字`)
  if (schemas.length > 0) usage.push(`#${name}#参数`)

  const html = `<!DOCTYPE html><html><head><meta charset="utf-8"><style>${CSS}</style></head><body>
<div class="hd"><h1 class="grad-text">${esc(name)}</h1><span class="code">${esc(info.key || code)}</span></div>
<div class="line"></div>
<div class="top">
  <div class="pic${dataUri ? '' : ' none'}">${dataUri ? `<img src="${dataUri}">` : '暂无预览'}</div>
  <div class="meta">${rows.join('')}</div>
</div>
<div class="sec">
  <h2><span>🔧</span>支持参数</h2>
  ${schemas.length
    ? `<div class="args${schemas.length === 1 ? ' one' : ''}">${schemas.map(([n, s]) => argCard(n, s)).join('')}</div>`
    : '<div class="noarg">这个表情没有额外参数，直接发就行~</div>'}
</div>
<div class="ft">💡 <b>用法</b>　${esc(usage.join('　'))}</div>
<div class="tip">参数写在表情名后面，用 # 隔开 · 数据来自 meme 服务</div>
</body></html>`

  const dir = path.join(dataDir, 'list_cache')
  mkdirs(dir)
  const loc = path.join(dir, `detail_${code}_${Date.now()}_${process.pid}${IMG_EXT}`)
  // scale 2：详情图字号偏小，缩放后要点开还能看清
  return shotHtml(html, loc, { width: WIDTH, scale: 2.5 })
}
