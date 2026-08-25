import Config from '../model/config.js'
import MemeIndex from '../model/memeIndex.js'

export class memeHelp extends plugin {
  constructor () {
    super({
      name: '表情包帮助',
      dsc: '表情包功能说明',
      event: 'message',
      priority: 4000,
      rule: [
        {
          reg: '^#?(meme(s)?|表情包)(帮助|help|菜单)$',
          fnc: 'help'
        }
      ]
    })
  }

  async help (e) {
    const web = Config.get('enableWeb') ? `${Config.getWebUrl()}/memes` : null
    const lines = [
      '🎨 表情包使用说明',
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
    lines.push('  #表情包搜索 关键词 —— 出预览图，支持按分类搜')
    lines.push('  #表情包列表 —— 分页看全部（每页 80 个，字清晰）')
    lines.push('  #表情包分类 —— 按作品/系列看，如 #表情包分类 鸣潮')
    lines.push('  #表情名详情 —— 看这个表情支持什么参数')
    lines.push('  #随机表情包 —— 随机来一个')
    lines.push('')
    lines.push(`目前共 ${MemeIndex.memeCount} 个表情 / ${MemeIndex.keywordCount} 个关键词`)
    lines.push('')
    lines.push('【管理·仅主人】')
    lines.push('  #meme更新 —— 拉取新表情（会自动重启服务+刷新索引）')
    lines.push('  #meme刷新 —— 只重建索引，不动仓库')
    lines.push('  #meme部署状态 —— 查看服务健康度')
    lines.push('  #meme部署 —— 可选：在本机装一套 meme 服务')

    await e.reply(lines.join('\n'))
    return true
  }
}
