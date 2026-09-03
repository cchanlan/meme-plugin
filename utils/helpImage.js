import path from 'node:path'
import { dataDir } from '../constants/path.js'
import { mkdirs } from './file.js'
import { shotHtml, THEME_CSS, IMG_EXT } from './browser.js'

/**
 * 帮助图（粉白蓝主题，和 Web 预览站、搜索网格图同一套配色）。
 *
 * 排成两列而不是一长条：QQ 气泡按宽、高两个上限 contain 缩放，
 * 竖长图会被高度卡住、宽度顶不满，字反而更小。两列把宽高比压到 1.2 左右最划算。
 * 即便如此缩放后字还是偏小，所以 apps/help.js 会再补一段纯文字核心指令。
 */

function esc (s) {
  return String(s).replace(/[&<>"']/g, c => (
    { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]
  ))
}

/** 一组指令卡片：icon 标题 + 若干「指令 / 说明」行 */
function block (icon, title, rows, tone = 'pink') {
  return `<section class="blk ${tone}">
<h2><span class="ic">${icon}</span>${esc(title)}</h2>
${rows.map(([cmd, desc]) => `<div class="row">
<code>${esc(cmd)}</code>${desc ? `<em>${esc(desc)}</em>` : ''}
</div>`).join('')}
</section>`
}

/** 纯文字提示卡片，用来填左列底部的空位 —— 两列行数不等，不填会空一大块 */
function tipBlock (icon, title, lines) {
  return `<section class="blk pink tips">
<h2><span class="ic">${icon}</span>${esc(title)}</h2>
${lines.map(t => `<div class="tr">${esc(t)}</div>`).join('')}
</section>`
}

const CSS = `
${THEME_CSS}
body { position: relative; width: 900px; padding: 24px 26px 20px; }
.hd { position: relative; display: flex; align-items: flex-end; gap: 12px; margin-bottom: 4px; }
.hd h1 { font-size: 34px; font-weight: 800; letter-spacing: 1px; }
.hd .sub { padding-bottom: 4px; font-size: 15px; color: #ab99a5; }
.hd .sakura { font-size: 30px; filter: drop-shadow(0 3px 6px rgba(226, 150, 184, .38)); }
.line { position: relative; height: 3px; margin: 12px 0 18px; border-radius: 999px;
  background: linear-gradient(112deg, #f79ac0 0%, #d3b0f2 34%, #b6c8f5 66%, #96c5fa 100%); opacity: .8; }
.cols { position: relative; display: grid; grid-template-columns: 1fr 1fr; gap: 16px; align-items: start; }
/* 三个色系各管一类指令：粉=做表情、蓝=找表情、紫=管理，
   靠色相区分卡片，就不用把颜色加深来拉层次 */
.blk {
  padding: 16px 18px 14px;
  background: #fffdfeee;
  border: 1.5px solid #ffd9e8;
  border-radius: 20px;
  box-shadow: 0 2px 8px rgba(214, 158, 186, .10), 0 8px 20px rgba(160, 180, 225, .09);
}
.blk + .blk { margin-top: 16px; }
.blk.blue { border-color: #d3e6fd; }
.blk.lilac { border-color: #e4d8fb; }
.blk h2 { display: flex; align-items: center; gap: 8px; margin-bottom: 10px; font-size: 20px; font-weight: 800; color: #d96e97; }
.blk.blue h2 { color: #5f95d0; }
.blk.lilac h2 { color: #9079c2; }
.blk .ic { font-size: 19px; }
.row { display: flex; align-items: baseline; gap: 9px; padding: 5px 0; line-height: 1.45; }
.row + .row { border-top: 1px dashed #ffd9e8; }
.blk.blue .row + .row { border-top-color: #d3e6fd; }
.blk.lilac .row + .row { border-top-color: #e4d8fb; }
code {
  flex: 0 0 auto; padding: 2px 9px;
  font-family: "Noto Sans CJK SC", "PingFang SC", "Microsoft YaHei", monospace;
  font-size: 17px; font-weight: 700; color: #d96e97;
  background: #ffeaf3; border-radius: 8px; white-space: nowrap;
}
.blk.blue code { color: #5f95d0; background: #e8f2ff; }
.blk.lilac code { color: #9079c2; background: #f4efff; }
em { font-size: 15px; font-style: normal; color: #6d5b66; }
.tips .tr { padding: 6px 0 6px 16px; font-size: 15px; color: #6d5b66; line-height: 1.5; text-indent: -16px; }
.tips .tr + .tr { border-top: 1px dashed #ffd9e8; }
/* 底部胶囊改淡底深字：渐变淡下来之后白字压不住，读不清 */
.ft { position: relative; margin-top: 18px; padding: 12px 18px; font-size: 16px; color: #6d5b66;
  background: linear-gradient(112deg, #ffeaf3 0%, #f4efff 50%, #e8f2ff 100%);
  border: 1.5px solid #ffd9e8; border-radius: 999px;
  box-shadow: 0 4px 14px rgba(214, 158, 186, .16); }
.ft b { font-weight: 800; color: #d96e97; }
.tip { position: relative; margin-top: 12px; font-size: 13.5px; color: #ab99a5; text-align: center; }
`

