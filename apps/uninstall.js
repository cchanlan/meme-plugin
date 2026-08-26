import fs from 'node:fs'
import path from 'node:path'
import os from 'node:os'
import Config from '../model/config.js'
import MemeApi from '../model/memeApi.js'
import MemeIndex from '../model/memeIndex.js'
import { dataDir, logPrefix } from '../constants/path.js'
import { pm2, pm2Proc, pm2Bin, resetPm2Cache } from '../utils/pm2.js'
import { tomlPath, reposRoot } from '../utils/memeDirs.js'
import { clearImageCaches } from '../utils/cleanup.js'
import { beginTask, endTask, busyTip } from '../utils/lock.js'

/**
 * 一键卸载本机部署的 meme 服务（`#meme部署` 的反向操作）。
 *
 * 这是**唯一会删东西**的指令，所以不走脚本、全部在 Node 里做：
 * deploy 那侧必须用 bash/PowerShell 是因为要建 venv、跑 pip、clone 仓库，
 * 而卸载只有「停进程 + 删目录 + 还原一个文件」三件事，Node 一套代码就能跨平台，
 * 还能在删之前逐项做归属校验 —— 用脚本反而要把校验逻辑在 .sh 和 .ps1 里写两遍，
 * 两份都对才安全，性价比是负的。
 *
 * 三条安全线，每条都是「宁可不删」：
 *  1. pm2 进程只删**可执行文件或工作目录落在插件数据目录里**的那个。
 *     光比进程名不够：deployPm2Name 被误填成别人的进程名（甚至就叫 meme）时，
 *     按名字删会把人家手工装的服务连 dump 一起抹掉。
 *  2. 仓库目录只删默认位置（`data/meme-plugin/repos`）。`reposDir` 指到外面
 *     （比如 `/opt/meme`）说明那是用户自己管的资源，一个字节都不动。
 *  3. config.toml 只在**首部有插件写的那行标记**时才处理，且优先还原部署时留下的
 *     `.bak.*` 备份，没有备份才删。别人的配置照原样留着。
 */

const IS_WIN = process.platform === 'win32'

/** Windows 路径大小写不敏感，比较前统一 */
function norm (p) {
  const r = path.resolve(String(p || ''))
  return IS_WIN ? r.toLowerCase() : r
}

/** p 是否在 root 里面（或就是 root） */
function isInside (p, root) {
  if (!p) return false
  const a = norm(p)
  const b = norm(root)
  return a === b || a.startsWith(b + path.sep)
}

function human (bytes) {
  if (bytes >= 1073741824) return `${(bytes / 1073741824).toFixed(2)}GB`
  if (bytes >= 1048576) return `${(bytes / 1048576).toFixed(1)}MB`
  if (bytes >= 1024) return `${(bytes / 1024).toFixed(0)}KB`
  return `${bytes}B`
}

/**
 * 递归量一个目录的体积。
 * repos 里是五个 git 仓库、几万个文件，所以设了个文件数上限：
 * 报个大概数字就够，不值得为了精确让指令卡在那里数文件。
 */
function dirStat (dir, cap = 120000) {
  let files = 0
  let bytes = 0
  let capped = false
  const walk = d => {
    if (capped) return
    let ents
    try {
      ents = fs.readdirSync(d, { withFileTypes: true })
    } catch {
      return
    }
    for (const ent of ents) {
      if (capped) return
      const full = path.join(d, ent.name)
      if (ent.isDirectory()) {
        walk(full)
      } else if (ent.isFile()) {
        files++
        if (files > cap) {
          capped = true
          return
        }
        try {
          bytes += fs.statSync(full).size
        } catch {}
      }
    }
  }
  walk(dir)
  return { files, bytes, capped }
}

/**
 * 删一棵目录树。
 * Windows 上文件被占用会 EBUSY/EPERM（venv 里的 meme.exe 刚被 pm2 停掉、
 * 句柄还没释放是常态），所以带上重试；仍然失败就把原因原样报出来，
 * 让用户知道是「被占用」而不是「没删成功但不知道为什么」。
 */
