import fs from 'node:fs'
import path from 'node:path'
import { spawn, execSync } from 'node:child_process'
import Config from '../model/config.js'
import MemeApi from '../model/memeApi.js'
import MemeIndex from '../model/memeIndex.js'
import { dataDir, pluginResources, logPrefix } from '../constants/path.js'
import { encodedCommandArgv, cleanPsError, looksBlocked } from '../utils/psShell.js'
import { pm2Bin, pm2Proc, resetPm2Cache } from '../utils/pm2.js'
import { venvMemePath, reposRoot } from '../utils/memeDirs.js'
import {
  containerInfo, containerLogs, countMountedDirs, daemonState, isOurs, memeDirsEnv,
  portFree, recreateContainer, resetDockerCache, imageName
} from '../utils/docker.js'
import { syncRepos } from '../utils/repos.js'
import { beginTask, endTask, busyTip } from '../utils/lock.js'

const IS_WIN = process.platform === 'win32'

/**
 * Windows 上优先用 pwsh（PowerShell 7）。
 *
 * 装了 Windows Terminal 的机器基本都有 pwsh，而系统自带的 powershell.exe 是 5.1：
 * 它读 .ps1 时**不看 UTF-8 就按系统 ANSI(GBK) 解码**，本脚本满篇中文，
 * 轻则提示乱码、重则把字符串解成半个字节序列。pwsh 7 默认 UTF-8，没这问题。
 * 找不到 pwsh 才退回 powershell.exe（脚本已加 BOM，5.1 也能正确读中文）。
 *
 * 除了 PATH 还按安装目录翻一遍：pwsh 是装完之后才写进机器 PATH 的，
 * 已经跑着的 Yunzai 看不到这次变更（同 utils/pm2.js 里那套道理）。
 */
function winShell () {
  const dirs = [
    process.env.ProgramFiles,
    process.env['ProgramFiles(x86)'],
    process.env.LOCALAPPDATA && path.join(process.env.LOCALAPPDATA, 'Microsoft')
  ].filter(Boolean)
  const cands = ['pwsh.exe', 'pwsh']
  for (const d of dirs) {
    const p = d.endsWith('Microsoft')
      ? path.join(d, 'WindowsApps', 'pwsh.exe')
      : path.join(d, 'PowerShell', '7', 'pwsh.exe')
    if (fs.existsSync(p)) cands.push(p)
  }
  for (const exe of cands) {
    try {
      execSync(`"${exe}" -NoProfile -Command "exit 0"`, { stdio: 'ignore', timeout: 15000 })
      return exe
    } catch {}
  }
  return 'powershell.exe'
}

/**
 * 部署脚本与解释器按平台分派。
 * Windows 上没有 bash（除非装了 Git Bash / WSL），所以另备一份 PowerShell 脚本，
 * 两边输出同一套 ::STEP:: / ::OK:: / ::FAIL:: 标记，解析逻辑可以共用。
 *
 * PowerShell 侧用**命名参数**而不是位置参数：`-File` 会把命令行上的空字符串
 * 直接丢掉，gitProxy 留空这种常见情况会让后面所有参数整体前移一位
 * （端口值挪到 GitProxy 上，[int]$Port 绑定失败 → 退出码 1 且一个字都不输出）。
 * 命名参数按名字绑定，空值干脆不传、让脚本用默认值。
 */
/**
 * 从这句话里读出「装法」和「确认」。
 *
 * 无状态：不记 pending、不等下一条消息。插件里所有确认都是「同一条指令重发一遍
 * 带个确认后缀」，这里跟着来 —— 没有超时、没有误触发窗口，也不怕重启丢状态。
 * 老习惯 `#meme部署确认`（不带装法）当作 venv + 确认：历史上这条就是 venv 的确认词。
 */
const RE_DEPLOY = /^#?meme部署\s*(venv|pip|python|docker|容器|1|2)?\s*(确认)?$/i