/**
 * 渲染帮助图
 * @param {{total:number, keywords:number, web?:string|null}} info
 * @returns {Promise<string>} 图片路径
 */
export async function renderHelp (info = {}) {
  const { total = 0, keywords = 0, web = null, canMake = false, local = true, fun = true } = info

  const make = block('🎨', '做表情', [
    ['#摸头', '用自己头像'],
    ['#摸头 @某人', '用对方头像'],
    ['引用图片 + #摸头', '用图里的图'],
    ['#一巴掌 笨蛋', '带文字'],
    ['#高低情商 会说话/不会说话', '多段文字用 / 隔开'],
    ['#爬#33', '带参数，# 后面写参数值'],
    ['#摸头详情', '出图看支持哪些参数'],
    ['#摸头帮助', '同上，两种写法都行']
  ])

  const find = block('🔍', '找表情', [
    ['#meme搜索 猫', '出预览图，认关键词/分类/代码'],
    ['#meme列表', '随机翻一页，可加页码'],
    ['#meme分类', '列出全部分类'],
    ['#meme分类 鸣潮', '出该分类的预览图'],
    ['#随机meme', '随机来一个'],
    ['#meme新增', '最近装上的表情'],
    ['#meme排行', '本群用量榜，谁最能整活'],
    ['#meme总排行', '所有群一起排']
  ], 'blue')

  // 用外部 meme 服务时，更新和部署都不是这台机器的事，文案得跟着变，
  // 不然主人会以为 #meme更新 能把服务方的仓库也拉过来
  const admin = block('🔧', '管理 · 群管/主人', [
    ['#meme开启 / #meme关闭', '本群开关，群管可用'],
    ['#meme更新', local ? '拉新表情并热加载' : '同步服务方的新表情'],
    ['#meme刷新', '只重建索引'],
    ['#meme部署状态', '查服务健康度'],
    ['#meme清缓存', '清空预览图缓存'],
    ['#meme插件更新', '更新插件本体，非表情'],
    ...(local ? [['#meme部署 / #meme卸载', '本机装一套 meme 服务 / 卸掉']] : [])
  ], 'lilac')

  // 整活玩法能关（enableFun），关掉了就别在帮助里指一条不响应的路
  const play = fun
    ? block('🎪', '随机整活', [
        ['#抽个cp', '随机两个群友配个双人表情'],
        ['#抽个cp @张三', '指定一位，另一位随机'],
        ['#整活 @某人', '连出好几个表情，合并转发发原图'],
        ['#套娃 摸头 踩', '头像一层层叠进表情里'],
        ['#全群摸头', '随机几个群友一起做表情'],
        ['#今日表情', '今天固定的表情 + 一句运势'],
        ['#猜表情', '出题让群友猜名字，答对得分']
      ], 'lilac')
    : ''

  const tips = tipBlock('💡', '小贴士', [
    '· 表情名认全部别名，「摸鱼」不会被「摸」抢走',
    '· 搜索超过 8 个时会另发文字版名字，方便复制',
    '· 排行榜只记真正发出去的表情，失败的不算',
    '· #meme更新 拉的是表情，更新插件本体要发 #meme插件更新',
    '· 想一次看全部表情，上面的在线预览站最清楚'
  ])

  const html = `<!DOCTYPE html><html><head><meta charset="utf-8"><style>${CSS}</style></head><body>
<div class="hd">
  <span class="sakura">🌸</span>
  <h1 class="grad-text">表情包大全</h1>
  <span class="sub">${total} 个表情 · ${keywords} 个关键词</span>
</div>
<div class="line"></div>
<div class="cols">
  <div>${make}${tips}</div>
  <div>${find}${play}${admin}</div>
</div>
${web ? `<div class="ft">🌟 <b>在线预览</b>　${esc(web)}　—— 看图挑表情，点一下复制指令${canMake ? '，还能直接在线出图' : ''}</div>` : ''}
<div class="tip">指令前缀 # 可在配置里关掉 · 表情名支持全部别名</div>
</body></html>`

  const dir = path.join(dataDir, 'list_cache')
  mkdirs(dir)
  const loc = path.join(dir, `help_${Date.now()}_${process.pid}${IMG_EXT}`)
  // scale 2.5：帮助图字多，缩放后要点开还能看清；webp 下这个分辨率仍比原来 jpeg 小
  return shotHtml(html, loc, { width: 900, scale: 2.5 })
}