function rmTree (p) {
  try {
    fs.rmSync(p, { recursive: true, force: true, maxRetries: 6, retryDelay: 400 })
    return { ok: !fs.existsSync(p) }
  } catch (err) {
    return { ok: false, err: err.message }
  }
}

/** 部署脚本留下的备份里最新的那个（文件名带 yyyyMMdd-HHmmss，按名字排序就是按时间） */
function latestBackup (file) {
  const dir = path.dirname(file)
  const base = path.basename(file)
  let list = []
  try {
    list = fs.readdirSync(dir).filter(f => f.startsWith(`${base}.bak.`)).sort()
  } catch {}
  if (list.length) return path.join(dir, list[list.length - 1])
  // memeDirs.js 同步 meme_dirs 时写的是不带时间戳的 .bak，作为次选
  const plain = `${file}.bak`
  return fs.existsSync(plain) ? plain : null
}

/** meme-generator 下载的素材落点（localstore 的 user_data_dir） */
function materialDir () {
  const app = 'meme_generator'
  if (IS_WIN) return path.join(process.env.APPDATA || path.join(os.homedir(), 'AppData', 'Roaming'), app)
  if (process.platform === 'darwin') return path.join(os.homedir(), 'Library', 'Application Support', app)
  return path.join(process.env.XDG_DATA_HOME || path.join(os.homedir(), '.local', 'share'), app)
}

/**
 * 只看，不动任何东西 —— 先把「要删什么、为什么不删」算清楚，
 * 未确认时原样展示给用户，确认后照着执行。
 */
function makePlan () {
  const venvDir = path.join(dataDir, 'venv')
  const defaultRepos = path.join(dataDir, 'repos')
  const repoRoot = reposRoot()
  const cfgFile = tomlPath()
  const pm2Name = Config.get('deployPm2Name') || 'meme-plugin'

  const plan = {
    pm2Name,
    venv: { path: venvDir, exists: fs.existsSync(venvDir), stat: null },
    repos: {
      path: defaultRepos,
      exists: fs.existsSync(defaultRepos),
      // reposDir 指到外面就是用户自管的资源，不归卸载管
      external: norm(repoRoot) !== norm(defaultRepos),
      externalPath: repoRoot,
      stat: null
    },
    proc: { found: false, ours: false, exec: '', cwd: '', status: '' },
    // memePm2Name 指的是「用户自己那套服务」的进程，和卸载无关，
    // 但要在报告里点名说不动它 —— 这是用户发这条指令时最担心的东西
    other: { name: String(Config.get('memePm2Name') || '').trim(), found: false },
    config: { path: cfgFile, exists: fs.existsSync(cfgFile), ours: false, backup: null },
    material: { path: materialDir(), exists: false, stat: null },
    pm2Missing: false
  }

  if (plan.venv.exists) plan.venv.stat = dirStat(venvDir)
  if (plan.repos.exists) plan.repos.stat = dirStat(defaultRepos)
  if (fs.existsSync(plan.material.path)) {
    plan.material.exists = true
    plan.material.stat = dirStat(plan.material.path)
  }

  // 进程归属：名字对不上不算，路径不在数据目录里也不算
  resetPm2Cache()
  const proc = pm2Proc(pm2Name)
  if (proc) {
    const exec = proc.pm2_env?.pm_exec_path || ''
    const cwd = proc.pm2_env?.pm_cwd || ''
    plan.proc = {
      found: true,
      ours: isInside(exec, dataDir) || isInside(cwd, dataDir),
      exec,
      cwd,
      status: proc.pm2_env?.status || ''
    }
  } else if (!pm2Bin()) {
    plan.pm2Missing = true
  }
  if (plan.other.name && plan.other.name !== pm2Name) {
    plan.other.found = !!pm2Proc(plan.other.name)
  }

  // 配置归属：认部署脚本写在首行的那句标记
  if (plan.config.exists) {
    try {
      const head = fs.readFileSync(cfgFile, 'utf-8').slice(0, 400)
      plan.config.ours = /meme-plugin/.test(head)
    } catch {}
    plan.config.backup = latestBackup(cfgFile)
  }

  return plan
}

