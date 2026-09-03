import path from 'node:path'
import { dataDir } from '../constants/path.js'
import { mkdirs } from './file.js'
import { qqAvatar } from './user.js'
import { shotHtml, THEME_CSS, IMG_EXT } from './browser.js'

/**
 * 猜表情榜出图。
 *
 * 和用量榜（utils/statsImage.js）是两套数据、两个模板，但配色、圆角、
 * 头像那一行的排法都照它抄 —— 两张榜出现在同一个群里，长得不一样会很怪。
 * 比用量榜简单：没有表情缩略图、没有 7 天趋势（猜表情不按天记）。
 *
 * 头像先在 Node 侧抓好内联成 data URI：让 puppeteer 自己去请求外链，
 * 一个慢头像就能把整张图的截图卡到超时。
 */

const WIDTH = 620

function esc (s) {
  return String(s).replace(/[&<>"']/g, c => (
    { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]
  ))
}

/** 抓一张图转 data URI，失败返回空串（出图不能因为一张头像挂掉） */
async function toDataUri (url, timeoutMs = 3000) {
  try {
    const res = await fetch(url, { signal: AbortSignal.timeout(timeoutMs) })
    if (!res.ok) return ''
    const type = (res.headers.get('content-type') || 'image/jpeg').split(';')[0]
    const buf = Buffer.from(await res.arrayBuffer())
    return `data:${type};base64,${buf.toString('base64')}`
  } catch {
    return ''
  }
}

/** 前三名给奖牌，其余给名次数字 */
function medal (i) {
  return ['🥇', '🥈', '🥉'][i] || String(i + 1)
}

const CSS = `
${THEME_CSS}
body { position: relative; width: ${WIDTH}px; padding: 20px 22px 18px; }
.hd { position: relative; display: flex; align-items: flex-end; gap: 11px; }
.hd h1 { font-size: 28px; font-weight: 800; letter-spacing: 1px; }
.hd .sub { padding-bottom: 3px; font-size: 14px; color: #ab99a5; }
.line { position: relative; height: 3px; margin: 11px 0 14px; border-radius: 999px;
  background: linear-gradient(112deg, #f79ac0 0%, #d3b0f2 34%, #b6c8f5 66%, #96c5fa 100%); opacity: .8; }
.ov { position: relative; display: grid; gap: 11px; }
.ov div { padding: 10px 12px; text-align: center; background: #fffdfeee;
  border: 1.5px solid #ffd9e8; border-radius: 15px;
  box-shadow: 0 2px 8px rgba(214, 158, 186, .10); }
.ov b { display: block; font-size: 23px; font-weight: 800; color: #d96e97; }
.ov span { font-size: 12.5px; color: #93818d; }
.ov div:nth-child(2) { border-color: #e4d8fb; } .ov div:nth-child(2) b { color: #9079c2; }
.ov div:nth-child(3) { border-color: #d3e6fd; } .ov div:nth-child(3) b { color: #5f95d0; }
.blk { margin-top: 13px; padding: 13px 15px 11px; background: #fffdfeee;
  border: 1.5px solid #ffd9e8; border-radius: 18px;
  box-shadow: 0 2px 8px rgba(214, 158, 186, .10), 0 8px 20px rgba(160, 180, 225, .08); }
.blk.blue { border-color: #d3e6fd; }
.blk.lilac { border-color: #e4d8fb; }
.blk h2 { display: flex; align-items: center; gap: 7px; margin-bottom: 9px;
  font-size: 18px; font-weight: 800; color: #d96e97; }
.blk.blue h2 { color: #5f95d0; }
.blk.lilac h2 { color: #9079c2; }
.it { display: flex; align-items: center; gap: 8px; padding: 5px 0; }
.it + .it { border-top: 1px dashed #d3e6fd; }
.rk { flex: 0 0 24px; font-size: 14px; font-weight: 800; color: #cfa7bb; text-align: center; }
.av { flex: 0 0 34px; display: flex; align-items: center; justify-content: center;
  width: 34px; height: 34px; overflow: hidden; background: #fff6fa; border-radius: 999px; }
.av img { width: 100%; height: 100%; object-fit: cover; }
.bd { flex: 1 1 auto; min-width: 0; }
.bd .nm { font-size: 14.5px; font-weight: 700; color: #55424d;
  overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
/* 条形长度按第一名归一化：绝对值差太大时后几名会缩成一条线，这样至少看得出比例 */
.bd .pb { height: 5px; margin-top: 4px; background: #e8f2ff; border-radius: 999px; overflow: hidden; }
.bd .pb i { display: block; height: 100%; border-radius: 999px;
  background: linear-gradient(90deg, #f79ac0 0%, #d3b0f2 60%, #96c5fa 100%); }
.ct { flex: 0 0 auto; font-size: 14px; font-weight: 800; color: #5f95d0; }
.gr { display: flex; align-items: baseline; gap: 8px; padding: 5px 0; font-size: 13.5px; }
.gr + .gr { border-top: 1px dashed #e4d8fb; }
.gr b { flex: 0 0 22px; font-weight: 800; color: #c3aee8; text-align: center; }
.gr span { flex: 1 1 auto; min-width: 0; color: #6d5b66; overflow: hidden;
  text-overflow: ellipsis; white-space: nowrap; }
.gr span em { font-style: normal; font-size: 11.5px; color: #bfaec6; }
.gr i { flex: 0 0 auto; font-style: normal; font-weight: 800; color: #9079c2; }
.ft { position: relative; margin-top: 13px; padding: 10px 16px; font-size: 14px; color: #6d5b66;
  background: linear-gradient(112deg, #ffeaf3 0%, #f4efff 50%, #e8f2ff 100%);
  border: 1.5px solid #ffd9e8; border-radius: 999px;
  box-shadow: 0 4px 12px rgba(214, 158, 186, .14); }
.ft b { font-weight: 800; color: #d96e97; }
`

