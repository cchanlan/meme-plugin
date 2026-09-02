import fs from 'node:fs'
import _ from 'lodash'
import Config from '../model/config.js'
import MemeIndex from '../model/memeIndex.js'
import Preview from '../model/preview.js'
import Stats from '../model/stats.js'
import { isBlackUser } from '../utils/black.js'
import { coolLeft, markCool } from '../utils/cooldown.js'
import { avatarBuffer, makeOne, nameOf, replyImage, mapLimit } from '../utils/memeMake.js'
import { runNest, parseSteps, nestable, nestCandidates } from '../utils/nest.js'
import { pickDaily } from '../utils/daily.js'
import { safePool, pickSome, dropProtectedIfMaster } from '../utils/funPool.js'
import { renderGrid } from '../utils/gridImage.js'
import { blocked, emptyIndexTip } from '../utils/guard.js'
import { getMemberList, getMemberInfo, groupNameOf } from '../utils/user.js'
import { dataPath, ensureDir, uniqueName, unlinkQuietly } from '../utils/file.js'
import { logPrefix } from '../constants/path.js'

/**
 * 「整活」网格的列数。
 *
 * 不用 renderGrid 默认的 bestColumns：那个是按 QQ 气泡的宽高比找列数下界，
 * 给 6 个会挑 4 列 —— 出图就是 4 + 2，最后一行空着两格，很难看。
 * 这里的格子数是自己定的（1~9），优先挑能整除的列数，让每一行都填满。
 */
function gridColumns (n) {
  if (n <= 5) return n
  if (n % 3 === 0) return 3
  if (n % 4 === 0) return 4
  // 7 这种（>5 的质数）整不齐，交回 renderGrid 自己挑
  return undefined
}

export class memeFun extends plugin {
  constructor () {
    super({
      name: 'meme整活',
      dsc: '抽CP、表情轰炸这类随机整活玩法',
      event: 'message',
      priority: 4000,
      rule: [
        {
          // 后面允许跟 @：各适配器对 at 段要不要在 e.msg 里留「@昵称」各行其是，
          // 用 $ 锚死会让 `#抽个cp @张三` 匹配不上（这坑在 #meme列表 上踩过一次）
          reg: '^#?(抽个?|随机)[cC][pP](?=$|[\\s@])',
          fnc: 'randomCp'
        },
        {
          reg: '^#?(整活|表情轰炸|meme整活)(?=$|[\\s@])',
          fnc: 'combo'
        },
        {
          reg: '^#?(随机)?套娃(?=$|[\\s@])',
          fnc: 'nest'
        },
        {
          // 全群/全员/全体，后面跟表情名（支持中文关键词和英文 code）
          reg: '^#?(全群|全员|全体)(.+)$',
          fnc: 'crowd'
        },
        {
          reg: '^#?(今日表情|今日运势|每日表情)(?=$|[\\s@])',
          fnc: 'daily'
        }
      ]
    })
  }

  /**
   * 玩法的公共前置检查。
   * @returns {Promise<null|boolean>} null 表示可以继续；否则把这个值直接 return 给 Yunzai
   *          （false = 静默放行给别的插件，true = 已经回过话了）
   */
  async precheck (e, kind) {
    // 拉黑的人、关掉表情的群、整活功能被关掉，都静默放行，不回提示
    if (blocked(e)) return false
    if (!Config.get('enableFun')) return false
    if (MemeIndex.isEmpty) {
      await e.reply(emptyIndexTip())
      return true
    }
    const scope = `${kind}:${e.group_id || e.user_id}`
    const left = coolLeft(scope)
    if (left > 0) {
      await e.reply(`喘口气~ ${left} 秒后再来`, true)
      return true
    }
    // 冷却在**开始时**就记上，而不是等出图成功。这两条一次要跑好几次生成，
    // 等成功再记的话，连点几下就有好几轮同时在打 meme 服务 —— 冷却要防的正是这个
    markCool(scope, Config.get('funCooldown'))
    return null
  }