/** 一行「路径（体积）」 */
function sizeOf (stat) {
  if (!stat) return ''
  return `，${stat.files}${stat.capped ? '+' : ''} 个文件 / ${human(stat.bytes)}`
}

/**
 * 计划 → 预览文本。
 * 「不会动的东西」必须和「要删的东西」一样醒目：卸载指令最容易让人担心的
 * 就是「它会不会顺手把我自己装的那套也删了」，把边界写清楚比少几行字重要。
 */
function renderPlan (plan, all) {
  const del = []
  const keep = []

  if (plan.proc.found && plan.proc.ours) {
    del.push(`· pm2 进程 ${plan.pm2Name}（当前 ${plan.proc.status || '未知'}）并 pm2 save`)
  } else if (plan.proc.found) {
    keep.push(`· pm2 进程 ${plan.pm2Name}：不是插件部署的（exec=${plan.proc.exec || '?'}，cwd=${plan.proc.cwd || '?'}），不动`)
  } else if (plan.pm2Missing) {
    keep.push('· pm2：没找到可执行文件，跳过进程处理')
  }
  if (plan.other.found) {
    keep.push(`· pm2 进程 ${plan.other.name}：你自己那套服务（配置 memePm2Name），不动`)
  }

  if (plan.venv.exists) del.push(`· venv 目录 ${plan.venv.path}${sizeOf(plan.venv.stat)}`)

  if (plan.repos.external) {
    keep.push(`· 表情仓库 ${plan.repos.externalPath}：在插件数据目录之外（你自己管的），一个字节都不动`)
  }
  // 默认位置那份是另一件事：reposDir 指到外面时，这里可能还留着早先克隆的副本
  // （README 里「白占一份磁盘」那个坑），它确实在插件数据目录里，归卸载管
  if (plan.repos.exists) {
    const tail = plan.repos.external ? '（reposDir 指到别处了，这是残留副本）' : ''
    if (all) del.push(`· 表情仓库 ${plan.repos.path}${sizeOf(plan.repos.stat)}${tail}`)
    else keep.push(`· 表情仓库 ${plan.repos.path}${sizeOf(plan.repos.stat)}${tail}：默认保留，要删发 #meme卸载全部确认`)
  }

  if (plan.config.exists && plan.config.ours) {
    del.push(plan.config.backup
      ? `· config.toml 还原成部署前的备份（${path.basename(plan.config.backup)}）`
      : `· config.toml ${plan.config.path}（是插件生成的，没有备份可还原所以删除）`)
  } else if (plan.config.exists) {
    keep.push(`· config.toml ${plan.config.path}：不是插件生成的，不动`)
  }

  if (plan.material.exists) {
    // Windows 和 macOS 上 localstore 的 data dir 与 config dir 是同一个目录，
    // 删素材会把 config.toml 一起带走 —— 所以三个平台统一只报告不删
    const why = IS_WIN || process.platform === 'darwin'
      ? '它和 config.toml 同一个目录'
      : '重装时还能省一次下载'
    keep.push(`· 表情素材 ${plan.material.path}${sizeOf(plan.material.stat)}：不删（${why}），要清自己删`)
  }

  return { del, keep }
}

/**
 * 把部署时改过的配置项改回来。
 * 只回滚**值仍然等于部署时写进去的那个**的项：用户后来自己改成别的（比如把
 * memeApiUrl 指到局域网另一台服务）就说明他有别的打算，卸载不该替他决定。
 */