function parseDeploy (msg) {
  const text = String(msg || '').trim()
  const m = RE_DEPLOY.exec(text)
  const confirmed = /确认$/.test(text)
  if (!m) return { route: '', confirmed, bad: true }
  const t = (m[1] || '').toLowerCase()
  const docker = t === 'docker' || t === '容器' || t === '2'
  return { route: docker ? 'docker' : (t ? 'venv' : ''), confirmed: !!m[2] || confirmed, bad: false }
}

/**
 * 没指定装法时回的那条菜单。
 *
 * docker 的三态（没装 / 装了没启动 / 可用）在这里就要说清楚 —— 不然后者会让用户
 * 照着发一条注定失败的指令。同理，如果已经有能用的服务，先把「不装也能用」摆出来。
 */
async function menuText ({ bad, raw } = {}) {
  const d = daemonState()
  let alive = false
  let n = 0
  try {
    alive = await MemeApi.ping()
    if (alive) n = (await MemeApi.getKeys()).length
  } catch {}

  const lines = []
  if (bad) lines.push(`没看懂「${String(raw || '').trim()}」，下面是能用的装法：`, '')
  if (alive) {
    lines.push(`⚠️ 检测到 ${Config.getApiUrl()} 已经有能用的服务（${n} 个表情），不装也能用。`)
    lines.push('确实要在本机再装一套的话，把下面的命令后面加个「确认」再发。', '')
  }

  lines.push('📦 meme 画图服务 —— 装到这台机器上')
  lines.push('两种装法，挑一种发给我：', '')

  if (d.missing) {
    lines.push('🔹 省事的方式：这台机器上没有 docker，用不了')
    lines.push('   装了 Docker 就能选它（首次要下约 540MB 镜像，不用管系统里的 Python）', '')
  } else if (!d.started) {
    lines.push('🔹 省事的方式：#meme部署 docker')
    lines.push('   docker 装了但没在运行，先启动它再发：')
    lines.push('   Linux 发 sudo systemctl start docker；Windows / macOS 打开 Docker Desktop', '')
  } else {
    lines.push('🔹 省事的方式：#meme部署 docker')
    lines.push('   用 docker 跑，不碰系统里的 Python。首次要下约 540MB 镜像，几分钟', '')
  }

  lines.push('🔹 不用 docker：#meme部署 venv')
  lines.push('   在本机装 Python 环境，需要 Python 3.9 以上、git、pm2', '')
  lines.push('装完直接发 #摸头 就能用。')
  lines.push('别人给了你现成地址的话不用装，把配置 memeApiUrl 改成那个地址即可。')
  return lines.join('\n')
}

function deployCommand (opts) {
  const { dataDir: dir, pm2Name, pipIndex, gitProxy, port } = opts
  if (IS_WIN) {
    const ps1 = path.join(pluginResources, 'deploy', 'deploy.ps1')
    const named = ['-DataDir', dir, '-Pm2Name', pm2Name, '-Port', String(port)]
    if (pipIndex) named.push('-PipIndex', pipIndex)
    if (gitProxy) named.push('-GitProxy', gitProxy)
    const cmd = winShell()
    return {
      file: ps1,
      cmd,
      argv: ['-NoProfile', '-ExecutionPolicy', 'Bypass', '-File', ps1, ...named],
      named
    }
  }
  // bash 侧是位置参数，空串照样占位，不会错位
  const sh = path.join(pluginResources, 'deploy', 'deploy.sh')
  return {
    file: sh,
    cmd: 'bash',
    argv: [sh, dir, pm2Name, pipIndex, gitProxy, String(port)],
    named: []
  }
}

