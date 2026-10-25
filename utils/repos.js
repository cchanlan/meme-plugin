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
 * 直连 GitHub 失败时依次试的公共前缀镜像。
 *
 * 真实报障：ArchWSL 里的 TRSS 那台机器，`git clone github.com` 五个仓库全部
 * `Connection was reset` / `port 443 after 21077 ms`，一个都没拉到，用户只拿到
 * 295 个内置表情，还以为插件装坏了。锅巴里是有 `gitProxy` 配置项，但默认空着，
 * 用户根本不知道该往里填什么。
 *
 * 下面两个是 2026-10-26 在服务器上 `git ls-remote` 实测能用的；
 * gh-proxy.com 无响应、ghproxy.cc 证书报错，已剔除。公共镜像会挂，
 * 所以只当兜底 —— 用户自己配了 gitProxy 就完全按配置走，不拿镜像插手。
 */
const FALLBACK_MIRRORS = ['https://ghfast.top/', 'https://ghproxy.net/']

/**
 * 克隆一个表情仓库，直连不通就换镜像。
 *
 * 每次重试前都把目标目录删干净：git clone 断在中途会留下半个仓库，
 * 下一次再 clone 就是「already exists and is not an empty directory」，
 * 从此这个仓库在这台机器上永远拉不下来 —— 比网络不通更难查。
 *
 * @param {any} repo
 * @param {string} repoPath
 * @param {string} preferredMirror 本次同步里已经试通的前缀，加快后续仓库
 * @returns {Promise<{ok: true, viaMirror: string} | {ok: false, error: string}>}
 */
async function cloneRepo (repo, repoPath, preferredMirror) {
  const urls = []
  const push = u => { if (u && !urls.includes(u)) urls.push(u) }

  if (preferredMirror) push(preferredMirror + repo.url)
  // 配置里的前缀（默认就是镜像）、直连、其余镜像 —— 三条路都留着。
  // 不能因为「用户配了前缀」就把兜底关掉：前缀镜像本身也会挂，
  // 关了兜底等于把人锁死在一条死路上
  push(Config.proxyUrl(repo.url))
  push(repo.url)
  FALLBACK_MIRRORS.forEach(m => push(m + repo.url))

  let error = '克隆失败'
  for (const url of urls) {
    const c = await git(
      ['clone', '--depth', '1', '-b', String(repo.branch || 'main'), url, repoPath],
      { timeout: 600000 }
    )
    if (c.ok) {
      return { ok: true, viaMirror: url === repo.url ? '' : url.slice(0, url.length - repo.url.length) }
    }
    error = c.fatal || c.err || c.out || '克隆失败'
    fs.rmSync(repoPath, { recursive: true, force: true })
  }
  return { ok: false, error }
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

  // 本次同步里探到的可用镜像：第一个仓库试通了，后面几个直接跟着用
  let mirror = ''

  mkdirs(reposRoot())

  for (const repo of repos) {
    const repoPath = resolveRepoPath(repo)
    try {
      // 仓库不存在就克隆
      if (!fs.existsSync(path.join(repoPath, '.git'))) {
        const r = await cloneRepo(repo, repoPath, mirror)
        if (!r.ok) throw new Error(r.error)
        if (r.viaMirror) mirror = r.viaMirror
        result.cloned++
        result.hasUpdates = true
        msg(`📥 ${repo.name} 首次克隆完成${r.viaMirror ? `（走镜像 ${r.viaMirror}）` : ''}`)
        continue
      }

      const oldHead = await git(['rev-parse', 'HEAD'], { cwd: repoPath, timeout: 15000 })
      const pull = await git(['pull'], { cwd: repoPath, timeout: 600000 })
      if (!pull.ok) throw new Error(pull.fatal || pull.err || pull.out || '拉取失败')
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
      else if (/Could not resolve host|Failed to connect|Connection was reset|timed out|Couldn't connect/i.test(err.message)) {
        errMsg += '网络不通，直连和默认镜像都没成功 —— 去锅巴填「GitHub 代理前缀」（如 https://ghfast.top/）再发 #meme更新'
      }
      else if (err.message.includes('Authentication failed')) errMsg += '认证失败'
      else errMsg += err.message.split('\n')[0].slice(0, 60)
      msg(errMsg)
    }
  }

  return result
}
