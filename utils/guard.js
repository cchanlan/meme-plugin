import Config from '../model/config.js'
import { isBlackUser } from './black.js'

/**
 * 群级开关 + 统一的「该不该响应」判断。
 *
 * 开关状态存进配置的 disabledGroups（而不是另开一个 json）：
 * 一是锅巴面板里能直接看到、手动增删，二是配置本来就有 chokidar 热重载，
 * 多进程/热更后不会读到旧值。开关频率很低，写 yaml 的开销无所谓。
 *
 * 存「关掉的群」而不是「开启的群」——默认全开，新入的群不用先开一遍。
 */

function readList () {
  const raw = Config.get('disabledGroups') || []
  return (Array.isArray(raw) ? raw : [raw]).map(x => String(x).trim()).filter(Boolean)
}

/** 这个群是否被关掉了表情功能 */
export function isGroupDisabled (groupId) {
  if (!groupId) return false
  return readList().includes(String(groupId))
}

/**
 * 开 / 关某个群
 * @returns {boolean} 状态是否真的变了（已经是目标状态时返回 false，好回「本来就是」）
 */
export function setGroupEnabled (groupId, on) {
  const id = String(groupId)
  const list = readList()
  const has = list.includes(id)
  if (on === !has) return false
  Config.set('disabledGroups', on ? list.filter(x => x !== id) : [...list, id])
  return true
}

/** 关掉的群数量，给帮助/状态用 */
export function disabledCount () {
  return readList().length
}

/**
 * 表情相关指令该不该响应。
 *
 * 拉黑的人和关掉的群都是**静默放行**（返回 true 让调用方 return false），
 * 不回任何提示 —— 回「本群已关闭」在被刷指令时反而变成帮着刷屏。
 * 管理指令（#meme更新 等）不走这里：主人在关掉的群里照样要能维护。
 */
export function blocked (e) {
  if (isBlackUser(e.user_id)) return true
  if (e.group_id && isGroupDisabled(e.group_id)) return true
  return false
}

/**
 * 索引为空时的统一提示（列表 / 搜索 / 分类共用）。
 *
 * 原本三处都写「请先发 #meme更新」，但**卸载完本机服务**之后索引会被清空，
 * 这时候发 #meme更新 只会再撞一次「连不上」——得把「换个地址」和「装一套」
 * 两条出路一起给出来，否则用户只能在同一条死路上来回撞。
 */
export function emptyIndexTip () {
  return '😶 本地还没有表情索引\n' +
    `有能连上的 meme 服务就发 #meme刷新 拉一次（当前地址：${Config.getApiUrl()}）\n` +
    '本机没有服务的话发 #meme部署 装一套，或把配置 memeApiUrl 指向现成的服务'
}