  /**
   * #抽个cp —— 随机两个群友 + 随机一个双人表情。
   * 可以 @ 一个人（另一位随机）或 @ 两个人（就用这两位）。
   */
  async randomCp (e) {
    const stop = await this.precheck(e, 'cp')
    if (stop !== null) return stop

    const ats = e.message.filter(m => m.type === 'at').map(m => String(m.qq))
    let uids = _.uniq(ats).slice(0, 2)

    if (uids.length < 2) {
      const members = await getMemberList(e)
      // 已经 @ 到的人和被拉黑的人不进随机池
      const rest = members.filter(id => !uids.includes(id) && !isBlackUser(id))
      uids = _.uniq([...uids, ...pickSome(rest, 2 - uids.length)])
      // 拿不到群成员名单（私聊、官方 bot、缓存还没热）时只能拿发起人凑一个
      if (uids.length < 2 && !uids.includes(String(e.sender.user_id))) {
        uids.push(String(e.sender.user_id))
      }
    }
    if (uids.length < 2) {
      await e.reply('这儿凑不出两个人呀~ 在群里发，或者直接 @ 两个人：#抽个cp @张三 @李四', true)
      return true
    }

    let pool = safePool(MemeIndex.pairCandidates())
    pool = await dropProtectedIfMaster(pool, uids)
    if (!pool.length) {
      await e.reply('没有能用的双人表情了 —— 看看 blackMemes / funExcludeWords 是不是把它们全过滤了')
      return true
    }

    const buffers = await Promise.all(uids.map(uid => avatarBuffer(e, uid)))
    if (buffers.some(b => !b)) {
      await e.reply('头像下不下来，稍后再试试~', true)
      return true
    }
    const infos = await Promise.all(uids.map(uid => getMemberInfo(e, uid)))

    // 依次试最多 3 个：个别表情对图片有额外要求（服务端 533/541），
    // 一次失败就报错太扫兴，换一个继续
    for (const code of pickSome(pool, 3)) {
      const res = await makeOne(code, buffers, infos)
      if (!res.ok) {
        logger.error(`${logPrefix} 抽CP 生成 ${code} 失败: ${res.error}`)
        continue
      }
      Stats.record({
        code,
        userId: e.user_id,
        groupId: e.group_id,
        groupName: groupNameOf(e),
        name: e.sender.card || e.sender.nickname
      })
      const names = infos.map(i => _.trim(i.text, '@'))
      // 图里没有任何文字，所以「谁 × 谁」「用的哪个表情」只能靠这一行；
      // 发的就是原图，动图本来会动，不用再教人怎么拿动图
      await replyImage(e, res.buffer, `💞 ${names[0]} × ${names[1]}　·　#${nameOf(code)}`, res.contentType)
      return true
    }

    await e.reply('连试了几个表情都没成，八成是 meme 服务那边不舒服，发 #meme部署状态 看看', true)
    return true
  }

  /**
   * #整活 @某人 —— 拿一个人的头像连做 N 个随机表情，拼成一张网格图。
   * 头像只下一次，N 次生成复用同一个 buffer。
   */
  async combo (e) {
    const stop = await this.precheck(e, 'combo')
    if (stop !== null) return stop

    const at = e.message.find(m => m.type === 'at')
    const uid = String(at?.qq || e.sender.user_id)
    // 上限 9：QQ 气泡里一张图最宽约 420px，8 格已经是「名字还读得清」的边界
    const n = _.clamp(parseInt(Config.get('comboCount')) || 6, 1, 9)

    let pool = safePool(MemeIndex.randomCandidates())
    pool = await dropProtectedIfMaster(pool, [uid])
    if (!pool.length) {
      await e.reply('没有能用的单图表情了 —— 看看 blackMemes / funExcludeWords 是不是把它们全过滤了')
      return true
    }

    const buffer = await avatarBuffer(e, uid)
    if (!buffer) {
      await e.reply('头像下不下来，稍后再试试~', true)
      return true
    }
    const info = await getMemberInfo(e, uid, at?.text)
    const who = _.trim(info.text, '@')

    // 多抽几个当备胎：个别表情会被服务端拒（533/552），凑不满格子就难看了
    const codes = pickSome(pool, Math.min(n + 3, pool.length))
    await e.reply(`🎪 正在给 ${who} 整 ${n} 个活，稍等…`, true)

    const done = []
    await mapLimit(codes, 2, async code => {
      // 够数就不再往下做，备胎只在真有失败时才用上。
      // 并发 2 时两个 worker 可能同时穿过这一判断，所以下面还要 slice 一次
      if (done.length >= n) return
      const res = await makeOne(code, [buffer], [info])
      if (!res.ok) {
        logger.error(`${logPrefix} 整活 生成 ${code} 失败: ${res.error}`)
        return
      }
      done.push({ code, buffer: res.buffer, contentType: res.contentType })
    })

    const picked = done.slice(0, n)
    if (!picked.length) {
      await e.reply('一个都没做出来，发 #meme部署状态 看看服务还好吗', true)
      return true
    }

    for (const d of picked) {
      Stats.record({
        code: d.code,
        userId: e.user_id,
        groupId: e.group_id,
        groupName: groupNameOf(e),
        name: e.sender.card || e.sender.nickname
      })
    }

    // 优先合并转发发原图 —— 拼图只能是首帧，动图表情在里头是不动的（一眼假）。
    // 转发失败（适配器不支持、图太多太大）再退回一张网格图
    if (Config.get('comboForward') && await this.sendForward(e, who, picked)) return true
    await this.sendGrid(e, who, picked)
    return true
  }

