import Config from '../model/config.js'

/**
 * 用户是否被拉黑。
 *
 * 锅巴面板里 QQ 号可能存成数字也可能存成字符串，统一转字符串再比，
 * 否则 10001 和 "10001" 会判成两个人。
 */
export function isBlackUser (userId) {
  const raw = Config.get('blackUsers') || []
  const list = (Array.isArray(raw) ? raw : [raw]).map(x => String(x).trim()).filter(Boolean)
  if (list.length === 0) return false
  return list.includes(String(userId))
}
