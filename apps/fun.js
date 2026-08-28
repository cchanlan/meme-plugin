import fs from 'node:fs'
import _ from 'lodash'
import { File, FormData } from 'node-fetch'
import Config from '../model/config.js'
import MemeIndex from '../model/memeIndex.js'
import MemeApi from '../model/memeApi.js'
import Preview from '../model/preview.js'
import Stats from '../model/stats.js'
import { handleArgs } from '../utils/args.js'
import { isBlackUser } from '../utils/black.js'
import { coolLeft, markCool } from '../utils/cooldown.js'
import { fetchImage } from '../utils/download.js'
import { dataPath, ensureDir, uniqueName, unlinkQuietly } from '../utils/file.js'
import { safePool, pickSome, dropProtectedIfMaster } from '../utils/funPool.js'
import { renderGrid } from '../utils/gridImage.js'
import { blocked, emptyIndexTip } from '../utils/guard.js'
import { getAvatarUrl, getSelfAvatarUrl, getMemberInfo, getMemberList } from '../utils/user.js'
import { logPrefix } from '../constants/path.js'

/** 一个表情的第一个中文名，用于文案 */
const nameOf = code => MemeIndex.infos[code]?.keywords?.[0] || code

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

/** 某人的头像 buffer，拿不到返回 null（不抛，调用方要能报人话） */
async function avatarBuffer (e, uid) {
  const url = String(uid) === String(e.sender?.user_id)
    ? await getSelfAvatarUrl(e)
    : await getAvatarUrl(e, uid)
  if (!url) return null
  const maxBytes = (Config.get('maxFileSize') || 10) * 1024 * 1024
  try {
    const { buffer } = await fetchImage(url, maxBytes, Config.get('imageTimeout') || 15000)
    return buffer
  } catch (err) {
    logger.error(`${logPrefix} 下载 ${uid} 的头像失败: ${err.message}`)
    return null
  }
}

/** 用现成的头像 buffer 生成一个表情 */
async function makeOne (code, buffers, userInfos) {
  const fd = new FormData()
  // 顺序有语义（双人表情里谁在上谁在下），按数组下标原样 append
  buffers.forEach((b, i) => fd.append('images', new File([b], `avatar_${i}.jpg`, { type: 'image/jpeg' })))
  const argsStr = handleArgs(code, MemeIndex.infos[code], '', userInfos)
  if (argsStr) fd.set('args', argsStr)
  return await MemeApi.generate(code, fd)
}

/** 生成结果落盘再发。segment.image 各适配器对 Buffer 的支持不一，走文件最稳（和 apps/meme.js 一致） */
async function replyImage (e, buffer, tail, contentType = 'image/gif') {
  ensureDir('result')
  const loc = dataPath('result', uniqueName(contentType.split('/')[1] || 'gif'))
  fs.writeFileSync(loc, buffer)
  try {
    await e.reply([segment.image(`file://${loc}`), tail])
  } finally {
    unlinkQuietly(loc)
  }
}

/**
 * 限并发跑一批任务。
 *
 * meme 服务是单进程 Python，一次「整活」要连做 6~9 张，全丢过去只会一起变慢，
 * 还会把同一时间发 `#摸头` 的人一起堵住。Web 站的在线生成同样固定不超过 2 个。
 */
async function mapLimit (items, limit, fn) {
  let cursor = 0
  const worker = async () => {
    while (cursor < items.length) {
      await fn(items[cursor++])
    }
  }
  await Promise.all(Array.from({ length: Math.min(limit, items.length) }, worker))
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
        name: e.sender.card || e.sender.nickname
      })
      const names = infos.map(i => _.trim(i.text, '@'))
      await replyImage(e, res.buffer,
        `💞 ${names[0]} × ${names[1]}\n表情：#${nameOf(code)}（想要动图版就单独发它）`,
        res.contentType)
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
      await e.reply(forward)
      await e.reply(`🎪 给 ${who} 整了 ${picked.length} 个活，点开看　·　照名字单独发就能再来一张\n${picked.map(d => '#' + nameOf(d.code)).join('　')}`)
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
      await e.reply([
        segment.image(`file://${loc}`),
        items.map(i => i.label).join('　')
      ])
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
}
