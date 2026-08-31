import path from 'node:path'
import Preview from '../model/preview.js'
import MemeIndex from '../model/memeIndex.js'
import { dataDir, logPrefix } from '../constants/path.js'
import { mkdirs } from './file.js'
import { qqAvatar } from './user.js'
import { shotHtml, THEME_CSS, IMG_EXT } from './browser.js'

/**
 * 用量榜出图，一套模板出两种榜：
 * - `scope: 'group'`（`#meme排行`）本群自己的数据，没有群排行块；
 * - `scope: 'total'`（`#meme总排行`）跨群总账，右列多一块群排行。
 *
 * 两列排（左表情榜、右玩家榜）而不是一长条：QQ 气泡按宽、高两个上限 contain 缩放，
 * 竖长图会被高度卡住、宽度顶不满，字反而更小 —— 和帮助图同一个取舍。
 *
 * 表情缩略图和 QQ 头像都先在 Node 侧抓好、内联成 data URI：
 * 让 puppeteer 自己去请求外链，一个慢头像就能把整张图的截图卡到超时。
 */

const WIDTH = 760

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
.hd h1 { font-size: 30px; font-weight: 800; letter-spacing: 1px; }
.hd .sub { padding-bottom: 3px; font-size: 14px; color: #ab99a5; }
.line { position: relative; height: 3px; margin: 11px 0 14px; border-radius: 999px;
  background: linear-gradient(112deg, #f79ac0 0%, #d3b0f2 34%, #b6c8f5 66%, #96c5fa 100%); opacity: .8; }
/* 概览四宫格：数字大、说明小，扫一眼就知道规模 */
.ov { position: relative; display: grid; grid-template-columns: repeat(4, 1fr); gap: 11px; }
.ov div { padding: 10px 12px; text-align: center; background: #fffdfeee;
  border: 1.5px solid #ffd9e8; border-radius: 15px;
  box-shadow: 0 2px 8px rgba(214, 158, 186, .10); }
.ov b { display: block; font-size: 23px; font-weight: 800; color: #d96e97; }
.ov span { font-size: 12.5px; color: #93818d; }
.ov div:nth-child(2) { border-color: #e4d8fb; } .ov div:nth-child(2) b { color: #9079c2; }
.ov div:nth-child(3) { border-color: #d3e6fd; } .ov div:nth-child(3) b { color: #5f95d0; }
.ov div:nth-child(5) { border-color: #e4d8fb; } .ov div:nth-child(5) b { color: #9079c2; }
.trend { position: relative; display: flex; align-items: flex-end; gap: 9px; margin-top: 12px;
  padding: 10px 14px 8px; background: #fffdfeee; border: 1.5px solid #d3e6fd; border-radius: 16px;
  box-shadow: 0 2px 8px rgba(160, 180, 225, .10); }
.trend .tw { flex: 1 1 0; text-align: center; }
/* 条形最矮也留 4px：0 次的那天没有条会看不出「有这一天」。
   宽度压到 34%：60% 时最高那根会变成一个方块，像色块不像条形 */
.trend .bar { margin: 0 auto 5px; width: 34%; min-height: 4px; border-radius: 6px 6px 3px 3px;
  background: linear-gradient(180deg, #f79ac0 0%, #b6c8f5 100%); }
.trend .tn { font-size: 12px; font-weight: 700; color: #6d5b66; }
.trend .td { font-size: 11px; color: #ab99a5; }
/* 两列各套一个 div：直接把 4 个 .blk 平铺进 grid 的话，第 3 个会落到左列第二行 */
.cols { position: relative; display: grid; grid-template-columns: 1fr 1fr; gap: 14px; margin-top: 13px; align-items: start; }
.blk { padding: 13px 15px 11px; background: #fffdfeee; border: 1.5px solid #ffd9e8; border-radius: 18px;
  box-shadow: 0 2px 8px rgba(214, 158, 186, .10), 0 8px 20px rgba(160, 180, 225, .08); }
.blk.blue { border-color: #d3e6fd; }
.blk h2 { display: flex; align-items: center; gap: 7px; margin-bottom: 9px;
  font-size: 18px; font-weight: 800; color: #d96e97; }
.blk.blue h2 { color: #5f95d0; }
.it { display: flex; align-items: center; gap: 8px; padding: 5px 0; }
.it + .it { border-top: 1px dashed #ffd9e8; }
.blk.blue .it + .it { border-top-color: #d3e6fd; }
.rk { flex: 0 0 24px; font-size: 14px; font-weight: 800; color: #cfa7bb; text-align: center; }
.av { flex: 0 0 34px; display: flex; align-items: center; justify-content: center;
  width: 34px; height: 34px; overflow: hidden; background: #fff6fa; border-radius: 10px; }
.av img { max-width: 100%; max-height: 100%; object-fit: contain; }
.av.round { border-radius: 999px; }
.av.round img { width: 100%; height: 100%; object-fit: cover; }
.bd { flex: 1 1 auto; min-width: 0; }
.bd .nm { font-size: 14.5px; font-weight: 700; color: #55424d;
  overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
/* 条形长度按第一名归一化：绝对值差太大时后几名会缩成一条线，这样至少看得出比例 */
.bd .pb { height: 5px; margin-top: 4px; background: #ffeaf3; border-radius: 999px; overflow: hidden; }
.blk.blue .bd .pb { background: #e8f2ff; }
.bd .pb i { display: block; height: 100%; border-radius: 999px;
  background: linear-gradient(90deg, #f79ac0 0%, #d3b0f2 60%, #96c5fa 100%); }
.ct { flex: 0 0 auto; font-size: 14px; font-weight: 800; color: #d96e97; }
.blk.blue .ct { color: #5f95d0; }
.none { padding: 8px 2px; font-size: 13.5px; color: #93818d; }
/* 右列比左列短一截（人数通常远少于表情种类），补群榜和说明填空位 —— 同帮助图的做法 */
.blk.lilac { border-color: #e4d8fb; }
.blk.lilac h2 { color: #9079c2; }
.blk + .blk { margin-top: 14px; }
.tr { padding: 5px 0 5px 15px; font-size: 13px; color: #6d5b66; line-height: 1.5; text-indent: -15px; }
.tr + .tr { border-top: 1px dashed #e4d8fb; }
.gr { display: flex; align-items: baseline; gap: 8px; padding: 5px 0; font-size: 13.5px; }
.gr + .gr { border-top: 1px dashed #e4d8fb; }
.gr b { flex: 0 0 22px; font-weight: 800; color: #c3aee8; text-align: center; }
.gr span { flex: 1 1 auto; min-width: 0; color: #6d5b66; overflow: hidden;
  text-overflow: ellipsis; white-space: nowrap; }
/* 群号跟在真名后面一档更淡的小字：同名的群不少，光看名字未必分得清是哪个 */
.gr span em { font-style: normal; font-size: 11.5px; color: #bfaec6; }
.gr i { flex: 0 0 auto; font-style: normal; font-weight: 800; color: #9079c2; }
.ft { position: relative; margin-top: 13px; padding: 10px 16px; font-size: 14px; color: #6d5b66;
  background: linear-gradient(112deg, #ffeaf3 0%, #f4efff 50%, #e8f2ff 100%);
  border: 1.5px solid #ffd9e8; border-radius: 999px;
  box-shadow: 0 4px 12px rgba(214, 158, 186, .14); }
.ft b { font-weight: 800; color: #d96e97; }
`

/** 一行榜单 */
function row (i, dataUri, name, count, max, round) {
  const pct = max > 0 ? Math.max(4, Math.round(count / max * 100)) : 0
  return `<div class="it">
<div class="rk">${medal(i)}</div>
<div class="av${round ? ' round' : ''}">${dataUri ? `<img src="${dataUri}">` : '🌸'}</div>
<div class="bd"><div class="nm">${esc(name)}</div><div class="pb"><i style="width:${pct}%"></i></div></div>
<div class="ct">${count}</div>
</div>`
}

/**
 * 渲染用量榜
 * @param {object} s Stats.summary() / Stats.groupSummary() 的结果
 * @param {{scope?:'group'|'total', groupName?:string, groupId?:string,
 *          groupNames?:Record<string,string>}} extra
 *   scope 决定标题、概览格数、有没有群排行块；groupNames 是群号→真名的补充表
 * @returns {Promise<string>} 图片路径
 */
export async function renderStats (s, extra = {}) {
  const isGroup = extra.scope === 'group'
  const names = extra.groupNames || {}

  // 表情缩略图串行取（多半已在缓存里），头像并行抓（走外网，串行会等成一串）
  const memes = []
  for (const m of s.memes) {
    let uri = ''
    try {
      const { buffer, contentType } = await Preview.getThumb(m.key, 120)
      uri = `data:${contentType};base64,${buffer.toString('base64')}`
    } catch (err) {
      logger.debug(`${logPrefix} 榜单取缩略图失败 ${m.key}: ${err.message}`)
    }
    const kws = MemeIndex.infos[m.key]?.keywords
    memes.push({ ...m, uri, name: kws?.[0] ? `#${kws[0]}` : m.key })
  }

  // 榜单里是 28px 的小圆头像，取 100 档就够，没必要拉原图
  const avatars = await Promise.all(s.users.map(u => toDataUri(qqAvatar(u.key, 100))))

  const memeMax = s.memes[0]?.n || 0
  const userMax = s.users[0]?.n || 0
  const trendMax = Math.max(1, ...s.recent.map(r => r.n))
  const since = new Date(s.since)
  const sinceStr = `${since.getMonth() + 1}月${since.getDate()}日`

  const title = isGroup ? '🏆 本群表情榜' : '🏆 表情总榜'
  const sub = [
    isGroup && (extra.groupName || '') ? extra.groupName : '',
    `统计自 ${sinceStr} · ${s.activeDays} 天`,
    !isGroup && s.groupCount ? `${s.groupCount} 个群` : ''
  ].filter(Boolean).join(' · ')

  // 总榜多一格「参与的群」，格数变了列数要跟着变，不然第 5 格会掉到第二行
  const cells = [
    [s.total, '累计生成'],
    [s.todayCount, '今日'],
    [s.memeKinds, '用过的表情'],
    [s.userCount, '参与的人'],
    ...(isGroup ? [] : [[s.groupCount, '参与的群']])
  ]

  const emptyTip = isGroup ? '本群还没有人做过表情呢~' : '还没有人做过表情呢~'
  const tips = isGroup
    ? [
        '· 只统计本群发出去的表情，失败的不算',
        '· 每天的量看上面那排柱子，留最近 30 天',
        '· 想看所有群一起排，发 #meme总排行'
      ]
    : [
        '· 只统计真正发出去的表情，失败的不算',
        '· 每天的量看上面那排柱子，留最近 30 天',
        '· 只看本群的榜，发 #meme排行',
        '· 主人发 #meme清空统计 可以清零重来'
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
<div class="trend">
${s.recent.map(r => `<div class="tw">
<div class="bar" style="height:${Math.round(r.n / trendMax * 46) + 4}px"></div>
<div class="tn">${r.n}</div>
<div class="td">${r.day.slice(5).replace('-', '/')}</div>
</div>`).join('')}
</div>
<div class="cols">
  <div>
    <div class="blk">
      <h2><span>🎨</span>最爱用的表情</h2>
      ${memes.length
        ? memes.map((m, i) => row(i, m.uri, m.name, m.n, memeMax, false)).join('')
        : `<div class="none">${emptyTip}</div>`}
    </div>
  </div>
  <div>
    <div class="blk blue">
      <h2><span>👑</span>最能整活的人</h2>
      ${s.users.length
        ? s.users.map((u, i) => row(i, avatars[i], u.raw?.name || u.key, u.n, userMax, true)).join('')
        : `<div class="none">${emptyTip}</div>`}
    </div>
    ${!isGroup && s.groups.length > 1
      ? `<div class="blk lilac">
      <h2><span>💬</span>最活跃的群</h2>
      ${s.groups.map((g, i) => {
        const name = names[g.key] || g.name || ''
        return `<div class="gr"><b>${i + 1}</b><span>${
          name ? `${esc(name)} <em>${esc(g.key)}</em>` : esc(g.key)
        }</span><i>${g.n}</i></div>`
      }).join('')}
    </div>`
      : ''}
    <div class="blk lilac">
      <h2><span>💡</span>关于榜单</h2>
      ${tips.map(t => `<div class="tr">${esc(t)}</div>`).join('\n      ')}
    </div>
  </div>
</div>
<div class="ft">💡 <b>玩法</b>　发 #meme搜索 猫 找表情　#meme帮助 看全部用法${
  isGroup ? '' : '　·　本群榜发 #meme排行'}</div>
</body></html>`

  const dir = path.join(dataDir, 'list_cache')
  mkdirs(dir)
  const loc = path.join(dir, `stats_${Date.now()}_${process.pid}${IMG_EXT}`)
  return shotHtml(html, loc, { width: WIDTH, scale: 2.5 })
}
