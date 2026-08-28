import _ from 'lodash'
import Config from '../model/config.js'
import MemeIndex from '../model/memeIndex.js'

/**
 * 「抽个CP」「整活」的候选表情池。
 *
 * 这两条指令是**插件替用户挑表情**，跟 `#摸头` 那种用户自己点名的性质不一样：
 * 挑中什么就直接发出去，没人来得及拦。而索引里 728 个单图表情和 52 个双图表情里
 * 混着相当一批成人向的（装了 crazy_emoji 之后尤其多），一次「整活」连出 6 张，
 * 撞上一张就够社死。所以这里在索引层的 blackMemes 之外再收一道：
 *
 * 1. protectList —— 现成的 41 项敏感表情清单（原本只用于「反撅主人」），
 *    实测能挡掉 34 个单图 + 7 个双图
 * 2. funExcludeWords —— 按关键词/tag 匹配的词表兜底。protectList 是主人手工维护的
 *    固定 key 列表，新装一个仓库就会漏；词表对新表情同样生效，实测再挡掉
 *    16 个单图（舔系列、飞机杯…）+ 7 个双图
 *
 * 两道都能在配置里关掉/改词（funSafeOnly、funExcludeWords）——
 * 有人就是想玩这些，但那得是他自己明确打开的。
 */

/** 拿到当前生效的排除词，全部转小写好比 tag 里的英文 */
function excludeWords () {
  const raw = Config.get('funExcludeWords') || []
  return (Array.isArray(raw) ? raw : [raw])
    .map(x => String(x).trim().toLowerCase())
    .filter(Boolean)
}

/**
 * 过滤出「适合随机整活」的表情
 * @param {string[]} codes 候选 code（调用方先用 MemeIndex 拿，黑名单已过滤过）
 * @returns {string[]}
 */
export function safePool (codes) {
  if (!Config.get('funSafeOnly')) return codes
  const protect = new Set(Config.get('protectList') || [])
  const words = excludeWords()
  return codes.filter(code => {
    if (protect.has(code)) return false
    if (!words.length) return true
    const info = MemeIndex.infos[code] || {}
    const texts = [...(info.keywords || []), ...(info.tags || [])].map(s => String(s).toLowerCase())
    return !texts.some(t => words.some(w => t.includes(w)))
  })
}

/**
 * 随机取 n 个不重复元素。
 * lodash 的 sampleSize 就是这个语义，直接用；单独包一层是为了
 * 让调用方不必关心「候选比 n 少」这种情况（返回全部即可）。
 */
export function pickSome (arr, n) {
  return _.sampleSize(arr, Math.min(n, arr.length))
}

async function getMasterQQ () {
  return (await import('../../../lib/config/config.js')).default.masterQQ
}

/**
 * 主人在参与者里时，把 protectList 里的表情从候选池摘掉。
 *
 * `#摸头` 那条路上的主人保护是「反撅」——把图片顺序调过来。随机玩法做不到：
 * 表情是随机抽的、人也可能是随机抽的，反弹之后出来的画面和文案对不上
 * （「A × B」的图里却是 B 撅 A）。既然本来就是插件替用户挑，不挑那些最干脆。
 *
 * 这一层独立于 safePool 而不是并进去：funSafeOnly 默认已经把 protectList 全过滤了，
 * 但它**可以关掉**，关掉之后若这里不拦，`#整活 @主人` 就成了绕过 masterProtect
 * 的批量入口。放在 utils 里也好脱机测 —— apps 下的文件只能有一个导出。
 *
 * @param {string[]} codes
 * @param {Array<string|number>} uids 参与者
 */
export async function dropProtectedIfMaster (codes, uids) {
  if (!Config.get('masterProtect')) return codes
  const masters = (await getMasterQQ()).map(q => String(q))
  if (!uids.some(u => masters.includes(String(u)))) return codes
  const protect = new Set(Config.get('protectList') || [])
  return codes.filter(code => !protect.has(code))
}
