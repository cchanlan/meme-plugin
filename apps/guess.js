import Config from '../model/config.js'
import MemeIndex from '../model/memeIndex.js'
import Stats from '../model/stats.js'
import GuessGame from '../model/guessGame.js'
import { avatarBuffer, makeOne, replyImage } from '../utils/memeMake.js'
import { safePool, pickSome, dropProtectedIfMaster } from '../utils/funPool.js'
import { renderGuessRank } from '../utils/guessImage.js'
import { unlinkQuietly } from '../utils/file.js'
import { blocked, emptyIndexTip } from '../utils/guard.js'
import { getMemberInfo, groupNameOf, getGroupName, getGroupNames } from '../utils/user.js'
import { logPrefix } from '../constants/path.js'

/**
 * #猜表情 —— 出一张用发起人头像做的表情，谁先说出它的名字谁得一分。
 *
 * 题库只用「零文字」表情：带 default_texts 的表情，预览/成图会把默认文字
 * 直接印在图里（实测「急急国王」的图自带「我是急急国王」），答案就写在画上了。
 * （关键字的判定走 exact match，不包含判断 —— 「摸」这种单字名不能靠聊天蒙对。）
 */
export class memeGuess extends plugin {
  constructor () {
    super({
      name: 'meme猜表情',
      dsc: '看图猜表情名，答对得分',
      event: 'message',
      /**
       * 抢在所有插件之前。
       *
       * 答题的人打的是**表情名**，而表情名里混着一堆别的插件的指令词
       * （实测撞车的有「摸鱼」「晚安」「疯狂星期四」「复读」，还有 64 个单字名
       * 像「摸」「踩」「贴」）。放在 4500 的话，priority 更小的插件
       * （大部分是 0~2000）会先把这句话抢走 —— 人猜对了却不算分，
       * 还顺带触发了别人的功能。所以要最先判定：是答案就吃掉，不是就立刻放行。
       *
       * 代价是每条消息都先过一遍 answer()，所以那个函数里**第一步必须是同步查 Map**，
       * 没有进行中的题目立刻 return false，不做任何 await。
       */
      priority: -2000,
      rule: [
        {
          // 「总/全服/全部/全局」要放在「排行」前面才匹配得上 #猜表情总排行
          reg: '^#?猜表情((总|全服|全部|全局)?(排行|统计|榜单?))?$',
          fnc: 'start'
        },
        {
          // 空正则匹配一切：有进行中的局就当答题消息处理，没有就立刻放行。
          // log:false 是必须的 —— Yunzai 在「规则命中」时就会打一行「[开始处理]」，
          // 不关的话每条群消息都多一行 meme猜表情(answer)，实测 15 分钟刷 60 多条
          reg: '',
          log: false,
          fnc: 'answer'
        }
      ]
    })
  }

  /** 一局的答案文字（第一个关键词） */
  answerText (game) {
    return MemeIndex.infos[game.code]?.keywords?.[0] || game.code
  }

  async start (e) {
    if (blocked(e)) return false
    if (!Config.get('enableGuess')) return false
    // 排行不带开关：猜都让玩了，凭什么不让看榜
    if (/排行|统计|榜单?/.test(e.msg)) return await this.ranking(e)

    if (MemeIndex.isEmpty) {
      await e.reply(emptyIndexTip())
      return true
    }

    // 已经有一局在跑就别开新的：直接覆盖会把上一局的超时定时器留在那儿空转，
    // 而且刚出的题还没人猜就被顶掉了
    const running = GuessGame.current(e)
    if (running) {
      const left = Math.ceil(
        ((parseInt(Config.get('guessTimeout')) || 60) * 1000 - (Date.now() - running.startedAt)) / 1000
      )
      await e.reply(`上一题还没猜出来呢~ 还有 ${Math.max(left, 1)} 秒`, true)
      return true
    }

    let pool = safePool(
      MemeIndex.randomCandidates().filter(code => {
        const pt = MemeIndex.infos[code]?.params_type
        return pt && pt.max_texts === 0
      })
    )
    pool = await dropProtectedIfMaster(pool, [e.user_id])
    if (!pool.length) {
      await e.reply('没有能用来出题的表情了 —— 看看 blackMemes / funExcludeWords 是不是把它们全过滤了')
      return true
    }

    // 依次试几个：个别表情会被服务端拒（533/541），一次失败就换下一个
    const buffer = await avatarBuffer(e, e.sender.user_id)
    if (!buffer) {
      await e.reply('头像下不下来，稍后再试试~', true)
      return true
    }
    const info = await getMemberInfo(e, e.sender.user_id)

    let made = null
    for (const code of pickSome(pool, 3)) {
      const res = await makeOne(code, [buffer], [info])
      if (!res.ok) {
        logger.error(`${logPrefix} 猜表情 生成 ${code} 失败: ${res.error}`)
        continue
      }
      made = { code, buffer: res.buffer, contentType: res.contentType }
      break
    }
    if (!made) {
      await e.reply('连试了几个表情都没成，八成是 meme 服务那边不舒服，发 #meme部署状态 看看', true)
      return true
    }

    Stats.record({
      code: made.code,
      userId: e.user_id,
      groupId: e.group_id,
      groupName: groupNameOf(e),
      name: e.sender.card || e.sender.nickname
    })

    const timeout = (parseInt(Config.get('guessTimeout')) || 60) * 1000
    const game = { code: made.code, keywords: MemeIndex.infos[made.code]?.keywords || [] }
    // 超时公布答案。timer 挂在题目上，答对时要把它撤掉
    const ev = e
    game.timer = setTimeout(() => {
      const cur = GuessGame.current(ev)
      if (!cur || cur.code !== game.code) return
      GuessGame.finish(ev)
      ev.reply(`⏰ 没人猜出来~ 答案是 #${this.answerText(game)}，下次手快一点！`)
    }, timeout)

    GuessGame.start(e, game)

    await replyImage(e, made.buffer,
      `🔍 ${timeout / 1000} 秒内猜出这是什么表情，直接发名字，答对得一分！`,
      made.contentType)
    return true
  }

