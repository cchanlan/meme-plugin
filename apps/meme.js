import fs from 'node:fs'
import _ from 'lodash'
import { File, FormData } from 'node-fetch'
import Config from '../model/config.js'
import MemeApi from '../model/memeApi.js'
import MemeIndex from '../model/memeIndex.js'
import Stats from '../model/stats.js'
import { handleArgs, detail } from '../utils/args.js'
import { renderDetail } from '../utils/detailImage.js'
import { uniqueName, unlinkQuietly, ensureDir, dataPath } from '../utils/file.js'
import { blocked } from '../utils/guard.js'
import { getAvatarUrl, getSelfAvatarUrl, getMemberInfo } from '../utils/user.js'
import { logPrefix } from '../constants/path.js'

async function getMasterQQ () {
  return (await import('../../../lib/config/config.js')).default.masterQQ
}

/**
 * 下一张用户图。两处都是踩过的：
 * - 必须带超时：裸 fetch 遇上 QQ 图床偶发不返回时，会把整条消息一直挂在那儿，
 *   等 Yunzai 自己超时，期间这个人再发指令还会叠一份
 * - 大小要先看 content-length：原来只在下载完之后用 checkFileSize 拦，
 *   流量已经吃进来了，maxFileSize 只挡住了生成、没挡住下载
 */
async function fetchImage (url, maxBytes, timeoutMs) {
  const res = await fetch(url, { signal: AbortSignal.timeout(timeoutMs) })
  if (!res.ok) throw new Error(`HTTP ${res.status}`)
  const tooBig = n => {
    const err = new Error(`图片 ${(n / 1048576).toFixed(1)}MB，超过 ${(maxBytes / 1048576).toFixed(0)}MB 限制`)
    err.oversize = true
    return err
  }
  const len = Number(res.headers.get('content-length'))
  if (len && len >= maxBytes) throw tooBig(len)
  const buffer = Buffer.from(await res.arrayBuffer())
  // 分块传输不给 content-length，这种只能下完再判
  if (buffer.length >= maxBytes) throw tooBig(buffer.length)
  const type = (res.headers.get('Content-Type') || 'image/jpeg').split(';')[0]
  return { buffer, ext: type.split('/')[1] || 'jpeg' }
}

export class memeMaker extends plugin {
  constructor () {
    super({
      name: 'meme制作',
      dsc: '根据文字或图片制作表情包',
      event: 'message',
      // 放在最后兜底：1100+ 个关键词合并成一条 ^# 规则，
      // 未命中就 return false 放行给其他插件
      priority: 5000,
      rule: [
        {
          reg: Config.get('forceSharp') ? '^#' : '^#?',
          fnc: 'makeMeme'
        }
      ]
    })
  }

  /**
   * 「xx详情」出图。
   * 图里带真实预览和参数卡片，出图失败（缺 puppeteer / 内存不足）就退回原来的纯文字，
   * 功能不受影响。
   */
  async sendDetail (e, code, info) {
    let loc = null
    try {
      loc = await renderDetail(code, info)
    } catch (err) {
      logger.error(`${logPrefix} 详情图渲染失败 ${code}：${err.message}`)
    }
    if (loc) {
      await e.reply(segment.image(`file://${loc}`), Config.get('replyWithQuote'))
      unlinkQuietly(loc)
      return
    }
    await e.reply(detail(code, info))
  }

