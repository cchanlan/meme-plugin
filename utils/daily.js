import crypto from 'node:crypto'

/**
 * 今日表情：同一个人、同一天，抽到的永远是同一个表情。
 *
 * 靠 md5(QQ号 + 当天日期) 定结果而不是随机数 —— 一天里反复发也不会变，
 * 「换到满意为止」就没意义了，那点确定性才是这玩法好玩的地方。
 *
 * 日期取**本地时区**：服务器多半在 UTC+8，用 UTC 会让「今天」在早上八点才换。
 */

/** 运势文案。短、说人话，别写成算命 */
const FORTUNES = [
  '手气不错，随便抽都能出好图',
  '宜整活，忌熬夜',
  '今天适合摸鱼，不适合动脑',
  '运气平平，但表情很顶',
  '今天适合被摸头，去找人要一个',
  '说话会有人接，多冒泡',
  '适合安静待着，少发言少出事',
  '今天做什么都慢半拍，别急',
  '会遇到好笑的事，记得截图',
  '状态在线，适合干正事'
]

/** 本地时区的 YYYY-MM-DD */
export function localDate (d = new Date()) {
  const p = n => String(n).padStart(2, '0')
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}`
}

/** uid + 日期 → 一串稳定的字节 */
function digestOf (uid, date) {
  return crypto.createHash('md5').update(`${uid}|${date}`).digest()
}

/**
 * 挑今天的表情和运势。
 *
 * pool 会**先排序再取模**：候选是从 `Object.keys(infos)` 来的，
 * 那个顺序会随 `#meme更新` 变；不排序的话同一天更新一次表情，
 * 大家的「今日表情」就集体换了一个，说不清。
 *
 * @param {string|number} uid
 * @param {string[]} pool 候选表情 code
 * @param {string} date 默认今天
 * @returns {{code: string, fortune: string}|null} pool 为空时返回 null
 */
export function pickDaily (uid, pool, date = localDate()) {
  if (!pool?.length) return null
  const sorted = [...pool].sort()
  const d = digestOf(uid, date)
  return {
    code: sorted[d.readUInt32BE(0) % sorted.length],
    fortune: FORTUNES[d.readUInt32BE(4) % FORTUNES.length]
  }
}
