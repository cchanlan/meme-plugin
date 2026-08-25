import Config from '../model/config.js'
import MemeIndex from '../model/memeIndex.js'
import { renderHelp } from '../utils/helpImage.js'
import { unlinkQuietly } from '../utils/file.js'
import { blocked } from '../utils/guard.js'
import { logPrefix } from '../constants/path.js'

export class memeHelp extends plugin {
  constructor () {
    super({
      name: 'meme帮助',
      dsc: '表情包功能说明',
      event: 'message',
      priority: 4000,
      rule: [
        {
          reg: '^#?meme(s)?(帮助|help|菜单)$',
          fnc: 'help'
        }
      ]
    })
  }

  async help (e) {
    if (blocked(e)) return false

    const web = Config.get('enableWeb') ? `${Config.getWebUrl()}/memes` : null

    let loc = null
    try {
      loc = await renderHelp({
        total: MemeIndex.memeCount,
        keywords: MemeIndex.keywordCount,
        web
      })
    } catch (err) {
      logger.error(`${logPrefix} 帮助图渲染失败：${err.message}`)
    }

    if (loc) {
      // 图里字被 QQ 缩放后偏小，核心指令再补一段文字：可复制、链接可点
      const text = [
        '🌸 常用指令',
        '#摸头 / #摸头 @某人 / 引用图片 + #摸头',
        '#一巴掌 笨蛋　多段文字用 / 隔开',
        '#meme搜索 猫　#meme列表　#meme分类',
        `共 ${MemeIndex.memeCount} 个表情 / ${MemeIndex.keywordCount} 个关键词`
      ]
      if (web) text.push(`在线预览：${web}`)
      await e.reply([segment.image(`file://${loc}`), text.join('\n')])
      unlinkQuietly(loc)
      return true
    }

    // 出图失败（缺 puppeteer / 内存不足）时退回纯文字，功能不受影响
    await e.reply(this.textHelp(web))
    return true
  }

  textHelp (web) {
    const lines = [
      '🌸 表情包使用说明',
      '',
      '【做表情】',
      '  #表情名 文字 —— 如 #摸头、#一巴掌 笨蛋',
      '  #表情名 @某人 —— 用对方头像',
      '  引用图片 + #表情名 —— 用图里的图',
      '  #表情名#参数 —— 如 #爬#33、#一直#循环',
      '  多段文字用 / 隔开 —— 如 #高低情商 会说话/不会说话',
      '',
      '【找表情】'
    ]
    if (web) {
      lines.push(`  🌟 在线预览（推荐）：${web}`)
      lines.push('     能看到每个表情长什么样，点一下就复制指令')
    }
    lines.push('  #meme搜索 关键词 —— 出预览图，支持按分类搜')
    lines.push('  #meme列表 —— 分页看全部（每页 24 个，带预览图）')
    lines.push('  #meme分类 —— 按作品/系列看，如 #meme分类 鸣潮')
    lines.push('  #表情名详情 —— 看这个表情支持什么参数')
    lines.push('  #随机meme —— 随机来一个')
    lines.push('')
    lines.push(`目前共 ${MemeIndex.memeCount} 个表情 / ${MemeIndex.keywordCount} 个关键词`)
    lines.push('')
    lines.push('【管理】')
    lines.push('  #meme开启 / #meme关闭 —— 本群开关（群管或主人）')
    lines.push('  #meme开关 —— 看本群当前状态')
    lines.push('  以下仅主人：')
    lines.push('  #meme更新 —— 拉取新表情（会自动重启服务+刷新索引）')
    lines.push('  #meme刷新 —— 只重建索引，不动仓库')
    lines.push('  #meme部署状态 —— 查看服务健康度')
    lines.push('  #meme清缓存 —— 清空预览图/缩略图缓存')
    lines.push('  #meme部署 —— 可选：在本机装一套 meme 服务')
    return lines.join('\n')
  }
}