export class memeDeploy extends plugin {
  constructor () {
    super({
      name: 'meme部署',
      dsc: '可选：一键部署本机 meme-generator 服务',
      event: 'message',
      priority: 4000,
      rule: [
        // 状态必须排第一条：下面那条是「带参数的部署」，别把「状态」当成参数吃进去
        {
          reg: '^#?meme部署状态$',
          fnc: 'status',
          permission: 'master'
        },
        // 装法（可省，省了就回菜单）+ 确认后缀（可省）。
        // 别名：pip/python 等同 venv，容器等同 docker，1/2 是菜单里的序号
        {
          reg: '^#?meme部署\\s*(venv|pip|python|docker|容器|1|2)?\\s*(确认)?$',
          fnc: 'deploy',
          permission: 'master'
        }
      ]
    })
  }

  async status (e) {
    // 每次都重新探一遍 pm2 / docker：主人可能刚装好，探测结果不该被上次的缓存钉死
    resetPm2Cache()
    resetDockerCache()
    const venvBin = venvMemePath()
    const customRepos = String(Config.get('reposDir') || '').trim()
    const reposDir = customRepos || path.join(dataDir, 'repos')
    const pm2Name = Config.get('deployed') ? Config.get('deployPm2Name') : Config.get('memePm2Name')

    const lines = ['📊 meme 服务状态\n']

    // 服务连通性 —— 这是唯一必需项，其他都是本机部署才需要
    const alive = await MemeApi.ping()
    lines.push(`${alive ? '✅' : '❌'} 服务连通：${Config.getApiUrl()}`)
    if (alive) {
      try {
        const keys = await MemeApi.getKeys()
        lines.push(`   服务端 ${keys.length} 个表情`)
      } catch {}
    }
    lines.push(`${MemeIndex.isEmpty ? '❌' : '✅'} 本地索引：${MemeIndex.memeCount} 个表情 / ${MemeIndex.keywordCount} 个关键词`)

    // 用外部服务时，下面这三项本来就不该有东西 —— 标题里说清楚，
    // 免得看到「资源仓库 0/5」以为是坏了跑去 #meme更新 拉一堆没用的仓库
    const local = Config.isLocalService()
    lines.push(local
      ? '\n── 本机部署情况 ──'
      : '\n── 本机部署情况（你用的是外部服务，这几项空着是正常的）──')
    lines.push(`${fs.existsSync(venvBin) ? '✅' : '⬜'} venv：${fs.existsSync(venvBin) ? '已安装' : '未部署'}`)

    let repoCount = 0
    if (fs.existsSync(reposDir)) {
      repoCount = fs.readdirSync(reposDir).filter(d =>
        fs.existsSync(path.join(reposDir, d, '.git'))).length
    }
    lines.push(`${repoCount > 0 ? '✅' : '⬜'} 资源仓库：${repoCount}/${(Config.get('repos') || []).length} 个`)
    lines.push(`   路径：${reposDir}${customRepos ? '（配置指定）' : '（默认）'}`)

    // docker 压成一行（没装 / 装了没启动 / 容器在不在），不铺开占屏
    const d = daemonState()
    const cName = Config.get('deployPm2Name') || 'meme-plugin'
    const deployMode = String(Config.get('deployMode') || '').toLowerCase()
    let container = null
    if (d.missing) {
      lines.push('⬜ docker：这台机器上没装（想用容器方式就装个 Docker，或走 venv）')
    } else if (!d.started) {
      lines.push('❌ docker：装了但没启动（Linux: sudo systemctl start docker；Windows / macOS: 开 Docker Desktop）')
    } else {
      container = containerInfo(cName)
      if (isOurs(container, { expectName: cName })) {
        lines.push(`${container.running ? '✅' : '⬜'} docker 容器「${cName}」：${container.status}`)
        lines.push(`   镜像：${container.image}`)
      } else if (container) {
        lines.push(`⬜ docker：有个同名容器「${cName}」但不是插件装的（${container.status}），不动它`)
      } else {
        lines.push('✅ docker：可用（本机没在用容器方式跑 meme）')
      }
    }

    let pm2State = '未找到'
    const proc = pm2Proc(pm2Name)
    if (proc) pm2State = `${proc.pm2_env.status}（重启 ${proc.pm2_env.restart_time} 次）`
    else if (!pm2Bin()) pm2State = '查不了（本进程找不到 pm2 命令）'
    // 容器方式部署的机器上没有这个 pm2 进程，打一行「未找到」只会让人以为坏了
    if (deployMode !== 'docker' || proc) {
      lines.push(`${pm2State.includes('online') ? '✅' : '⬜'} pm2 进程「${pm2Name}」：${pm2State}`)
    }

    const ourContainer = isOurs(container, { expectName: cName })
    if (!alive) {
      if (ourContainer && !container.running) {
        lines.push('\n💡 容器没在跑：发 #meme更新 会按当前配置把它重建起来')
      } else if (ourContainer) {
        lines.push('\n💡 容器在跑，但里面的服务连不上 —— 可能刚启动还在扫目录，也可能卡住了')
        lines.push(`   查一眼日志：docker logs ${cName}`)
      } else {
        lines.push('\n💡 服务连不上。要么改配置 memeApiUrl 指向现成服务，')
        lines.push('   要么发 #meme部署 在本机装一个（可选）')
      }
    } else if (!local) {
      lines.push('\n💡 你在用外部 meme 服务，不需要本机部署，也不用拉表情仓库')
      lines.push('   服务方更新了表情，发 #meme更新 会自动同步索引')
    } else if (!fs.existsSync(venvBin) && !ourContainer) {
      lines.push('\n💡 服务在本机但不是插件部署的，#meme更新 会拉仓库并按')
      lines.push(`   memePm2Name「${Config.get('memePm2Name')}」重启它`)
    }

    await e.reply(lines.join('\n'))
    return true
  }

