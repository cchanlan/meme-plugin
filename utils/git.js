import { execFile } from 'node:child_process'

/**
 * 统一的 git 调用。
 *
 * **必须是异步的**：`#meme更新` 原来走 execSync，而 execSync 会把 Node 主线程
 * 整个卡住 —— 五个表情仓库首次克隆有 1.5G，那十来分钟里 Yunzai 收不到任何消息、
 * 定时任务不跑、Web 站不响应，看着就像整个机器人死了（还没有任何日志说明原因）。
 * 部署脚本早就换成 spawn 了，只有这里是漏下来的。
 *
 * 用 execFile + 参数数组而不是拼命令字符串：
 * ① 不过 shell，Windows 上没 bash 也能跑；
 * ② 路径含空格（`C:\Program Files\…`）、分支名带奇怪字符都不用自己转义，
 *    也就不存在配置项被当成命令注入的余地；
 * ③ 卡在认证提示上能被 timeout 掐掉。
 */

// GIT_TERMINAL_PROMPT=0：私有库/凭证过期时 git 会弹交互式账号密码提示，
// 非 tty 下就是永久挂住，直到 timeout。设了它直接失败返回。
// LC_ALL=C：把「Already up to date.」钉成英文，省得跟着系统语言变
const GIT_ENV = { ...process.env, GIT_TERMINAL_PROMPT: '0', LC_ALL: 'C' }

/**
 * @param {string[]} args git 参数
 * @param {{cwd?: string, timeout?: number}} opts
 * @returns {Promise<{ok: boolean, out: string, err: string, fatal: string}>}
 */
export function git (args, { cwd, timeout = 120000 } = {}) {
  return new Promise(resolve => {
    execFile(
      'git', args,
      { cwd, env: GIT_ENV, timeout, encoding: 'utf-8', windowsHide: true, maxBuffer: 10 * 1024 * 1024 },
      (err, stdout, stderr) => resolve({
        ok: !err,
        out: String(stdout || '').trim(),
        err: String(stderr || '').trim(),
        fatal: err?.code === 'ENOENT'
          ? '找不到 git，先装一个：https://git-scm.com/downloads'
          : (err?.killed ? `git 超过 ${Math.round(timeout / 1000)} 秒没结束，已中断` : '')
      })
    )
  })
}
