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
    // 在线生成是 Web 站里的功能，站关了就无从提起
    const canMake = !!(web && Config.get('enableWebMake'))
    // 用外部服务时「拉表情仓库」「本机部署」这两件事都不成立，帮助里别乱指路
    const local = Config.isLocalService()
    const fun = !!Config.get('enableFun')

    let loc = null
    try {
      loc = await renderHelp({
        total: MemeIndex.memeCount,
        keywords: MemeIndex.keywordCount,
        web,
        canMake,
        local,
        fun
      })
    } catch (err) {
      logger.error(`${logPrefix} 帮助图渲染失败：${err.message}`)
    }

    if (loc) {
      // 图里每条指令都印着了，文字只留图上办不到的那一件事：链接要能点
      const text = []
      if (web) text.push(`🌟 在线预览：${web}`)
      if (canMake) text.push('（网页里还能直接传图在线生成）')
      const parts = [segment.image(`file://${loc}`)]
      if (text.length) parts.push(text.join('\n'))
      await e.reply(parts)
      unlinkQuietly(loc)
      return true
    }

    // 出图失败（缺 puppeteer / 内存不足）时退回纯文字，功能不受影响
    await e.reply(this.textHelp(web, canMake, local, fun))
    return true
  }

  textHelp (web, canMake = false, local = true, fun = true) {
    const lines = [
      '🌸 表情包使用说明',
      '',
      '【做表情】',
      '  #表情名 文字 —— 如 #摸头、#一巴掌 笨蛋',
      '  #表情名 @某人 —— 用对方头像',
      '  引用图片 + #表情名 —— 用图里的图',
      '  #表情名#参数 —— 如 #爬#33、#一直#循环',
      '  多段文字用 / 隔开 —— 如 #高低情商 会说话/不会说话',
      '  #表情名详情 —— 出图看这个表情支持哪些参数、默认文字是什么',
      '                 如 #摸头详情；写成 #摸头帮助 也一样',
      '',
      '【找表情】'
    ]
    if (web) {
      lines.push(`  🌟 在线预览（推荐）：${web}`)
      lines.push('     能看到每个表情长什么样，点一下就复制指令')
      if (canMake) lines.push('     也能在网页里传图、填字，直接生成保存')
    }
    lines.push('  #meme搜索 关键词 —— 出预览图，支持按分类搜')
    lines.push('  #meme列表 —— 随机翻一页看（每页 24 个，带预览图）')
    lines.push('              加页码看指定页，如 #meme列表 3')
    lines.push('  #meme分类 —— 按作品/系列看，如 #meme分类 鸣潮')
    lines.push('  #随机meme —— 随机来一个')
    lines.push('  #meme新增 —— 最近装上的表情排前面')
    lines.push('  #meme排行 —— 本群榜：本群谁最能整活、哪个表情最火')
    lines.push('  #meme总排行 —— 所有群一起排，还有最活跃的群')
    if (fun) {
      lines.push('')
      lines.push('【随机整活】')
      lines.push('  #抽个cp —— 随机抽两个群友，配一个双人表情')
      lines.push('             也能 #抽个cp @张三（另一位随机）或 @ 两个人')
      lines.push('  #整活 @某人 —— 拿他头像连出好几个表情，合并转发发原图')
      lines.push('                 动图也能动；想拼成一张图看就关掉配置 comboForward')
      lines.push('                 也可以发 #表情轰炸')
      lines.push('  #套娃 摸头 踩 恐龙 @某人 —— 头像套进第一个表情，成品再套下一个')
      lines.push('                 不写点名就随机叠（#随机套娃 同效），会自动挑动图')
      lines.push('                 最多 3 层（配置 nestMaxSteps）')
      lines.push('  #全群摸头 —— 同一表情随机抽几个群友，一条消息全发出来')
      lines.push('               #全员摸头、#全体摸头 同效')
      lines.push('  #今日表情 —— 同一天永远是同一个表情 + 一句今日运势')
      lines.push('               #今日运势、#每日表情 同效')
      lines.push('  #猜表情 —— 出一张用你头像做的表情，60 秒内说出名字得一分')
      lines.push('  #猜表情排行 —— 本群猜对榜；#猜表情总排行 看跨群总榜')
    }
    lines.push('')
    lines.push(`目前共 ${MemeIndex.memeCount} 个表情 / ${MemeIndex.keywordCount} 个关键词`)
    lines.push('')
    lines.push('【管理】')
    lines.push('  #meme开启 / #meme关闭 —— 本群开关（群管或主人）')
    lines.push('  #meme开关 —— 看本群当前状态')
    lines.push('  以下仅主人：')
    lines.push(local
      ? '  #meme更新 —— 拉取新表情（会自动重启服务+刷新索引）'
      : '  #meme更新 —— 同步服务方的新表情（外部服务，只刷索引）')
    lines.push('  #meme刷新 —— 只重建索引，不动仓库（#meme重载 同效）')
    lines.push('  #meme部署状态 —— 查看服务健康度')
    lines.push('  #meme清缓存 —— 清空预览图/缩略图缓存')
    lines.push('  #meme清空统计 —— 排行榜清零重来')
    lines.push('  #meme插件更新 —— 更新插件本体（和 #meme更新 不是一回事）')
    lines.push('                   改到代码会自动重启，加「不重启」可以不重启')
    lines.push('  #meme版本 —— 看当前版本，并检查远端有没有新的')
    if (local) {
      lines.push('  #meme部署 —— 可选：在本机装一套 meme 服务')
      lines.push('  #meme卸载 —— 卸掉本机的 meme 服务（会先列清单让你确认）')
    }
    return lines.join('\n')
  }
}
