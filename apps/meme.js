import fs from 'node:fs'
import _ from 'lodash'
import { File, FormData } from 'node-fetch'
import Config from '../model/config.js'
import MemeApi from '../model/memeApi.js'
import MemeIndex from '../model/memeIndex.js'
import { handleArgs, detail } from '../utils/args.js'
import { uniqueName, unlinkQuietly, ensureDir, dataPath } from '../utils/file.js'
import { isBlackUser } from '../utils/black.js'
import { logPrefix } from '../constants/path.js'

async function getMasterQQ () {
  return (await import('../../../lib/config/config.js')).default.masterQQ
}

async function getAvatar (e, userId = e.sender.user_id) {
  if (typeof e.getAvatarUrl === 'function') return await e.getAvatarUrl(0)
  return `https://q1.qlogo.cn/g?b=qq&s=0&nk=${userId}`
}

/** 有任意文件超过限制就返回 true */
function checkFileSize (files) {
  const max = (Config.get('maxFileSize') || 10) * 1024 * 1024
  let list = Array.isArray(files) ? files : [files]
  list = list.filter(f => !!(f?.size))
  return list.some(f => f.size >= max)
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

  async makeMeme (e) {
    if (MemeIndex.isEmpty) return false
    // 拉黑的人静默放行，不回「你被拉黑了」—— 那种提示反而给了对方刷屏的抓手
    if (isBlackUser(e.user_id)) return false

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
      await e.reply(detail(targetCode, info))
      return true
    }

    let [text, args = ''] = text1.split('#')
    const formData = new FormData()
    // 数组而非单变量：旧版多图时 fileLoc 被循环覆盖，只有最后一张会被删，前面的全部泄漏
    const fileLocs = []
    let userInfos

    if (info.params_type.max_images > 0) {
      let imgUrls = []
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
            if (val.type === 'image') imgUrls.push(val.url)
          }
        }
      } else if (e.img) {
        imgUrls.push(...e.img)
      } else if (e.message.filter(m => m.type === 'at').length > 0) {
        imgUrls = e.message
          .filter(m => m.type === 'at')
          .map(at => at.qq)
          .map(qq => `https://q1.qlogo.cn/g?b=qq&s=160&nk=${qq}`)
      }

      const myAvatar = await getAvatar(e)
      if (!imgUrls || imgUrls.length === 0) {
        imgUrls = [myAvatar]
      }
      if (imgUrls.length < info.params_type.min_images && imgUrls.indexOf(myAvatar) === -1) {
        imgUrls = [myAvatar].concat(imgUrls)
      }

      // 主人保护：撅主人会被反撅
      const protectList = Config.get('protectList') || []
      if (protectList.includes(targetCode) && Config.get('masterProtect')) {
        const masters = (await getMasterQQ()).map(q => String(q))
        const idx = imgUrls.length === 1 ? 0 : 1
        const url = imgUrls[idx]
        if (typeof url === 'string' && url.startsWith('https://q1.qlogo.cn')) {
          const split = url.split('=')
          const targetQQ = split[split.length - 1]
          if (masters.includes(targetQQ)) {
            imgUrls = imgUrls.length === 1 ? [myAvatar] : [url, myAvatar]
          }
        }
      }

      imgUrls = imgUrls.slice(0, Math.min(info.params_type.max_images, imgUrls.length))
      ensureDir('original')
      for (let i = 0; i < imgUrls.length; i++) {
        try {
          const res = await fetch(imgUrls[i])
          const fileType = (res.headers.get('Content-Type') || 'image/jpeg').split('/')[1]
          const buffer = Buffer.from(await res.arrayBuffer())
          const loc = dataPath('original', uniqueName(fileType))
          fs.writeFileSync(loc, buffer)
          fileLocs.push(loc)
          formData.append('images', new File([buffer], `avatar_${i}.jpg`, { type: 'image/jpeg' }))
        } catch (err) {
          logger.error(`${logPrefix} 下载图片失败: ${err.message}`)
        }
      }
    }

    if (text && info.params_type.max_texts === 0) {
      for (const loc of fileLocs) unlinkQuietly(loc)
      return false
    }
    if (!text && info.params_type.min_texts > 0) {
      const ats = e.message.filter(m => m.type === 'at')
      text = ats.length > 0 ? _.trim(ats[0].text, '@') : (e.sender.card || e.sender.nickname)
    }

    const texts = text.split('/', info.params_type.max_texts)
    if (texts.length < info.params_type.min_texts) {
      for (const loc of fileLocs) unlinkQuietly(loc)
      await e.reply(`字不够！要至少${info.params_type.min_texts}个用/隔开！`, true)
      return true
    }
    texts.forEach(t => formData.append('texts', t))

    if (info.params_type.max_texts > 0 && formData.getAll('texts').length === 0) {
      const ats = e.message.filter(m => m.type === 'at')
      formData.append('texts', ats.length > 0
        ? _.trim(ats[0].text, '@')
        : (e.sender.card || e.sender.nickname))
    }

    // 群成员信息，给 user_infos 用
    const ats = e.message.filter(m => m.type === 'at')
    if (ats.length > 0) {
      userInfos = await Promise.all(ats.map(async ui => {
        try {
          const response = await Bot.sendApi('get_group_member_info', {
            group_id: Number(e.group_id),
            user_id: Number(ui.qq)
          })
          const m = response?.data || {}
          return {
            qq: ui.qq,
            gender: m.sex || 'unknown',
            text: m.card || m.nickname || `用户${ui.qq}`
          }
        } catch (err) {
          logger.error(`${logPrefix} 获取群成员信息失败: ${err.message}`)
          return { qq: ui.qq, gender: 'unknown', text: `用户${ui.qq}` }
        }
      }))
    }
    if (!userInfos) {
      userInfos = [{
        text: e.sender.card || e.sender.nickname,
        gender: e.sender.sex
      }]
    }

    const argsStr = handleArgs(targetCode, info, args, userInfos)
    if (argsStr) formData.set('args', argsStr)

    if (checkFileSize(formData.getAll('images'))) {
      for (const loc of fileLocs) unlinkQuietly(loc)
      return e.reply(`文件大小超出限制，最多支持${Config.get('maxFileSize')}MB`)
    }

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