  /**
   * 合并转发：每张原图一条，动图能动。
   *
   * @returns {Promise<boolean>} 发出去了返回 true；不支持/太大/出错返回 false 让调用方退回网格图
   */
  async sendForward (e, who, picked) {
    const total = picked.reduce((s, d) => s + d.buffer.length, 0)
    // 一条合并转发整体过大会被服务端拒（实测十几 MB 那量级就发不出去），
    // 与其失败不如退回网格图。9 张最坏情况约 12MB，所以这道判断是会真的用上的
    if (total > 10 * 1024 * 1024) {
      logger.mark(`${logPrefix} 整活结果共 ${(total / 1048576).toFixed(1)}MB，改用网格图`)
      return false
    }

    const locs = []
    try {
      ensureDir('result')
      const nodes = picked.map(d => {
        const loc = dataPath('result', uniqueName(d.contentType.split('/')[1] || 'gif'))
        fs.writeFileSync(loc, d.buffer)
        locs.push(loc)
        return [`#${nameOf(d.code)}\n`, segment.image(`file://${loc}`)]
      })
      const common = (await import('../../../lib/common/common.js')).default
      const forward = await common.makeForwardMsg(e, nodes, `🎪 ${who} 的整活现场`)
      // 只发转发本身：每条节点开头就是 #表情名，外面再列一遍名字纯属刷屏
      await e.reply(forward)
      return true
    } catch (err) {
      // 官方 bot 之类没有 makeForwardMsg 的平台会走到这儿
      logger.error(`${logPrefix} 整活合并转发失败，改用网格图: ${err.message}`)
      return false
    } finally {
      // 和 apps/meme.js 一样：reply 返回时图已经上传完了，直接删。
      // 万一漏了也有 cleanupStale 兜底
      for (const loc of locs) unlinkQuietly(loc)
    }
  }

  /** 一张网格图：转发不可用时的退路，也是 comboForward 关掉后的默认样子 */
  async sendGrid (e, who, picked) {
    // 结果图是 gif、平均几百 KB，原样内联进 HTML 会让 puppeteer 解析好几秒，
    // 所以统一压成 webp 首帧再拼 —— 网格里没法动，这也是默认走转发的原因
    const items = await Promise.all(picked.map(async d => {
      const small = await Preview.shrink(d.buffer, 200, d.contentType)
      return {
        key: d.code,
        label: '#' + nameOf(d.code),
        dataUri: `data:${small.contentType};base64,${small.buffer.toString('base64')}`
      }
    }))

    let loc
    try {
      loc = await renderGrid(items, {
        title: `${who} 的整活现场`,
        footer: `随机 ${items.length} 个表情　·　动图版要照名字单独发一次`,
        columns: gridColumns(items.length)
      })
      // 只发图：最多 9 格、每格都印着 #表情名 且清晰可读（搜索那边格子多到
      // 字只剩几个像素才需要另发一份文字版），再列一遍就是重复
      await e.reply(segment.image(`file://${loc}`))
    } catch (err) {
      logger.error(`${logPrefix} 整活拼图失败: ${err.message}`)
      // 拼图这一步也挂了（缺 puppeteer / 内存不足）就别浪费已经做好的图，
      // 挑第一张发出去，动图还是动的
      await replyImage(e, picked[0].buffer,
        `拼图失败了（${err.message}），先给一张：#${nameOf(picked[0].code)}`,
        picked[0].contentType)
    } finally {
      if (loc) unlinkQuietly(loc)
    }
  }