  async deploy (e) {
    const { route, confirmed, bad } = parseDeploy(e.msg)

    // 老写法「#meme部署确认」（不带装法）当作 venv + 确认 —— 以前这条就是 venv 的
    // 确认词，老用户的肌肉记忆不该被这次改版打断。参数写错的不算，老实回菜单
    const useRoute = bad ? '' : (route || (confirmed ? 'venv' : ''))

    // 没选装法就只回菜单。这一步刻意不落锁 —— 它不碰任何文件，
    // 没理由被「正在更新表情」挡在门外
    if (!useRoute) {
      await e.reply(await menuText({ bad, raw: e.msg }))
      return true
    }

    // 部署要跑十几分钟，连点两下会有两份活儿抢同一个目录、同一个名字
    if (!beginTask('部署服务')) {
      await e.reply(busyTip('部署'))
      return true
    }
    try {
      return useRoute === 'docker'
        ? await this.runDockerDeploy(e, confirmed)
        : await this.runDeploy(e, confirmed)
    } finally {
      endTask()
    }
  }

  /**
   * 两种装法共用的收尾：回写配置 → 等服务就绪 → 灌索引 → 报喜。
   *
   * name 对 venv 是 pm2 进程名、对 docker 是容器名 —— 都是「这套服务叫什么」，
   * `#meme更新` 靠它找服务。mode 记下装法，决定那边是重启进程还是重建容器。
   */
  async finishDeploy (e, { mode, name, port, head, waitHint, waitSec = 60, extra = [] }) {
    Config.set('deployed', true)
    Config.set('deployMode', mode)
    Config.set('memePm2Name', name)
    // 新服务监听的是 deployPort，不指过去插件还在连原来那个地址
    Config.set('memeApiUrl', `http://127.0.0.1:${port}`)
    // 之前连的是别人的服务、手动设过 remote 的话要掰回来，否则 #meme更新 不干活
    Config.set('serviceMode', 'local')

    const msgs = [head, ...extra]

    if (await MemeApi.waitReady(waitSec)) {
      try {
        const r = await MemeIndex.refreshFromApi()
        msgs.push(`\n✅ 索引已建立：${r.count} 个表情 / ${r.keywordCount} 个关键词`)
        msgs.push('直接发 #摸头 试试吧~')
        if (Config.get('enableWeb')) {
          msgs.push(`在线预览：${Config.getWebUrl()}/memes`)
        }
      } catch (err) {
        msgs.push(`\n⚠️ 索引建立失败：${err.message}\n请手动发 #meme刷新`)
      }
    } else {
      msgs.push(`\n⚠️ 服务 ${waitSec} 秒内没就绪，${waitHint}`)
    }

    await e.reply(msgs.join('\n'))
    return true
  }

