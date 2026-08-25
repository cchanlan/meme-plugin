import MemeIndex from '../model/memeIndex.js'
import { isGroupDisabled, setGroupEnabled, disabledCount } from '../utils/guard.js'

/**
 * 群级开关。
 *
 * permission: 'admin' 交给 Yunzai 判权限：主人直接放行，群里要 is_owner / is_admin，
 * 普通群员由 loader 回「暂无权限，只有管理员才能操作」，不用自己写。
 * 但 filtPermission 在私聊时对 admin 是直接放行的，所以群号仍要自己兜一道。
 */
export class memeSwitch extends plugin {
  constructor () {
    super({
      name: 'meme开关',
      dsc: '按群开启/关闭表情包功能',
      event: 'message',
      priority: 4000,
      rule: [
        {
          reg: '^#?meme(s)?(开启|启用|打开|on)$',
          fnc: 'turnOn',
          permission: 'admin'
        },
        {
          reg: '^#?meme(s)?(关闭|禁用|停用|off)$',
          fnc: 'turnOff',
          permission: 'admin'
        },
        {
          reg: '^#?meme(s)?开关$',
          fnc: 'status'
        }
      ]
    })
  }

  async turnOn (e) {
    if (!e.group_id) {
      await e.reply('这个开关是按群设的，请在群里发~')
      return true
    }
    if (!setGroupEnabled(e.group_id, true)) {
      await e.reply('本群的表情包本来就是开着的呀~')
      return true
    }
    await e.reply(`✅ 本群表情包已开启\n${MemeIndex.memeCount} 个表情随便玩，发 #meme帮助 看用法`)
    return true
  }

  async turnOff (e) {
    if (!e.group_id) {
      await e.reply('这个开关是按群设的，请在群里发~')
      return true
    }
    if (!setGroupEnabled(e.group_id, false)) {
      await e.reply('本群的表情包已经是关闭状态了')
      return true
    }
    // 关掉之后除了这条开关指令，其余表情指令一律静默不响应
    await e.reply('🔇 本群表情包已关闭\n重新开启：#meme开启（群管或主人）')
    return true
  }

  /** 查状态不限权限：群员想知道「为什么没反应」时能自己看一眼 */
  async status (e) {
    if (!e.group_id) {
      await e.reply(`表情包开关是按群设的。当前有 ${disabledCount()} 个群处于关闭状态`)
      return true
    }
    const off = isGroupDisabled(e.group_id)
    await e.reply(
      `本群表情包：${off ? '🔇 已关闭' : '✅ 已开启'}\n` +
      `${off ? '开启' : '关闭'}：#meme${off ? '开启' : '关闭'}（群管或主人）`
    )
    return true
  }
}
