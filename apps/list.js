import fs from 'node:fs'
import crypto from 'node:crypto'
import _ from 'lodash'
import Config from '../model/config.js'
import MemeIndex from '../model/memeIndex.js'
import { renderGrid } from '../utils/gridImage.js'
import { IMG_EXT } from '../utils/browser.js'
import { dataPath, ensureDir, unlinkQuietly } from '../utils/file.js'
import { blocked, emptyIndexTip } from '../utils/guard.js'
import { logPrefix } from '../constants/path.js'

/** 群里发的 Web 站入口，统一文案；图里不画链接（图上的 URL 点不了） */
function webLine () {
  if (!Config.get('enableWeb')) return ''
  return `🔍 搜索预览：${Config.getWebUrl()}/memes`
}

/**
 * 渲染一页列表图，命中缓存就直接用。
 *
 * 和搜索/分类共用自己拼的网格图：服务端 render_list 只画关键词加占位图标，
 * 看不到表情长什么样。列表分页是固定切片、翻页会反复看同一页，所以落盘复用。
 */
async function renderPage (codes, page, totalPages, cacheName) {
  const loc = dataPath('list_cache', cacheName)
  if (Config.get('enablePreviewCache') && fs.existsSync(loc)) return loc
  ensureDir('list_cache')
  return renderGrid(
    codes.map(code => {
      const kws = MemeIndex.infos[code]?.keywords || [code]
      return { key: code, label: '#' + kws[0], sub: kws.slice(1).join(' / ') }
    }),
    {
      title: `表情包列表 · 第 ${page}/${totalPages} 页`,
      footer: `共 ${MemeIndex.memeCount} 个表情　·　翻页：#meme列表 ${page < totalPages ? page + 1 : 1}`,
      out: loc
    }
  )
}

export class memeList extends plugin {
  constructor () {
    super({
      name: 'meme列表',
      dsc: '分页查看表情包列表、按分类查看',
      event: 'message',
      priority: 4000,
      rule: [
        {
          // 放开页码：旧版 ^…列表$ 的 $ 锚点让「#meme列表 2」匹配不上
          reg: '^#?meme(s)?列表\\s*(\\d+)?$',
          fnc: 'showList'
        },
        {
          reg: '^#?meme(s)?分类\\s*(.*)$',
          fnc: 'showTags'
        },
        {
          reg: '^#?随机meme(s)?$',
          fnc: 'randomMeme'
        }
      ]
    })
  }

  async showList (e) {
    if (blocked(e)) return false
    if (MemeIndex.isEmpty) {
      await e.reply(emptyIndexTip())
      return true
    }

    const pageSize = Config.get('pageSize') || 24
    const codes = MemeIndex.allCodes()
    const totalPages = Math.ceil(codes.length / pageSize)
    // 索引不空但一个都不剩，只能是 blackMemes 把它们全拉黑了。
    // 不判的话下面会回「只有 0 页哦」，看着像插件坏了
    if (totalPages === 0) {
      await e.reply('能看的表情一个都没有了 —— 配置 blackMemes 把它们全拉黑了，去掉几个再看看')
      return true
    }
    const m = /(\d+)\s*$/.exec(e.msg)
    let page = m ? parseInt(m[1]) : 1
    if (page < 1) page = 1
    if (page > totalPages) {
      await e.reply(`只有 ${totalPages} 页哦，第 ${page} 页不存在`)
      return true
    }

    const pageCodes = codes.slice((page - 1) * pageSize, page * pageSize)
    try {
      // 缓存名带上这一页的内容指纹：只按页码命名的话，拉黑一个表情之后
      // （改配置不会清图片缓存）旧图还在，被拉黑的表情继续挂在列表里露脸。
      // 内容一变文件名就变，旧图交给 cleanupStale 24 小时后收走。
      const sig = crypto.createHash('md5').update(pageCodes.join(',')).digest('hex').slice(0, 8)
      const loc = await renderPage(pageCodes, page, totalPages, `page_${page}_${pageSize}_${sig}${IMG_EXT}`)
      // 页码、总数、翻页指令图里的标题和 footer 都印着了，不再用文字重复一遍。
      // 只有链接非得走文字 —— 图上的 URL 点不了
      const web = webLine()
      const parts = [segment.image(`file://${loc}`)]
      if (web) parts.push(web)
      await e.reply(parts)
    } catch (err) {
      logger.error(`${logPrefix} 渲染列表失败: ${err.message}`)
      await e.reply(`列表渲染失败：${err.message}`)
    }
    return true
  }

  async showTags (e) {
    if (blocked(e)) return false
    if (MemeIndex.isEmpty) {
      await e.reply(emptyIndexTip())
      return true
    }

    const tag = e.msg.replace(/^#?meme(s)?分类/, '').trim()
    const tags = MemeIndex.getTags()

    // 不带参数：列出所有分类
    if (!tag) {
      let txt = `📂 表情包分类（共 ${tags.length} 个）\n\n`
      txt += tags.map(t => `${t.tag}(${t.count})`).join('  ')
      txt += '\n\n查看某个分类：#meme分类 鸣潮'
      const web = webLine()
      if (web) txt += `\n${web}`
      await e.reply(txt)
      return true
    }

    // 带参数：出该分类的预览图
    const codes = MemeIndex.getByTag(tag)
    if (codes.length === 0) {
      const similar = tags.filter(t => t.tag.includes(tag)).slice(0, 5)
      await e.reply(
        `没有「${tag}」这个分类~` +
        (similar.length ? `\n你是想找：${similar.map(t => t.tag).join('、')}` : '\n发 #meme分类 看全部分类')
      )
      return true
    }

    const limit = Config.get('searchMaxPreview') || 40
    const shown = codes.slice(0, limit)
    // 出图这类回复不再附链接：每条都甩一串域名太占版面，入口留在列表和帮助里
    let footer = ''
    if (codes.length > limit) footer = `共 ${codes.length} 个，图里是前 ${limit} 个`

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
    if (blocked(e)) return false
    // 索引空了（多半是刚卸载完服务）也要给 emptyIndexTip 那两条出路：
    // 「请先发 #meme更新」在这种情况下只会再撞一次连不上
    if (MemeIndex.isEmpty) {
      await e.reply(emptyIndexTip())
      return true
    }
    const candidates = MemeIndex.randomCandidates()
    if (candidates.length === 0) {
      await e.reply('索引里没有「只要一张图、不用配文字」的表情，随机不出来~\n发 #meme列表 挑一个吧')
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
}
