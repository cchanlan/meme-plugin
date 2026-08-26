import Stats from '../model/stats.js'
import MemeIndex from '../model/memeIndex.js'
import { renderStats } from '../utils/statsImage.js'
import { unlinkQuietly } from '../utils/file.js'
import { blocked } from '../utils/guard.js'
import { logPrefix } from '../constants/path.js'

/** 出图失败时的纯文字兜底：只列榜单前 N 名 */
function topLine (s) {
  const lines = []
  if (s.memes.length) {
    lines.push('🎨 ' + s.memes.slice(0, 5).map((m, i) => {
      const kws = MemeIndex.infos[m.key]?.keywords
      return `${i + 1}.${kws?.[0] ? '#' + kws[0] : m.key} ${m.n}次`
    }).join('　'))
  }
  if (s.users.length) {
    lines.push('👑 ' + s.users.slice(0, 3).map((u, i) =>
      `${i + 1}.${u.raw?.name || u.key} ${u.n}次`).join('　'))
  }
  return lines.join('\n')
}

export class memeStats extends plugin {
  constructor () {
    super({
      name: 'meme统计',
      dsc: '表情包用量排行',
      event: 'message',
      priority: 4000,
      rule: [
        {
          reg: '^#?meme(s)?(排行|统计|榜单?)$',
          fnc: 'show'
        },
        {
          reg: '^#?meme(s)?(清空|重置)统计$',
          fnc: 'reset',
          permission: 'master'
        }
      ]
    })
  }

  async show (e) {
    if (blocked(e)) return false

    const s = Stats.summary(10)
    if (s.total === 0) {
      await e.reply('还没有人做过表情呢，发 #摸头 试试~')
      return true
    }

    let loc = null
    try {
      loc = await renderStats(s, {
        groupCount: e.group_id ? Stats.groupTotal(e.group_id) : 0
      })
    } catch (err) {
      logger.error(`${logPrefix} 榜单渲染失败：${err.message}`)
    }

    if (loc) {
      await e.reply(segment.image(`file://${loc}`))
      unlinkQuietly(loc)
      return true
    }

    // 出图失败（缺 puppeteer / 内存不足）退回纯文字，功能不受影响
    await e.reply([
      `🏆 表情用量榜（累计 ${s.total} 次 · 今日 ${s.todayCount} 次）`,
      `用过 ${s.memeKinds} 个表情 · ${s.userCount} 人参与`,
      topLine(s)
    ].filter(Boolean).join('\n'))
    return true
  }

  async reset (e) {
    const before = Stats.reset()
    await e.reply(`🧹 统计已清空（原有 ${before} 次记录）`)
    return true
  }
}
