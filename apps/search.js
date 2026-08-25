import Config from '../model/config.js'
import MemeIndex from '../model/memeIndex.js'
import { renderGrid } from '../utils/gridImage.js'
import { unlinkQuietly } from '../utils/file.js'
import { isBlackUser } from '../utils/black.js'
import { logPrefix } from '../constants/path.js'

export class memeSearch extends plugin {
  constructor () {
    super({
      name: '表情包搜索',
      dsc: '搜索表情包并给出预览图',
      event: 'message',
      priority: 4000,
      rule: [
        {
          reg: '^#?(meme(s)?|表情包)搜索\\s*(.*)$',
          fnc: 'search'
        }
      ]
    })
  }

  async search (e) {
    if (isBlackUser(e.user_id)) return false
    const query = e.msg.replace(/^#?(meme(s)?|表情包)搜索/, '').trim()
    if (!query) {
      await e.reply('要搜什么呢？比如：#表情包搜索 猫')
      return true
    }
    if (MemeIndex.isEmpty) {
      await e.reply('表情包数据还没加载，请先发 #meme更新')
      return true
    }

    // 同时匹配关键词、tag、英文 code，并按表情去重
    const hits = MemeIndex.search(query)
    // 命中时不附链接：出图那类回复每条都甩一串域名太占版面，
    // 只有「没找到」和「出图失败」才给 Web 站兜底入口
    const webLink = Config.get('enableWeb') ? `\n🔍 搜索预览：${Config.getWebUrl()}/memes` : ''

    if (hits.length === 0) {
      const tags = MemeIndex.getTags().filter(t => t.tag.includes(query)).slice(0, 5)
      await e.reply(
        `没找到「${query}」相关的表情~` +
        (tags.length ? `\n试试分类：${tags.map(t => t.tag).join('、')}` : '') +
        `\n发 #表情包分类 看全部分类${webLink}`
      )
      return true
    }

    const limit = Config.get('searchMaxPreview') || 40
    const shown = hits.slice(0, limit)

    // 链接不画进图里（图上的 URL 点不了），只留统计信息，链接跟图一起发文字
    let footer = ''
    if (hits.length > limit) footer = `共 ${hits.length} 个，图里是前 ${limit} 个，搜得更具体些能看到全部`
    const byTag = shown.filter(h => h.hitBy === 'tag').length
    if (byTag > 0) {
      footer += `${footer ? '　·　' : ''}其中 ${byTag} 个按分类匹配`
    }

    // 数量一多，图里的字在 QQ 气泡里会缩到几个像素——气泡最宽约 420px，
    // 除以列数就是每格实际宽度：8 个约 105px 还能认字，24 个只剩 70px，80 个 35px。
    // 所以名字再用文字补一份：文字不受图片缩放影响，还能直接长按复制
    const nameLine = shown.length > 8
      ? shown.map(h => '#' + h.keywords[0]).join('　')
      : ''

    let loc
    try {
      loc = await renderGrid(
        shown.map(h => ({
          key: h.code,
          label: '#' + h.keywords[0],
          sub: h.keywords.slice(1).join(' / ')
        })),
        { title: `「${query}」找到 ${hits.length} 个表情`, footer }
      )
      const parts = [segment.image(`file://${loc}`)]
      if (nameLine) parts.push(nameLine)
      await e.reply(parts)
    } catch (err) {
      logger.error(`${logPrefix} 搜索出图失败: ${err.message}`)
      // 出图失败才退回文字，正常情况不发这一堆
      const list = shown.map((h, i) => `${i + 1}. ${h.keywords.join(' / ')}`).join('\n')
      await e.reply(`🔎 「${query}」找到 ${hits.length} 个（出图失败）\n${list}${webLink}`)
    } finally {
      if (loc) unlinkQuietly(loc)
    }
    return true
  }
}