function rollbackConfig () {
  const rolled = []
  const pm2Name = Config.get('deployPm2Name') || 'meme-plugin'
  const port = Number(Config.get('deployPort')) || 2233

  if (Config.get('deployed')) {
    Config.set('deployed', false)
    rolled.push('deployed → false')
  }
  if (Config.get('memePm2Name') === pm2Name) {
    Config.set('memePm2Name', 'meme')
    rolled.push('memePm2Name → meme')
  }
  if (Config.getApiUrl() === `http://127.0.0.1:${port}` && port !== 2233) {
    Config.set('memeApiUrl', 'http://127.0.0.1:2233')
    rolled.push('memeApiUrl → http://127.0.0.1:2233')
  }
  if (Config.get('serviceMode') === 'local') {
    Config.set('serviceMode', 'auto')
    rolled.push('serviceMode → auto')
  }
  return rolled
}

export class memeUninstall extends plugin {
  constructor () {
    super({
      name: 'meme卸载',
      dsc: '卸载本机部署的 meme 服务（#meme部署 的反向操作）',
      event: 'message',
      priority: 4000,
      rule: [
        {
          reg: '^#?meme卸载(全部)?(确认)?$',
          fnc: 'uninstall',
          permission: 'master'
        }
      ]
    })
  }

  async uninstall (e) {
    const msg = String(e.msg || '')
    const all = /卸载全部/.test(msg)
    const confirmed = /确认$/.test(msg)

    const plan = makePlan()
    const { del, keep } = renderPlan(plan, all)

    // 没有任何属于插件的东西 —— 常见于用外部服务的用户，说清楚就好，别报错
    if (!del.length) {
      const lines = ['✅ 没有发现由 #meme部署 装出来的东西，不需要卸载']
      if (keep.length) lines.push('\n下面这些不是插件部署的，卸载也不会碰它们：', ...keep)
      await e.reply(lines.join('\n'))
      return true
    }

    if (!confirmed) {
      const lines = ['🗑 meme 后端卸载预检\n', '会删除：', ...del]
      if (keep.length) lines.push('\n不会动：', ...keep)
      lines.push(`\n确认请发：#meme卸载${all ? '全部' : ''}确认`)
      if (!all && plan.repos.exists) {
        lines.push('（连表情仓库一起删：#meme卸载全部确认，仓库有好几个 G，重装要重新拉）')
      }
      await e.reply(lines.join('\n'))
      return true
    }

    // 卸载和部署/更新会动同一批东西，不能并行（连点两下会一边删 venv 一边重装）
    if (!beginTask('卸载服务')) {
      await e.reply(busyTip('卸载'))
      return true
    }
    let result
    try {
      await e.reply('🗑 开始卸载，正在停进程、删目录…')
      result = this.doUninstall(plan, all)
    } finally {
      endTask()
    }
    const { done, fail, freed } = result

    // 卸载完再探一次服务：还连得上（比如用户自己那套服务在跑、或 memeApiUrl 指着
    // 别的机器）就别清索引，表情照旧能用。连不上才清 —— 索引是第二层缓存，
    // 留着的话重启 Yunzai 会把 944 个表情原样载回来，列表、搜索、Web 站看着
    // 一切正常，一发指令才报连不上，这比「表情列表空了」难懂得多
    const stillAlive = await MemeApi.ping()
    if (!stillAlive) {
      const removed = MemeIndex.clear()
      const imgs = clearImageCaches()
      if (removed || imgs) {
        done.push(`已清空本地索引和出图缓存（${removed} 个索引文件 / ${imgs} 张图）`)
      }
    }

    const lines = ['🗑 卸载完成\n']
    if (done.length) lines.push(...done.map(t => `✅ ${t}`))
    if (fail.length) lines.push('', ...fail.map(t => `❌ ${t}`))
    if (freed) lines.push(`\n共回收约 ${human(freed)}`)
    if (keep.length) lines.push('\n保留未动：', ...keep)
    // 结尾这句得看情况：把用户自己那套服务说成「没服务了」会让人以为卸载删多了
    if (stillAlive) {
      lines.push(`\n💡 ${Config.getApiUrl()} 还连得上，表情功能不受影响，本地索引也照旧留着`)
    } else if (plan.proc.found && plan.proc.ours) {
      lines.push('\n💡 插件部署的那套服务已经没了，表情列表会变空 —— 这是故意的，' +
        '免得列表里一堆点了却生成不了的表情。要恢复：把配置 memeApiUrl 指向现成服务后发 #meme刷新，或重新发 #meme部署')
    } else {
      lines.push('\n💡 表情功能需要一个能连上的 meme 服务：配置 memeApiUrl 指过去后发 #meme刷新，或发 #meme部署')
    }
    await e.reply(lines.join('\n'))
    logger.info(`${logPrefix}卸载完成：${done.length} 项成功，${fail.length} 项失败`)
    return true
  }

