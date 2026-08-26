/**
 * 长任务互斥。
 *
 * 部署、更新、卸载这三条指令都会动同一批东西（venv 目录、表情仓库、config.toml、
 * pm2 进程、索引文件），而它们各自要跑几十秒到十几分钟。主人在群里手快连点两下
 * `#meme更新`，就会有两个 git pull 抢同一个仓库、两次 pm2 restart 打断彼此的
 * waitReady，最后索引刷成谁也说不清的状态 —— 而且过程里没有任何提示。
 *
 * 锁挂在 global 上而不是模块变量：apps 热更会把模块重新 import 一遍，
 * 模块级变量会跟着归零，锁就白设了。
 *
 * 带过期时间兜底：进程没崩但任务半路抛在了 finally 之外（或者被 kill -9 之后
 * 又恰好读到旧 global）时，锁不能把功能永久钉死。
 */

const KEY = 'memePluginTaskLock'
/** 最长持锁时间。部署脚本自己的超时是 15 分钟，留点余量 */
const MAX_MS = 20 * 60 * 1000

/** 当前正在跑的任务名，空串表示没有 */
export function runningTask () {
  const lock = global[KEY]
  if (!lock) return ''
  if (Date.now() - lock.at > MAX_MS) {
    delete global[KEY]
    return ''
  }
  return lock.name
}

/**
 * 尝试上锁
 * @returns {boolean} 拿到锁返回 true；已经有别的任务在跑返回 false
 */
export function beginTask (name) {
  if (runningTask()) return false
  global[KEY] = { name, at: Date.now() }
  return true
}

export function endTask () {
  delete global[KEY]
}

/** 「有别的任务在跑」时回给用户的话 */
export function busyTip (want) {
  return `⏳ 正在执行「${runningTask()}」，${want} 得等它跑完\n（这几条指令会动同一批文件和同一个服务进程，不能同时来）`
}
