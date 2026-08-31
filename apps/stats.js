import Stats from '../model/stats.js'
import MemeIndex from '../model/memeIndex.js'
import { renderStats } from '../utils/statsImage.js'
import { unlinkQuietly } from '../utils/file.js'
import { blocked } from '../utils/guard.js'
import { groupNameOf, getGroupName, getGroupNames } from '../utils/user.js'
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

/**
 * 两个榜：`#meme排行` 只看本群，`#meme总排行` 跨群一起排。
 *
 * 分开是因为群里的人只关心自己群谁最能整活 —— 把别的群的数据掺进来，
 * 本群第一名可能连前十都进不去，这榜就没人看了。群排行只出现在总榜里。
 */
export class memeStats extends plugin {
  constructor () {
    super({
      name: 'meme统计',
      dsc: '表情包用量排行',
      event: 'message',
      priority: 4000,
      rule: [
        // 总榜的正则要排在本群榜前面：虽然本群榜那条锚了 ^...$、匹配不上「总排行」，
        // 但顺序摆对了以后再加别名（全服/全部）也不会被前一条抢走
        {
          reg: '^#?meme(s)?(总|全局|全服|全部)(排行|统计|榜单?)$',
          fnc: 'total'
        },
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

  /** 本群榜 */
  async show (e) {
    if (blocked(e)) return false

    // 私聊没有「本群」可排，直接给总榜，省得回一句「请在群里发」把人堵住
    if (!e.group_id) return await this.total(e)

    return await this.showGroup(e)
  }

  async showGroup (e) {
    const s = Stats.groupSummary(e.group_id, 10)
    if (s.total === 0) {
      // 老版本只记了群总次数、没有本群明细，这种要说清楚不是数据丢了
      const old = Stats.groupTotal(e.group_id)
      await e.reply(old
        ? '本群榜是新记的，还没攒到数据；以前的量发 #meme总排行 能看到~'
        : '本群还没有人做过表情呢，发 #摸头 试试~')
      return true
    }

    // 群名：事件里现成的最省事，没有再问适配器要一次，取到就存进统计里下次直接用
    let groupName = groupNameOf(e) || s.groupName
    if (!groupName) groupName = await getGroupName(e, e.group_id)
    if (groupName) Stats.rememberGroupName(e.group_id, groupName)

    return await this.send(e, s, { scope: 'group', groupName, groupId: String(e.group_id) })
  }

  /** 跨群总榜 */
  async total (e) {
    if (blocked(e)) return false

    const s = Stats.summary(10)
    if (s.total === 0) {
      await e.reply('还没有人做过表情呢，发 #摸头 试试~')
      return true
    }

    // 榜上要显示真群名。存过的直接用，缺的（老数据、或那次生成时没拿到）问一次适配器，
    // 拿到就写回统计，下次出图不用再问
    const missing = s.groups.filter(g => !g.name).map(g => g.key)
    let groupNames = {}
    if (missing.length) {
      try {
        groupNames = await getGroupNames(e, missing)
        for (const [gid, name] of Object.entries(groupNames)) {
          Stats.rememberGroupName(gid, name)
        }
      } catch (err) {
        logger.debug(`${logPrefix} 补群名失败：${err.message}`)
      }
    }

    return await this.send(e, s, { scope: 'total', groupNames })
  }

  /** 出图，失败退回纯文字 */
  async send (e, s, extra) {
    let loc = null
    try {
      loc = await renderStats(s, extra)
    } catch (err) {
      logger.error(`${logPrefix} 榜单渲染失败：${err.message}`)
    }

    if (loc) {
      await e.reply(segment.image(`file://${loc}`))
      unlinkQuietly(loc)
      return true
    }

    // 出图失败（缺 puppeteer / 内存不足）退回纯文字，功能不受影响
    const head = extra.scope === 'group'
      ? `🏆 本群表情榜${extra.groupName ? `（${extra.groupName}）` : ''}`
      : '🏆 表情总榜'
    await e.reply([
      `${head}　累计 ${s.total} 次 · 今日 ${s.todayCount} 次`,
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
