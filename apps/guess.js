import Config from '../model/config.js'
import MemeIndex from '../model/memeIndex.js'
import Stats from '../model/stats.js'
import GuessGame from '../model/guessGame.js'
import { avatarBuffer, makeOne, nameOf, replyImage } from '../utils/memeMake.js'
import { safePool, pickSome, dropProtectedIfMaster } from '../utils/funPool.js'
import { blocked, emptyIndexTip } from '../utils/guard.js'
import { getMemberInfo, groupNameOf } from '../utils/user.js'
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
      // 要拦「每条消息」，必须在 memeMaker（5000）之前
      priority: 4500,
      rule: [
        {
          reg: '^#?猜表情(排行|榜单?)?$',
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
    if (/排行|榜单?/.test(e.msg)) return await this.ranking(e)

    if (MemeIndex.isEmpty) {
      await e.reply(emptyIndexTip())
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
   * 每条消息都会走到这里。没局在跑时必须**同步返回 false 放行** ——
   * 这里是全插件最热的路，一点点 awaited 延迟都会拖慢所有别的指令。
   */
  async answer (e) {
    if (!Config.get('enableGuess')) return false

    const game = GuessGame.current(e)
    if (!game) return false

    // 只把整句话当答案（前面顺手削掉可能带的 #）。
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

  /** 纯文字榜：本群前 10，带「总」看跨群 */
  async ranking (e) {
    if (blocked(e)) return false
    const total = /总|全服|全部|全局/.test(e.msg)
    const s = total
      ? GuessGame.summary(10)
      : GuessGame.groupSummary(e.group_id, 10)

    if (!s.users.length) {
      await e.reply(total
        ? '还没有人猜对过~ 发 #猜表情 开第一局吧'
        : '本群还没有人猜对过~ 发 #猜表情 开第一局吧')
      return true
    }

    // 死路：私聊发 #猜表情排行 没有群可看，改成看自己总共猜对几次
    if (!e.group_id) {
      const mine = GuessGame.userScore(e.group_id, e.user_id)
      await e.reply(`你总共猜对过 ${mine} 次~ 想知道全服谁最能猜，发 #猜表情总排行 看看`)
      return true
    }

    if (total) {
      const lines = [
        '🏆 猜表情总榜',
        `共 ${s.total} 次答对 · ${s.userCount} 人参与`,
        '',
        ...s.users.map((u, i) => `${i + 1}. ${u.name || u.key} ${u.n}分`)
      ]
      if (s.groups.length) {
        lines.push('', `最能猜的群：${s.groups.slice(0, 3).map(g => g.name || g.key).join('、')}`)
      }
      await e.reply(lines.join('\n'))
      return true
    }

    const groupName = s.groupName || '本群'
    const lines = [
      `🏆 ${groupName} 猜表情排行`,
      `共答对 ${s.total} 次 · ${s.userCount} 人参与`,
      '',
      ...s.users.map((u, i) => `${i + 1}. ${u.name || u.key} ${u.n}分`),
      '',
      '发 #猜表情 开一局，发 #猜表情总排行 看全服榜'
    ]
    await e.reply(lines.join('\n'))
    return true
  }
}