  /**
   * 真正动手的部分。顺序有讲究：**先停进程再删目录**。
   * 反过来在 Windows 上必炸 —— 正在跑的 meme.exe 就在 venv 里，
   * 文件被占用时 rmSync 报 EBUSY/EPERM，删一半留一半更难收拾。
   */
  doUninstall (plan, all) {
    const done = []
    const fail = []
    let freed = 0

    // 1. pm2：只删归属校验过的那个，删完必须 save，否则重启机器 dump 又把它拉起来
    if (plan.proc.found && plan.proc.ours) {
      const r = pm2(['delete', plan.pm2Name])
      if (r.ok) {
        done.push(`已停止并删除 pm2 进程「${plan.pm2Name}」`)
        const s = pm2(['save'])
        if (s.ok) done.push('已 pm2 save（重启机器不会再被拉起来）')
        else fail.push(`pm2 save 失败，dump 里还留着这个进程：${s.err || '未知原因'}`)
      } else {
        fail.push(`pm2 delete 失败：${r.err || '未知原因'}`)
      }
    }

    // 2. venv
    if (plan.venv.exists) {
      const r = rmTree(plan.venv.path)
      if (r.ok) {
        done.push(`已删除 venv${sizeOf(plan.venv.stat)}`)
        freed += plan.venv.stat?.bytes || 0
      } else {
        fail.push(`删除 venv 失败：${r.err || '目录还在'}${IS_WIN ? '（文件可能仍被占用，稍等再试一次）' : ''}`)
      }
    }

    // 3. 仓库：只有 #meme卸载全部 才删，而且只删插件数据目录里那份
    if (all && plan.repos.exists) {
      const r = rmTree(plan.repos.path)
      if (r.ok) {
        done.push(`已删除表情仓库${sizeOf(plan.repos.stat)}`)
        freed += plan.repos.stat?.bytes || 0
      } else {
        fail.push(`删除表情仓库失败：${r.err || '目录还在'}`)
      }
    }

    // 4. config.toml：能还原就还原，还原不了才删；备份文件本身留着
    if (plan.config.exists && plan.config.ours) {
      if (plan.config.backup) {
        try {
          fs.copyFileSync(plan.config.backup, plan.config.path)
          done.push(`config.toml 已还原成部署前的备份（${path.basename(plan.config.backup)}）`)
        } catch (err) {
          fail.push(`还原 config.toml 失败：${err.message}`)
        }
      } else {
        try {
          fs.rmSync(plan.config.path, { force: true })
          done.push(`已删除 config.toml（${plan.config.path}）`)
        } catch (err) {
          fail.push(`删除 config.toml 失败：${err.message}`)
        }
      }
    }

    // 5. 配置回滚放最后：前面哪一步炸了也不影响这几个值该改回去
    const rolled = rollbackConfig()
    if (rolled.length) done.push(`插件配置已回滚：${rolled.join('、')}`)

    return { done, fail, freed }
  }
}