  async runDeploy (e, confirmed) {
    const pm2Name = Config.get('deployPm2Name') || 'meme-plugin'
    const port = Number(Config.get('deployPort')) || 2233
    const { file, cmd, argv, named } = deployCommand({
      dataDir,
      pm2Name,
      pipIndex: Config.get('pipIndexUrl') || '',
      gitProxy: Config.get('gitProxy') || '',
      port
    })
    if (!fs.existsSync(file)) {
      await e.reply(`❌ 部署脚本不存在：${file}`)
      return true
    }

    // 已经有能用的服务时先提醒，避免误装一套多余的
    const alive = await MemeApi.ping()
    if (alive && !confirmed) {
      const keys = await MemeApi.getKeys().catch(() => [])
      await e.reply(
        `⚠️ 检测到 ${Config.getApiUrl()} 已经有可用的 meme 服务（${keys.length} 个表情）\n` +
        '不需要重复部署。如果确实要在本机再装一套独立服务，请发：\n' +
        '#meme部署 venv 确认\n\n' +
        `（会用 pm2 进程名「${Config.get('deployPm2Name')}」，不影响现有服务）`
      )
      return true
    }

    await e.reply(
      '🚀 开始部署 meme-generator（可选组件）\n' +
      `会做这些事：建 venv → 装 meme-generator → 拉 ${(Config.get('repos') || []).length} 个表情仓库 → 写配置 → pm2 起服务\n` +
      '首次部署要下载 skia-python 等依赖，可能要几分钟，请耐心等~'
    )

    let result = await this.runScript(cmd, argv, e)

    // Windows 上「一步都没跑起来」多半是 .ps1 被执行策略拦下（组策略下发时
    // 命令行的 -ExecutionPolicy Bypass 无效）。改成把脚本正文内联执行再试一次，
    // 这条路不算「运行脚本文件」，不受该策略管。
    if (!result.ok && IS_WIN && !result.sawStep && looksBlocked(result.errLines)) {
      const { b64, tooLong } = encodedCommandArgv(file, named)
      if (!tooLong) {
        await e.reply('⚠️ 直接跑 .ps1 被系统挡下了，换成内联方式重试一次...')
        result = await this.runScript(
          cmd, ['-NoProfile', '-NonInteractive', '-EncodedCommand', b64], e
        )
      }
    }

    if (!result.ok) {
      await e.reply(`❌ 部署失败\n${result.messages.join('\n')}`)
      return true
    }

    return this.finishDeploy(e, {
      mode: 'venv',
      name: pm2Name,
      port,
      head: `✅ 部署完成！\n${result.messages.join('\n')}`,
      waitHint: `请检查 pm2 logs ${pm2Name}`
    })
  }

