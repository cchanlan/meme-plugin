import fs from 'node:fs'
import path from 'node:path'
import Config from '../model/config.js'
import { git } from './git.js'
import { reposRoot } from './memeDirs.js'
import { mkdirs } from './file.js'

/**
 * 拉取 / 更新订阅的表情仓库。
 *
 * 这段逻辑原来整个内联在 `#meme更新` 里，而 docker 部署也要用同一套（装完顺手把
 * 仓库拉下来，不然用户看到的只有内置表情，会以为装坏了），所以抽出来共用。
 * 从头到尾只有这一份 Node 实现 —— `resources/deploy/deploy.sh` 里那份是 shell 侧、
 * 只服务于 venv 部署，两边不共享也没法共享。
 *
 * 行为与抽取前逐字一致：同一个仓库只做一件事（克隆 / 更新 / 无变化 / 失败），
 * 进度文案由调用方通过 onMessage 收到，自己决定怎么攒、什么时候发。
 */

/** 单个仓库的路径。必须和写进 meme_dirs 的那份一致，所以复用 reposRoot() */
export function resolveRepoPath (repo) {
  return path.join(reposRoot(), repo.dir)
}

/**
 * @param {{onMessage?: (text: string) => void}} opts
 * @returns {Promise<{total:number, cloned:number, updated:number, noChange:string[], failed:{name:string,error:string}[], hasUpdates:boolean}>}
 */
export async function syncRepos ({ onMessage } = {}) {
  const repos = Config.get('repos') || []
  const msg = t => { if (t) onMessage?.(t) }
  const result = { total: repos.length, cloned: 0, updated: 0, noChange: [], failed: [], hasUpdates: false }
  if (repos.length === 0) return result

  mkdirs(reposRoot())

  for (const repo of repos) {
    const repoPath = resolveRepoPath(repo)
    try {
      // 仓库不存在就克隆
      if (!fs.existsSync(path.join(repoPath, '.git'))) {
        const url = Config.proxyUrl(repo.url)
        const c = await git(
          ['clone', '--depth', '1', '-b', String(repo.branch || 'main'), url, repoPath],
          { timeout: 600000 }
        )
        if (!c.ok) throw new Error(c.fatal || c.err || c.out || 'git clone 失败')
        result.cloned++
        result.hasUpdates = true
        msg(`📥 ${repo.name} 首次克隆完成`)
        continue
      }

      const oldHead = await git(['rev-parse', 'HEAD'], { cwd: repoPath, timeout: 15000 })
      const pull = await git(['pull'], { cwd: repoPath, timeout: 600000 })
      if (!pull.ok) throw new Error(pull.fatal || pull.err || pull.out || 'git pull 失败')
      const newHead = await git(['rev-parse', 'HEAD'], { cwd: repoPath, timeout: 15000 })

      if (oldHead.out && oldHead.out === newHead.out) {
        // 没更新的攒起来一句话带过，不逐个报
        result.noChange.push(repo.name)
        continue
      }

      result.updated++
      result.hasUpdates = true
      const [diff, logs] = await Promise.all([
        git(['diff', '--name-only', `${oldHead.out}..${newHead.out}`], { cwd: repoPath, timeout: 30000 }),
        git(['log', '--pretty=format:%s', `${oldHead.out}..${newHead.out}`], { cwd: repoPath, timeout: 30000 })
      ])
      const diffFiles = diff.out.split('\n').filter(Boolean)

      msg(`✅ ${repo.name}：${diffFiles.length} 个文件`)
      if (logs.out) {
        const first = logs.out.split('\n')[0]
        msg(`   ${first.length > 60 ? first.slice(0, 60) + '…' : first}`)
      }
    } catch (err) {
      result.failed.push({ name: repo.name, error: err.message })
      let errMsg = `❌ ${repo.name} 失败：`
      if (err.message.includes('not a git repository')) errMsg += '目录不是 git 仓库'
      else if (/Could not resolve host|Failed to connect/i.test(err.message)) errMsg += '网络不通，检查 gitProxy'
      else if (err.message.includes('Authentication failed')) errMsg += '认证失败'
      else errMsg += err.message.split('\n')[0].slice(0, 60)
      msg(errMsg)
    }
  }

  return result
}
