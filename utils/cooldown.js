/**
 * 群级冷却。
 *
 * 「抽个CP」「整活」这两条一次要跑 1~9 次生成 + 一次 puppeteer 截图，是全插件
 * 最贵的两条指令。meme 服务是单进程 Python，被连点几下就会把普通 `#摸头`
 * 一起拖慢，所以按「群 + 玩法」单独限一段冷却。
 *
 * 不用 utils/lock.js 那把锁：那是给部署/更新/卸载用的 20 分钟长任务互斥，
 * 全局只有一把，用在这里会让 A 群玩一次就把 B 群也挡住。
 *
 * 状态挂 global：apps 热更会重新 import 本模块，模块级变量会跟着归零，
 * 冷却就白设了（这条坑和 lock.js、stats.js 的 exit 钩子是同一个）。
 */

const KEY = 'memePluginCooldownMap'

/** @returns {Map<string, number>} scope → 到期时间戳 */
function store () {
  if (!global[KEY]) global[KEY] = new Map()
  return global[KEY]
}

/**
 * 还要等多久
 * @param {string} scope 冷却范围，如 `cp:123456`
 * @returns {number} 剩余秒数，0 表示可以用了
 */
export function coolLeft (scope) {
  const until = store().get(scope)
  if (!until) return 0
  const left = until - Date.now()
  if (left <= 0) {
    store().delete(scope)
    return 0
  }
  return Math.ceil(left / 1000)
}

/**
 * 记一次使用，开始冷却
 * @param {string} scope
 * @param {number} seconds 冷却秒数，<=0 视为不冷却
 */
export function markCool (scope, seconds) {
  if (!(seconds > 0)) return
  const map = store()
  map.set(scope, Date.now() + seconds * 1000)
  // 进了上千个群时这个 Map 会跟着群数长，顺手把过期的清掉。
  // 只在条目偏多时扫，平时不做无谓遍历
  if (map.size > 200) {
    const now = Date.now()
    for (const [k, v] of map) {
      if (v <= now) map.delete(k)
    }
  }
}