  /**
   * docker 方式部署。全程纯 Node —— docker 命令三个平台完全一致，
   * 不必像 venv 那样再写一份 .sh / .ps1。
   */
  async runDockerDeploy (e, confirmed) {
    const port = Number(Config.get('deployPort')) || 2233
    const name = Config.get('deployPm2Name') || 'meme-plugin'
    const image = imageName()

    const alive = await MemeApi.ping()
    if (alive && !confirmed) {
      const keys = await MemeApi.getKeys().catch(() => [])
      await e.reply(
        `⚠️ 检测到 ${Config.getApiUrl()} 已经有可用的 meme 服务（${keys.length} 个表情）\n` +
        '不需要重复部署。如果确实要在本机再装一套独立服务，请发：\n' +
        '#meme部署 docker 确认\n\n' +
        `（会用容器名「${name}」，不影响现有服务）`
      )
      return true
    }

    // docker 环境：CLI 缺失和「装了没启动」要分开报，否则用户会跑去重装 docker
    const d = daemonState()
    if (d.missing) {
      await e.reply(
        '❌ 这台机器上没找到 docker 命令\n' +
        '👉 想用容器方式：先装 Docker 再发这条\n' +
        '👉 不想装 Docker：发 #meme部署 venv，用系统 Python 装'
      )
      return true
    }
    if (!d.started) {
      await e.reply(
        '❌ docker 装了，但没在运行\n' +
        '👉 Linux：sudo systemctl start docker\n' +
        '👉 Windows / macOS：打开 Docker Desktop，等它跑起来再发这条'
      )
      return true
    }

    // 端口自己先试一下：比等 docker 回一句英文报错强，还能说清下一步
    if (!await portFree(port)) {
      await e.reply(
        `❌ 端口 ${port} 已经被占用，容器起不来\n` +
        '👉 是你之前部署的服务占着的话：先发 #meme卸载 停掉它\n' +
        '👉 想两套并存：去配置把 deployPort 改成别的端口'
      )
      return true
    }

    await e.reply(
      '🚀 开始用容器方式部署 meme 服务\n' +
      `会做这些事：拉表情仓库 → 拉镜像 → 起容器（首次要下约 540MB，几分钟，请耐心等~）`
    )

    const msgs = []

    // ① 表情仓库 —— 和 #meme更新 走同一套逻辑。失败不阻断：内置表情照样能用
    const sync = await syncRepos({ onMessage: t => msgs.push(t) })
    if (sync.total === 0) {
      msgs.push('ℹ️ 没配置表情仓库，先用内置表情；想加社区表情去配置里填 repos')
    }

    // ② 起容器（内部含拉镜像）。顺序是「镜像就绪 → 删旧容器 → 跑新的」，
    // 把停机窗口压到最短
    msgs.push(`\n🐳 正在准备容器（${name}）...`)
    await e.reply(msgs.join('\n'))
    const rc = await recreateContainer({
      name, image, port,
      notify: t => e.reply(t).catch(() => {})
    })
    if (!rc.ok) {
      msgs.push(`❌ 容器启动失败：${rc.error}`)
      if (rc.hint) msgs.push(`👉 ${rc.hint}`)
      const logs = containerLogs(name).split('\n').map(l => l.trim()).filter(Boolean).slice(-6)
      if (logs.length) msgs.push(`容器日志：\n${logs.map(l => `　${l}`).join('\n')}`)
      await e.reply(msgs.join('\n'))
      return true
    }
    msgs.push(`✅ 容器已启动（镜像 ${image}）`)

    // ③ 挂载自检。Docker Desktop 没把该磁盘共享给 Docker 时不会报错，
    // 只给容器一个空目录 —— 服务照常起来、表情一个不多，最难查的一种
    const { count } = memeDirsEnv()
    const mounted = countMountedDirs(name)
    if (count > 0 && mounted === 0) {
      msgs.push(`⚠️ 容器里看不到宿主的表情目录，挂载可能没生效`)
      msgs.push(`　宿主目录：${reposRoot()}`)
      msgs.push('　Windows / macOS 的 Docker Desktop：到设置里把该磁盘共享给 Docker，然后重新发一次')
    } else if (count === 0) {
      msgs.push('ℹ️ 还没有表情仓库，先用内置表情；想加社区表情发 #meme更新')
    }

    return this.finishDeploy(e, {
      mode: 'docker',
      name,
      port,
      head: msgs.join('\n'),
      waitHint: `先发 #meme部署状态 看看，要查详细日志：docker logs ${name}`,
      waitSec: 90
    })
  }

