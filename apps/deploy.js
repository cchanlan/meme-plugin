import fs from 'node:fs'
import path from 'node:path'
import { spawn, execSync } from 'node:child_process'
import Config from '../model/config.js'
import MemeApi from '../model/memeApi.js'
import MemeIndex from '../model/memeIndex.js'
import { dataDir, pluginResources, logPrefix } from '../constants/path.js'

const IS_WIN = process.platform === 'win32'

/**
 * 部署脚本与解释器按平台分派。
 * Windows 上没有 bash（除非装了 Git Bash / WSL），所以另备一份 PowerShell 脚本，
 * 两边输出同一套 ::STEP:: / ::OK:: / ::FAIL:: 标记，解析逻辑可以共用。
 */
function deployCommand (args) {
  if (IS_WIN) {
    const ps1 = path.join(pluginResources, 'deploy', 'deploy.ps1')
    return {
      file: ps1,
      cmd: 'powershell.exe',
      argv: ['-NoProfile', '-ExecutionPolicy', 'Bypass', '-File', ps1, ...args]
    }
  }
  const sh = path.join(pluginResources, 'deploy', 'deploy.sh')
  return { file: sh, cmd: 'bash', argv: [sh, ...args] }
}

/** venv 里 meme 可执行文件的位置：Windows 放在 Scripts\ 且带 .exe */
function venvMemePath () {
  return IS_WIN
    ? path.join(dataDir, 'venv', 'Scripts', 'meme.exe')
    : path.join(dataDir, 'venv', 'bin', 'meme')
}

export class memeDeploy extends plugin {
  constructor () {
    super({
      name: 'meme部署',
      dsc: '可选：一键部署本机 meme-generator 服务',
      event: 'message',
      priority: 4000,
      rule: [
        {
          reg: '^#?meme部署状态$',
          fnc: 'status',
          permission: 'master'
        },
        {
          reg: '^#?meme部署(确认)?$',
          fnc: 'deploy',
          permission: 'master'
        }
      ]
    })
  }

  async status (e) {
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

    let pm2State = '未找到'
    try {
      const out = execSync(`pm2 jlist`, { encoding: 'utf-8' })
      const proc = JSON.parse(out).find(p => p.name === pm2Name)
      pm2State = proc ? `${proc.pm2_env.status}（重启 ${proc.pm2_env.restart_time} 次）` : '未找到'
    } catch {}
    lines.push(`${pm2State.includes('online') ? '✅' : '⬜'} pm2 进程「${pm2Name}」：${pm2State}`)

    if (!alive) {
      lines.push('\n💡 服务连不上。要么改配置 memeApiUrl 指向现成服务，')
      lines.push('   要么发 #meme部署 在本机装一个（可选）')
    } else if (!local) {
      lines.push('\n💡 你在用外部 meme 服务，不需要本机部署，也不用拉表情仓库')
      lines.push('   服务方更新了表情，发 #meme更新 会自动同步索引')
    } else if (!fs.existsSync(venvBin)) {
      lines.push('\n💡 服务在本机但不是插件部署的，#meme更新 会拉仓库并按')
      lines.push(`   memePm2Name「${Config.get('memePm2Name')}」重启它`)
    }

    await e.reply(lines.join('\n'))
    return true
  }

  async deploy (e) {
    const pm2Name = Config.get('deployPm2Name') || 'meme-plugin'
    const port = Number(Config.get('deployPort')) || 2233
    const { file, cmd, argv } = deployCommand([
      dataDir,
      pm2Name,
      Config.get('pipIndexUrl') || '',
      Config.get('gitProxy') || '',
      String(port)
    ])
    if (!fs.existsSync(file)) {
      await e.reply(`❌ 部署脚本不存在：${file}`)
      return true
    }

    // 已经有能用的服务时先提醒，避免误装一套多余的
    const alive = await MemeApi.ping()
    if (alive && !/确认$/.test(e.msg)) {
      const keys = await MemeApi.getKeys().catch(() => [])
      await e.reply(
        `⚠️ 检测到 ${Config.getApiUrl()} 已经有可用的 meme 服务（${keys.length} 个表情）\n` +
        '不需要重复部署。如果确实要在本机再装一套独立服务，请发：\n' +
        '#meme部署确认\n\n' +
        `（会用 pm2 进程名「${Config.get('deployPm2Name')}」，不影响现有服务）`
      )
      return true
    }

    await e.reply(
      '🚀 开始部署 meme-generator（可选组件）\n' +
      `会做这些事：建 venv → 装 meme-generator → 拉 ${(Config.get('repos') || []).length} 个表情仓库 → 写配置 → pm2 起服务\n` +
      '首次部署要下载 skia-python 等依赖，可能要几分钟，请耐心等~'
    )

    const result = await this.runScript(cmd, argv, e)

    if (!result.ok) {
      await e.reply(`❌ 部署失败\n${result.messages.join('\n')}`)
      return true
    }

    // 部署成功：切到自己的服务并灌索引
    Config.set('deployed', true)
    Config.set('memePm2Name', pm2Name)
    // 新服务监听的是 deployPort，不指过去插件还在连原来那个地址
    Config.set('memeApiUrl', `http://127.0.0.1:${port}`)
    // 之前连的是别人的服务、手动设过 remote 的话要掰回来，否则 #meme更新 不拉仓库
    Config.set('serviceMode', 'local')

    const msgs = [`✅ 部署完成！\n${result.messages.join('\n')}`]

    if (await MemeApi.waitReady(60)) {
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
      msgs.push('\n⚠️ 服务 60 秒内没就绪，请检查 pm2 logs ' + pm2Name)
    }

    await e.reply(msgs.join('\n'))
    return true
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
        logger.debug(`${logPrefix} 部署stderr: ${String(chunk).trim()}`)
      })

      child.on('error', err => {
        resolve({ ok: false, messages: [...messages, `脚本执行异常：${err.message}`] })
      })

      child.on('close', code => {
        if (failed) {
          resolve({ ok: false, messages: [...messages, `✗ ${failed}`] })
        } else if (code !== 0) {
          resolve({ ok: false, messages: [...messages, `脚本退出码 ${code}（卡在：${lastStep}）`] })
        } else {
          resolve({ ok: true, messages })
        }
      })
    })
  }
}