  /**
   * 每条消息都会走到这里 —— 全插件最热的路。
   *
   * 第一步必须是**同步查一次内存 Map**：没有进行中的题目就立刻 return false 放行，
   * 不读配置、不做 await。只有确实在玩的那 60 秒里才会往下走。
   *
   * 判定成功时 return true 把这句话吃掉，别的插件就收不到了 —— 这是故意的：
   * 表情名里混着一堆别人的指令词（「摸鱼」「晚安」「疯狂星期四」「复读」，
   * 还有 64 个单字名），猜对的那句要是继续往下传，就会顺带触发别人的功能。
   */
  async answer (e) {
    const game = GuessGame.current(e)
    if (!game) return false

    // 下面这几道才读配置：能开出局说明当时是允许的，但中途可能被拉黑/关群开关
    if (!Config.get('enableGuess')) return false
    if (blocked(e)) return false

    // 只把整句话当答案（顺手削掉可能带的 #）。
    // 不做「按空格切词逐个试」——那样随便聊天蒙中的概率太高，猜对就不值钱了
    const msg = String(e.msg || '').replace(/^#/, '').trim()
    if (!GuessGame.isAnswer(game, msg)) return false

    // 答对了：撤掉超时定时器、收局、计分
    GuessGame.finish(e)
    GuessGame.record({
      userId: e.user_id,
      groupId: e.group_id,
      groupName: groupNameOf(e),
      name: e.sender.card || e.sender.nickname
    })
    const score = GuessGame.userScore(e.group_id, e.user_id)
    await e.reply(`🎉 答对啦！是 #${this.answerText(game)}，${score} 分了~`, true)
    return true
  }

  /**
   * 猜表情榜。出图，失败退回纯文字（同 #meme排行 的做法）。
   * 本群榜 / 加「总」看跨群。
   */
  async ranking (e) {
    if (blocked(e)) return false
    // 私聊没有「本群」可排，直接给总榜，省得回一句「请在群里发」把人堵住
    const total = /总|全服|全部|全局/.test(e.msg) || !e.group_id
    const s = total
      ? GuessGame.summary(10)
      : GuessGame.groupSummary(e.group_id, 10)

    if (!s.users.length) {
      await e.reply(total
        ? '还没有人猜对过~ 发 #猜表情 开第一局吧'
        : '本群还没有人猜对过~ 发 #猜表情 开第一局吧')
      return true
    }

    const extra = { scope: total ? 'total' : 'group' }
    if (total) {
      // 榜上要显示真群名。存过的直接用，缺的问一次适配器
      const missing = s.groups.filter(g => !g.name).map(g => g.key)
      if (missing.length) {
        try {
          extra.groupNames = await getGroupNames(e, missing)
        } catch (err) {
          logger.debug(`${logPrefix} 补群名失败：${err.message}`)
        }
      }
    } else {
      // 群名：事件里现成的最省事，没有再问适配器要一次
      s.groupName = groupNameOf(e) || s.groupName || await getGroupName(e, e.group_id)
    }

    let loc = null
    try {
      loc = await renderGuessRank(s, extra)
    } catch (err) {
      logger.error(`${logPrefix} 猜表情榜渲染失败：${err.message}`)
    }
    if (loc) {
      await e.reply(segment.image(`file://${loc}`))
      unlinkQuietly(loc)
      return true
    }

    // 出图失败（缺 puppeteer / 内存不足）退回纯文字，功能不受影响
    const lines = total
      ? [
          '🏆 猜表情总榜',
          `共 ${s.total} 次答对 · ${s.userCount} 人参与`,
          '',
          ...s.users.map((u, i) => `${i + 1}. ${u.name || u.key} ${u.n}分`)
        ]
      : [
          `🏆 ${s.groupName || '本群'} 猜表情排行`,
          `共答对 ${s.total} 次 · ${s.userCount} 人参与`,
          '',
          ...s.users.map((u, i) => `${i + 1}. ${u.name || u.key} ${u.n}分`),
          '',
          '发 #猜表情 开一局，发 #猜表情总排行 看全服榜'
        ]
    if (total && s.groups.length) {
      lines.push('', `最能猜的群：${s.groups.slice(0, 3).map(g => g.name || g.key).join('、')}`)
    }
    await e.reply(lines.join('\n'))
    return true
  }
}