  /**
   * 跑部署脚本，把 ::STEP::/::OK::/::FAIL:: 标记转成进度消息。
   * 用 spawn 而非 execSync：装依赖可能要几分钟，不能阻塞事件循环。
   * 解释器和参数由 deployCommand() 按平台给出。
   */
  runScript (cmd, argv, e) {
    return new Promise(resolve => {
      const messages = []
      let failed = null
      let lastStep = ''
      let sawStep = false
      // stderr 只写日志的话，脚本还没跑起来就挂掉时用户只看到「退出码 1」，
      // 什么线索都没有 —— 解释器自己的报错（找不到文件、参数绑定失败、
      // 执行策略拦截）全在这里，必须能回给用户
      const errLines = []

      const child = spawn(cmd, argv, {
        cwd: dataDir,
        env: { ...process.env },
        timeout: 900000
      })

      const handle = chunk => {
        for (const line of String(chunk).split('\n')) {
          if (!line.trim()) continue
          if (line.startsWith('::STEP::')) {
            lastStep = line.slice(8)
            sawStep = true
            logger.mark(`${logPrefix} 部署: ${lastStep}`)
            // 耗时步骤即时反馈，免得主人以为卡死了
            if (/安装 meme-generator|下载内置/.test(lastStep)) {
              e.reply(`⏳ ${lastStep}...`).catch(() => {})
            }
          } else if (line.startsWith('::OK::')) {
            messages.push(`✓ ${line.slice(6)}`)
          } else if (line.startsWith('::FAIL::')) {
            failed = line.slice(8)
          } else if (line.startsWith('::DONE::')) {
            // 结束标记
          } else {
            const t = line.trim()
            if (t.startsWith('✓') || t.startsWith('⚠️')) messages.push(`  ${t}`)
            logger.debug(`${logPrefix} 部署输出: ${t}`)
          }
        }
      }

      child.stdout.on('data', handle)
      child.stderr.on('data', chunk => {
        const t = String(chunk).trim()
        if (!t) return
        logger.error(`${logPrefix} 部署stderr: ${t}`)
        for (const line of t.split('\n')) {
          if (line.trim()) errLines.push(line.trim())
        }
      })

      child.on('error', err => {
        // ENOENT 就是解释器本身没找到，报清楚是哪个
        const extra = err.code === 'ENOENT' ? `（找不到 ${cmd}，它不在 PATH 里）` : ''
        resolve({ ok: false, sawStep, errLines: [], messages: [...messages, `脚本执行异常：${err.message}${extra}`] })
      })

      child.on('close', code => {
        const errs = cleanPsError(errLines)
        if (failed) {
          resolve({ ok: false, sawStep, errLines: errs, messages: [...messages, `✗ ${failed}`] })
          return
        }
        if (code === 0) {
          resolve({ ok: true, sawStep, errLines: errs, messages })
          return
        }
        const out = [...messages]
        // 一个 ::STEP:: 都没有 = 脚本压根没开始跑，问题在解释器/脚本自身
        out.push(sawStep
          ? `脚本退出码 ${code}（卡在：${lastStep}）`
          : `脚本退出码 ${code}，而且一步都没跑起来 —— 大概率是解释器或脚本本身的问题`)
        if (!sawStep) out.push(`解释器：${cmd}`)
        if (errs.length) {
          out.push('报错原文：')
          out.push(...errs.slice(-6).map(l => `  ${l}`))
        } else if (!sawStep) {
          out.push('（脚本连报错都没输出，手动跑一下看看：）')
          out.push(`  ${cmd} ${argv.map(a => (/\s/.test(a) ? `"${a}"` : a)).join(' ')}`)
        }
        resolve({ ok: false, sawStep, errLines: errs, messages: out })
      })
    })
  }
}