  async makeMeme (e) {
    if (MemeIndex.isEmpty) return false
    // 拉黑的人、关掉表情的群都静默放行，不回提示 —— 那种提示反而给了对方刷屏的抓手
    if (blocked(e)) return false

    // 只去掉前导 #，不能用 replace('#','') —— 参数分隔符也是 #（如 #爬#33）
    const msg = _.trimStart(e.msg, '#')
    const hit = MemeIndex.match(msg)
    if (!hit) return false

    const { keyword: target, code: targetCode, info } = hit
    if (!info || !info.params_type) {
      logger.error(`${logPrefix} infos 中缺少 ${targetCode} 的数据`)
      await e.reply('表情包数据异常，请执行 #meme更新 后重试~')
      return true
    }

    const text1 = _.trimStart(e.msg, '#').replace(target, '')
    if (text1.trim() === '详情' || text1.trim() === '帮助') {
      await this.sendDetail(e, targetCode, info)
      return true
    }

    let [text, args = ''] = text1.split('#')
    const formData = new FormData()
    // 数组而非单变量：旧版多图时 fileLoc 被循环覆盖，只有最后一张会被删，前面的全部泄漏
    const fileLocs = []
    let userInfos

    if (info.params_type.max_images > 0) {
      // 每张图都记着「这是谁的头像」（uid，非头像来源为 null）。
      // 主人保护原来是拿 URL 去 split('=') 抠 QQ 号，只对写死的 qlogo 地址成立 ——
      // 一旦头像地址改成问适配器要（微信、官方 bot 的地址长得完全不一样），那段判断就静默失效了
      let imgs = []
      if (e.source || e.reply_id) {
        // 优先从回复里找图
        let reply
        if (this.e.getReply) {
          reply = await this.e.getReply()
        } else if (this.e.source) {
          if (this.e.group?.getChatHistory) {
            reply = (await this.e.group.getChatHistory(this.e.source.seq, 1)).pop()
          } else if (this.e.friend?.getChatHistory) {
            reply = (await this.e.friend.getChatHistory(this.e.source.time, 1)).pop()
          }
        }
        if (reply?.message) {
          for (const val of reply.message) {
            if (val.type === 'image') imgs.push({ uid: null, url: val.url })
          }
        }
      } else if (e.img) {
        imgs.push(...e.img.map(url => ({ uid: null, url })))
      } else if (e.message.filter(m => m.type === 'at').length > 0) {
        imgs = await Promise.all(
          e.message
            .filter(m => m.type === 'at')
            .map(async at => ({ uid: at.qq, url: await getAvatarUrl(e, at.qq) }))
        )
        imgs = imgs.filter(i => i.url)
      }

      const me = { uid: e.sender.user_id, url: await getSelfAvatarUrl(e) }
      const sameAsMe = i => String(i.uid) === String(me.uid)
      if (!imgs.length) imgs = [me]
      if (imgs.length < info.params_type.min_images && !imgs.some(sameAsMe)) {
        imgs = [me, ...imgs]
      }

      // 主人保护：撅主人会被反撅
      const protectList = Config.get('protectList') || []
      if (protectList.includes(targetCode) && Config.get('masterProtect')) {
        const masters = (await getMasterQQ()).map(q => String(q))
        // 单图表情里被撅的就是第 0 张，多图时第 0 张是发起人自己、第 1 张才是目标
        const idx = imgs.length === 1 ? 0 : 1
        const victim = imgs[idx]
        if (victim?.uid != null && masters.includes(String(victim.uid))) {
          // 一张图就变成撅自己，两张图就把顺序调过来 —— 主人在前，你在后
          imgs = imgs.length === 1 ? [me] : [victim, me]
        }
      }

      imgs = imgs.slice(0, Math.min(info.params_type.max_images, imgs.length))
      ensureDir('original')
      const maxBytes = (Config.get('maxFileSize') || 10) * 1024 * 1024
      const timeoutMs = Config.get('imageTimeout') || 15000
      // 并行下：原来是 for + await 串行，多图表情要白等好几个来回
      const downloaded = await Promise.all(imgs.map(async ({ url }) => {
        try {
          return await fetchImage(url, maxBytes, timeoutMs)
        } catch (err) {
          logger.error(`${logPrefix} 下载图片失败 ${url}: ${err.message}`)
          return { error: err }
        }
      }))

      const oversize = downloaded.find(d => d?.error?.oversize)
      if (oversize) {
        await e.reply(oversize.error.message, true)
        return true
      }
      // 顺序敏感：images 的先后决定表情里谁在左谁在右，所以按原下标回填
      for (let i = 0; i < downloaded.length; i++) {
        const d = downloaded[i]
        if (!d || d.error) continue
        const loc = dataPath('original', uniqueName(d.ext))
        fs.writeFileSync(loc, d.buffer)
        fileLocs.push(loc)
        formData.append('images', new File([d.buffer], `avatar_${i}.jpg`, { type: 'image/jpeg' }))
      }
      if (formData.getAll('images').length < info.params_type.min_images) {
        for (const loc of fileLocs) unlinkQuietly(loc)
        await e.reply('图片下载失败了，稍后再试试~', true)
        return true
      }
    }

    // 群成员信息先算出来：底下「没给文字就拿被 @ 的人当文字」也要用同一份名字。
    // 原来那里直接读 at 段的 text，可 at 段带不带 text 是各适配器自己定的，
    // 不带的时候文字就成了空串，出图是一张没字的表情
    const ats = e.message.filter(m => m.type === 'at')
    if (ats.length > 0) {
      userInfos = await Promise.all(ats.map(ui => getMemberInfo(e, ui.qq, ui.text)))
    } else {
      userInfos = [{
        qq: e.sender.user_id,
        text: e.sender.card || e.sender.nickname || `用户${e.sender.user_id}`,
        gender: e.sender.sex || 'unknown'
      }]
    }
    const firstName = _.trim(userInfos[0].text, '@')

    if (text && info.params_type.max_texts === 0) {
      for (const loc of fileLocs) unlinkQuietly(loc)
      return false
    }
    if (!text && info.params_type.min_texts > 0) text = firstName

    const texts = text.split('/', info.params_type.max_texts)
    if (texts.length < info.params_type.min_texts) {
      for (const loc of fileLocs) unlinkQuietly(loc)
      await e.reply(`字不够！要至少${info.params_type.min_texts}个用/隔开！`, true)
      return true
    }
    texts.forEach(t => formData.append('texts', t))

    if (info.params_type.max_texts > 0 && formData.getAll('texts').length === 0) {
      formData.append('texts', firstName)
    }

    const argsStr = handleArgs(targetCode, info, args, userInfos)
    if (argsStr) formData.set('args', argsStr)

    try {
      const res = await MemeApi.generate(targetCode, formData)
      if (!res.ok) {
        logger.error(`${logPrefix} 生成 ${targetCode} 失败: ${res.error}`)
        await e.reply(res.error, true)
        return true
      }
      ensureDir('result')
      const ext = res.contentType.split('/')[1] || 'gif'
      const resultLoc = dataPath('result', uniqueName(ext))
      fs.writeFileSync(resultLoc, res.buffer)
      await e.reply(segment.image(`file://${resultLoc}`), Config.get('replyWithQuote'))
      unlinkQuietly(resultLoc)
      // 只在真发出去之后才记一次：失败、参数不够、被拦下的都不该进榜单
      Stats.record({
        code: targetCode,
        userId: e.user_id,
        groupId: e.group_id,
        name: e.sender.card || e.sender.nickname
      })
    } catch (err) {
      logger.error(`${logPrefix} 生成表情异常: ${err.message}`)
      await e.reply(`表情生成失败：${err.message}`, true)
    } finally {
      // 无论成功、服务端报错还是抛异常，都要清掉本轮下载的原图
      for (const loc of fileLocs) unlinkQuietly(loc)
    }
    return true
  }
}
