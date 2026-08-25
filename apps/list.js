import fs from 'node:fs'
import _ from 'lodash'
import Config from '../model/config.js'
import MemeApi from '../model/memeApi.js'
import MemeIndex from '../model/memeIndex.js'
import { renderGrid } from '../utils/gridImage.js'
import { dataPath, ensureDir, cleanupStale, unlinkQuietly } from '../utils/file.js'
import { isBlackUser } from '../utils/black.js'
import { logPrefix } from '../constants/path.js'

/**
 * 渲染一页列表图并缓存。
 * 服务端 render_list 的字号是固定的、不随数量缩放——
 * 全量 830 个会渲染成 4247x5260 的长图，发到 QQ 压缩后字全糊；
 * 80 个/页约 1007x1410（3 列），字才清晰。
 */
async function renderPage (codes, cacheName) {
  const loc = dataPath('list_cache', cacheName)
  if (Config.get('enablePreviewCache') && fs.existsSync(loc)) {
    return loc
  }
  const { buffer, contentType } = await MemeApi.renderList(codes)
  ensureDir('list_cache')
  const ext = contentType.split('/')[1] || 'png'
  const finalLoc = loc.replace(/\.\w+$/, `.${ext}`)
  fs.writeFileSync(finalLoc, buffer)
  return finalLoc
}

export class memeList extends plugin {
  constructor () {
    super({
      name: '表情包列表',
      dsc: '分页查看表情包列表、按分类查看',
      event: 'message',
      priority: 4000,
      rule: [
        {
          // 放开页码：旧版 ^…列表$ 的 $ 锚点让「#表情包列表 2」匹配不上
          reg: '^#?(meme(s)?|表情包)列表\\s*(\\d+)?$',
          fnc: 'showList'
        },
        {
          reg: '^#?(meme(s)?|表情包)分类\\s*(.*)$',
          fnc: 'showTags'
        },
        {
          reg: '^#?随机(meme(s)?|表情包)$',
          fnc: 'randomMeme'
        }
      ]
    })
  }

  async showList (e) {
    if (isBlackUser(e.user_id)) return false
    if (MemeIndex.isEmpty) {
      await e.reply('表情包数据还没加载，请先发 #meme更新')
      return true
    }

    const pageSize = Config.get('pageSize') || 80
    const codes = MemeIndex.allCodes()
    const totalPages = Math.ceil(codes.length / pageSize)
    const m = /(\d+)\s*$/.exec(e.msg)
    let page = m ? parseInt(m[1]) : 1
    if (page < 1) page = 1
    if (page > totalPages) {
      await e.reply(`只有 ${totalPages} 页哦，第 ${page} 页不存在`)
      return true
    }

    const pageCodes = codes.slice((page - 1) * pageSize, page * pageSize)
    try {
      const loc = await renderPage(pageCodes, `page_${page}_${pageSize}.png`)
      const webUrl = Config.get('enableWeb') ? `\n🔍 在线搜索预览：${Config.getWebUrl()}/memes` : ''
      await e.reply([
        segment.image(`file://${loc}`),
        `第 ${page}/${totalPages} 页 · 共 ${MemeIndex.memeCount} 个表情\n` +
        `翻页：#表情包列表 ${page < totalPages ? page + 1 : 1}\n` +
        `搜索：#表情包搜索 关键词${webUrl}`
      ])
    } catch (err) {
      logger.error(`${logPrefix} 渲染列表失败: ${err.message}`)
      await e.reply(`列表渲染失败：${err.message}`)
    }
    return true
  }

  async showTags (e) {
    if (isBlackUser(e.user_id)) return false
    if (MemeIndex.isEmpty) {
      await e.reply('表情包数据还没加载，请先发 #meme更新')
      return true
    }

    const tag = e.msg.replace(/^#?(meme(s)?|表情包)分类/, '').trim()
    const tags = MemeIndex.getTags()

    // 不带参数：列出所有分类
    if (!tag) {
      let txt = `📂 表情包分类（共 ${tags.length} 个）\n\n`
      txt += tags.map(t => `${t.tag}(${t.count})`).join('  ')
      txt += '\n\n查看某个分类：#表情包分类 鸣潮'
      if (Config.get('enableWeb')) {
        txt += `\n在线浏览：${Config.getWebUrl()}/memes`
      }
      await e.reply(txt)
      return true
    }

    // 带参数：出该分类的预览图
    const codes = MemeIndex.getByTag(tag)
    if (codes.length === 0) {
      const similar = tags.filter(t => t.tag.includes(tag)).slice(0, 5)
      await e.reply(
        `没有「${tag}」这个分类~` +
        (similar.length ? `\n你是想找：${similar.map(t => t.tag).join('、')}` : '\n发 #表情包分类 看全部分类')
      )
      return true
    }

    const limit = Config.get('searchMaxPreview') || 40
    const shown = codes.slice(0, limit)
    // 链接不画进图里（图上的 URL 点不了），只留统计信息，链接跟图一起发文字
    let footer = ''
    if (codes.length > limit) footer = `共 ${codes.length} 个，图里是前 ${limit} 个`
    const webLink = Config.get('enableWeb')
      ? `🔍 在线浏览：${Config.getWebUrl()}/memes`
      : ''

    // 同搜索：格子多了图里的名字就读不了，名字另外用文字补一份
    const nameLine = shown.length > 8
      ? shown.map(code => '#' + (MemeIndex.infos[code]?.keywords?.[0] || code)).join('　')
      : ''

    let loc
    try {
      loc = await renderGrid(
        shown.map(code => {
          const kws = MemeIndex.infos[code]?.keywords || [code]
          return { key: code, label: '#' + kws[0], sub: kws.slice(1).join(' / ') }
        }),
        { title: `📂 ${tag} · ${codes.length} 个表情`, footer }
      )
      const parts = [segment.image(`file://${loc}`)]
      if (nameLine) parts.push(nameLine)
      if (webLink) parts.push(webLink)
      await e.reply(parts)
    } catch (err) {
      logger.error(`${logPrefix} 渲染分类失败: ${err.message}`)
      await e.reply(`分类出图失败：${err.message}`)
    } finally {
      if (loc) unlinkQuietly(loc)
    }
    return true
  }

  async randomMeme (e) {
    if (isBlackUser(e.user_id)) return false
    const candidates = MemeIndex.randomCandidates()
    if (candidates.length === 0) {
      await e.reply('没有可用的随机表情，请先发 #meme更新')
      return true
    }
    const code = candidates[_.random(0, candidates.length - 1, false)]
    const keyword = MemeIndex.infos[code]?.keywords?.[0]
    if (!keyword) return true
    // 直接调生成逻辑，不靠 return false 让兜底规则接手（那样依赖规则传播顺序，容易断）
    const { memeMaker } = await import('./meme.js')
    const maker = new memeMaker()
    maker.e = e
    e.msg = `#${keyword}`
    return await maker.makeMeme(e)
  }

  /** 清理过期的列表缓存 */
  static cleanCache () {
    return cleanupStale(dataPath('list_cache'), 24 * 3600 * 1000)
  }
}