  /**
   * #套娃 表情1 表情2 … @某人 —— 把头像套进第一个表情，成品再套下一个，
   * 一层层叠起来。什么都不写就随机抽表情。
   *
   * 每层必须是「正好一张图、零文字」的表情（要文字的表情没法在上一步
   * 的成品上再加字）。动图套多了体积会爆，`nestMaxSize` 卡一道，
   * 内容上安全池 + masterProtect 照旧。
   */
  async nest (e) {
    const stop = await this.precheck(e, 'nest')
    if (stop !== null) return stop

    const at = e.message.find(m => m.type === 'at')
    const uid = String(at?.qq || e.sender.user_id)

    const maxSteps = _.clamp(parseInt(Config.get('nestMaxSteps')) || 3, 1, 5)
    const rest = e.msg.replace(/^#?(随机)?套娃/, '').trim()

    let codes = []
    let spare = []
    let autoPick = false
    if (rest) {
      // 点名了：逐词解析，认不出的马上报人话，免得做完一半才发现有一个错了
      const r = parseSteps(rest)
      if (r.bad) {
        await e.reply(`「${r.bad}」不是表情名呀~ 发 #meme搜索 ${r.bad} 找找，或者直接写英文名`, true)
        return true
      }
      codes = r.codes
      const bad = codes.find(c => !nestable(c))
      if (bad) {
        await e.reply(`#${nameOf(bad)} 要配文字或用好几张图，叠不进去哦~`, true)
        return true
      }
      if (codes.length > maxSteps) {
        await e.reply(`最多叠 ${maxSteps} 层哦，叠多了图会大到发不出去`, true)
        return true
      }
    } else {
      // 没点名：随机替主人挑。随机玩法带 safety 是底线（同 #整活）
      let pool = safePool(nestCandidates())
      pool = await dropProtectedIfMaster(pool, [uid])
      if (!pool.length) {
        await e.reply('没有能用的表情了 —— 看看 blackMemes / funExcludeWords 是不是把它们全过滤了')
        return true
      }
      // 多抽一批当备胎：静态模板会把动画压平（约占池子 13%），
      // 撞上就换一个重做，不然三层链有近四成概率半路变成静态图
      const wanted = Math.min(maxSteps, pool.length)
      const all = pickSome(pool, Math.min(wanted + 6, pool.length))
      codes = all.slice(0, wanted)
      spare = all.slice(wanted)
      autoPick = true
    }

    const buffer = await avatarBuffer(e, uid)
    if (!buffer) {
      await e.reply('头像下不下来，稍后再试试~', true)
      return true
    }
    const info = await getMemberInfo(e, uid, at?.text)
    const who = _.trim(info.text, '@')
    await e.reply(`🎪 正在给 ${who} 叠表情（最多 ${maxSteps} 层），稍等…`, true)

    const { steps, stopped } = await runNest(buffer, codes, [info], {
      maxBytes: (Config.get('nestMaxSize') || 4) * 1024 * 1024,
      spare,
      autoPick
    })
    if (!steps.length) {
      await e.reply('一层都没叠上，发 #meme部署状态 看看服务还好吗', true)
      return true
    }
    for (const s of steps) {
      Stats.record({
        code: s.code,
        userId: e.user_id,
        groupId: e.group_id,
        groupName: groupNameOf(e),
        name: e.sender.card || e.sender.nickname
      })
    }

    // 中途收手的原因（体积到顶、某层失败）单独一句说清，不混进图里
    const tip = stopped ? `（${stopped}）` : ''
    const title = `🎪 ${who} 的套娃现场`
    const locs = []
    try {
      ensureDir('result')
      // 节点顺序就是演变过程：原头像 → 第1层 → 第2层 → …
      const srcLoc = dataPath('result', uniqueName('jpg'))
      fs.writeFileSync(srcLoc, buffer)
      locs.push(srcLoc)
      const chain = [
        ['原图\n', segment.image(`file://${srcLoc}`)],
        ...steps.map(s => {
          const loc = dataPath('result', uniqueName(s.contentType.split('/')[1] || 'gif'))
          fs.writeFileSync(loc, s.buffer)
          locs.push(loc)
          return [`#${nameOf(s.code)}\n`, segment.image(`file://${loc}`)]
        })
      ]
      const common = (await import('../../../lib/common/common.js')).default
      const forward = await common.makeForwardMsg(e, chain, title)
      await e.reply(forward)
      if (tip) await e.reply(tip)
    } catch (err) {
      logger.error(`${logPrefix} 套娃合并转发失败: ${err.message}`)
      // 转发这条路挂了就退回最后一张成品
      await replyImage(e, steps[steps.length - 1].buffer,
        `叠了 ${steps.length} 层：${steps.map(s => '#' + nameOf(s.code)).join(' → ')}${tip}`,
        steps[steps.length - 1].contentType)
    } finally {
      for (const loc of locs) unlinkQuietly(loc)
    }
    return true
  }

  /**
   * #全群摸头 —— 同一表情，随机 N 个群友的头像各做一张，拼一张网格图。
   * 只在群里能玩（私聊凑不出人来）。
   */
  async crowd (e) {
    const stop = await this.precheck(e, 'crowd')
    if (stop !== null) return stop

    if (!e.group_id) {
      await e.reply('这个要在群里玩哦~', true)
      return true
    }

    const rest = e.msg.replace(/^#?(全群|全员|全体)/, '').trim()
    const hit = MemeIndex.match(rest)
    if (!hit) {
      await e.reply('没认出要做什么表情，后面直接写表情名：比如 #全群摸头、#全员一直摸', true)
      return true
    }
    const { code, keyword } = hit
    if (!nestable(code)) {
      await e.reply(`#${keyword} 要配文字或用好几张图，没法全员做哦~`, true)
      return true
    }

    const members = await getMemberList(e)
    // 人不够就按实际人数来，至少要有 2 个才有群戏
    const count = _.clamp(parseInt(Config.get('crowdCount')) || 6, 2, 9)
    const uids = pickSome(members.filter(id => !isBlackUser(id) && String(id) !== String(e.sender.user_id)), count)
    if (uids.length < 2) {
      await e.reply('群里人不够呀，凑不出一局~', true)
      return true
    }

    // 先批量取成员信息，再下一遍头像（失败的跳过），后续按组配对生成，
    // 顺序怎么乱都不影响「谁配哪张图」
    const infos = await Promise.all(uids.map(uid => getMemberInfo(e, uid)))
    const pairs = []
    for (let i = 0; i < uids.length; i++) {
      const b = await avatarBuffer(e, uids[i])
      if (b) pairs.push({ buffer: b, info: infos[i] })
    }
    if (!pairs.length) {
      await e.reply('头像下不下来，稍后再试试~', true)
      return true
    }

    const picked = []
    await mapLimit(pairs, 2, async p => {
      const res = await makeOne(code, [p.buffer], [p.info])
      if (!res.ok) {
        logger.error(`${logPrefix} 全员 生成 ${code} 失败: ${res.error}`)
        return
      }
      picked.push({ buffer: res.buffer, contentType: res.contentType, name: _.trim(p.info.text, '@') })
    })
    if (!picked.length) {
      await e.reply('一个都没做出来，发 #meme部署状态 看看服务还好吗', true)
      return true
    }
    for (const p of picked) {
      Stats.record({
        code,
        userId: e.user_id,
        groupId: e.group_id,
        groupName: groupNameOf(e),
        name: e.sender.card || e.sender.nickname
      })
    }

    // 一条消息里把原图全发出去 —— 动图能动。
    // 不走网格图：那个只能取首帧，摸头这类表情本来就是动的，拼完看着像坏了。
    // 也不用合并转发（#整活 那条走的路）：这里就 6 张小图，摊开在一条里更直观
    const total = picked.reduce((s, p) => s + p.buffer.length, 0)
    const locs = []
    try {
      ensureDir('result')
      // 名字按 picked 的顺序列（并发生成，顺序和抽人时不一定一致），
      // 这样文字里的排列和下面图片的排列是对得上的
      const parts = [`🎪 全员#${keyword}　·　${picked.map(p => _.truncate(p.name, { length: 8 })).join('、')}`]
      for (const p of picked) {
        const loc = dataPath('result', uniqueName(p.contentType.split('/')[1] || 'gif'))
        fs.writeFileSync(loc, p.buffer)
        locs.push(loc)
        parts.push(segment.image(`file://${loc}`))
      }
      await e.reply(parts)
    } catch (err) {
      // 发不出去多半是图加起来太大（实测单张最大约 680KB，6 张 4MB），
      // 退回网格图：静态但至少发得出去
      logger.error(`${logPrefix} 全员发图失败（共 ${(total / 1048576).toFixed(1)}MB）: ${err.message}`)
      await this.crowdGrid(e, keyword, code, picked)
    } finally {
      for (const loc of locs) unlinkQuietly(loc)
    }
    return true
  }

  /** 全员玩法的退路：拼成一张网格图。发原图失败（图太大、适配器不支持）时才用 */
  async crowdGrid (e, keyword, code, picked) {
    const items = await Promise.all(picked.map(async p => {
      const small = await Preview.shrink(p.buffer, 200, p.contentType)
      return {
        key: code,
        label: _.truncate(p.name, { length: 8 }),
        dataUri: `data:${small.contentType};base64,${small.buffer.toString('base64')}`
      }
    }))
    let loc
    try {
      // 标题回显**用户打的那个词**，不用 keywords[0]：
      // petpet 的别名依次是 摸/摸摸/摸头/rua，发「#全群摸头」却回「全员#摸」，
      // 看着像认错了表情
      loc = await renderGrid(items, {
        title: `全员#${keyword}`,
        footer: `随机 ${picked.length} 位群友　·　图太大了，这张是静态版`,
        columns: gridColumns(items.length)
      })
      await e.reply(segment.image(`file://${loc}`))
    } catch (err) {
      logger.error(`${logPrefix} 全员拼图失败: ${err.message}`)
      await replyImage(e, picked[0].buffer,
        `只发得出一张：#${keyword}`,
        picked[0].contentType)
    } finally {
      if (loc) unlinkQuietly(loc)
    }
    return true
  }

  /**
   * #今日表情 —— 同一个人同一天永远抽到同一个表情 + 一句运势。
   * 结果由 md5(QQ号+日期) 决定，不是随机，一天里反复发不会变。
   */
  async daily (e) {
    if (blocked(e)) return false
    if (!Config.get('enableFun')) return false
    if (MemeIndex.isEmpty) {
      await e.reply(emptyIndexTip())
      return true
    }

    let pool = safePool(nestCandidates())
    // 今日表情是发到大庭广众的，主人参与时别抽到敏感内容
    pool = await dropProtectedIfMaster(pool, [e.user_id])
    const pick = pickDaily(e.user_id, pool)
    if (!pick) {
      await e.reply('没有能用的表情了 —— 看看 blackMemes / funExcludeWords 是不是把它们全过滤了')
      return true
    }

    const buffer = await avatarBuffer(e, e.sender.user_id)
    if (!buffer) {
      await e.reply('头像下不下来，稍后再试试~', true)
      return true
    }
    const info = await getMemberInfo(e, e.sender.user_id)
    const res = await makeOne(pick.code, [buffer], [info])
    if (!res.ok) {
      logger.error(`${logPrefix} 今日表情 生成 ${pick.code} 失败: ${res.error}`)
      await e.reply('表情没做出来，发 #meme部署状态 看看服务还好吗', true)
      return true
    }
    Stats.record({
      code: pick.code,
      userId: e.user_id,
      groupId: e.group_id,
      groupName: groupNameOf(e),
      name: e.sender.card || e.sender.nickname
    })
    await replyImage(e, res.buffer, `🔮 今天的运势：${pick.fortune}`, res.contentType)
    return true
  }
}