/**
 * 渲染猜表情榜
 * @param {object} s GuessGame.summary() / groupSummary() 的结果
 * @param {{scope?:'group'|'total', groupNames?:Record<string,string>}} extra
 * @returns {Promise<string>} 图片路径
 */
export async function renderGuessRank (s, extra = {}) {
  const isGroup = extra.scope === 'group'
  const names = extra.groupNames || {}

  const avatars = await Promise.all(s.users.map(u => toDataUri(qqAvatar(u.key, 100))))
  const max = s.users[0]?.n || 0
  const since = new Date(s.since)
  const sinceStr = `${since.getMonth() + 1}月${since.getDate()}日`

  const title = isGroup ? '🏆 本群猜表情榜' : '🏆 猜表情总榜'
  const sub = [
    isGroup && s.groupName ? s.groupName : '',
    `从 ${sinceStr} 起`,
    !isGroup && s.groupCount ? `${s.groupCount} 个群` : ''
  ].filter(Boolean).join(' · ')

  const cells = [
    [s.total, '累计答对'],
    [s.userCount, '参与的人'],
    ...(isGroup ? [] : [[s.groupCount, '参与的群']])
  ]

  const html = `<!DOCTYPE html><html><head><meta charset="utf-8"><style>${CSS}</style></head><body>
<div class="hd">
  <h1 class="grad-text">${esc(title)}</h1>
  <span class="sub">${esc(sub)}</span>
</div>
<div class="line"></div>
<div class="ov" style="grid-template-columns:repeat(${cells.length},1fr)">
${cells.map(([n, label]) => `  <div><b>${n}</b><span>${label}</span></div>`).join('\n')}
</div>
<div class="blk blue">
  <h2><span>🔍</span>最会猜的人</h2>
${s.users.map((u, i) => {
    const pct = max > 0 ? Math.max(4, Math.round(u.n / max * 100)) : 0
    return `  <div class="it">
    <div class="rk">${medal(i)}</div>
    <div class="av">${avatars[i] ? `<img src="${avatars[i]}">` : '🌸'}</div>
    <div class="bd"><div class="nm">${esc(u.name || u.key)}</div>
      <div class="pb"><i style="width:${pct}%"></i></div></div>
    <div class="ct">${u.n} 分</div>
  </div>`
  }).join('\n')}
</div>
${!isGroup && s.groups.length > 1
    ? `<div class="blk lilac">
  <h2><span>💬</span>最能猜的群</h2>
${s.groups.map((g, i) => {
      const name = names[g.key] || g.name || ''
      return `  <div class="gr"><b>${i + 1}</b><span>${
        name ? `${esc(name)} <em>${esc(g.key)}</em>` : esc(g.key)
      }</span><i>${g.n}</i></div>`
    }).join('\n')}
</div>`
    : ''}
<div class="ft">💡 发 <b>#猜表情</b> 开一局${isGroup ? '　·　#猜表情总排行 看全服榜' : '　·　#猜表情排行 看本群榜'}</div>
</body></html>`

  const dir = path.join(dataDir, 'list_cache')
  mkdirs(dir)
  const loc = path.join(dir, `guess_${Date.now()}_${process.pid}${IMG_EXT}`)
  return shotHtml(html, loc, { width: WIDTH, scale: 2.5 })
}
