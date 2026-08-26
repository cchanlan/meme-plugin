import fs from 'node:fs'
import path from 'node:path'
import { execFile } from 'node:child_process'
import { pluginPath, logPrefix } from '../constants/path.js'

/**
 * 插件自身的更新（区别于 #meme更新 —— 那个更新的是表情资源仓库）。
 *
 * 全程用 execFile 而不是 execSync + 字符串命令：
 * ① 不走 shell，Windows 上没 bash 也一样跑；
 * ② 路径含空格（`C:\Program Files\...`）不用自己拼引号；
 * ③ git 卡在认证提示上时能被 timeout 掐掉，而不是把事件循环挂死。
 */

// GIT_TERMINAL_PROMPT=0：私有库/凭证过期时 git 会弹交互式账号密码提示，
// 非 tty 下就是永久挂住，直到 timeout。设了它直接失败返回。
// LC_ALL=C：把「Already up to date.」钉成英文，省得跟着系统语言变
const GIT_ENV = { ...process.env, GIT_TERMINAL_PROMPT: '0', LC_ALL: 'C' }

function git (args, timeout = 120000) {
  return new Promise(resolve => {
    execFile(
      'git', ['-C', pluginPath, ...args],
      { env: GIT_ENV, timeout, encoding: 'utf-8', windowsHide: true, maxBuffer: 10 * 1024 * 1024 },
      (err, stdout, stderr) => resolve({
        ok: !err,
        out: String(stdout || '').trim(),
        err: String(stderr || '').trim(),
        fatal: err?.code === 'ENOENT' ? '找不到 git，先装一个：https://git-scm.com/downloads' : ''
      })
    )
  })
}

/** 当前 HEAD 的短 hash + 提交时间 */
async function head () {
  const [h, t] = await Promise.all([
    git(['rev-parse', '--short', 'HEAD'], 15000),
    git(['log', '-1', '--format=%cd', '--date=format:%m-%d %H:%M'], 15000)
  ])
  return { hash: h.out, time: t.out }
}

/**
 * 改了哪些文件决定要不要重启 Yunzai。
 * 只动 resources/web/（Web 站前端是每次请求现读的）、README、图片这些，
 * 重启纯属打扰群友；apps/model/utils/server 里的 .js 是 import 进内存的，非重启不可。
 */
function needsRestart (files) {
  return files.some(f => /\.(js|json)$/.test(f) || f === 'config/system/config.yaml')
}

/**
 * 重启 Yunzai。优先借宿主自己的 #重启（它会把「重启成功，用时 x 秒」
 * 回给发指令的人，还兼容 pm2 / 前台 / docker 各种起法），
 * 拿不到就退回 pm2：先按名字，再按当前进程的 pm_id。
 */
async function restartYunzai (e) {
  try {
    const { Restart } = await import('../../other/restart.js')
    await new Restart(e).restart()
    return { ok: true }
  } catch (err) {
    logger.warn(`${logPrefix} 走宿主 #重启 失败，改用 pm2: ${err.message}`)
  }
  const { pm2 } = await import('../utils/pm2.js')
  for (const target of ['TRSS-Yunzai', process.env.pm_id, 'Yunzai']) {
    if (target === undefined || target === null || target === '') continue
    const r = pm2(['restart', String(target)])
    if (r.ok) return { ok: true }
    logger.error(`${logPrefix} pm2 restart ${target} 失败: ${(r.err || '').split('\n')[0]}`)
  }
  return { ok: false }
}

/** git 报错翻译成人话 —— 原文一大段英文，主人得自己猜是网络还是冲突 */
function explain (raw) {
  const t = raw || ''
  if (/Could not resolve host|Failed to connect|timed out|Connection reset/i.test(t)) {
    return '网络连不上代码仓库。挂了代理的话确认 git 也走代理，或者稍后再试'
  }
  if (/Authentication failed|could not read Username|Permission denied/i.test(t)) {
    return '仓库认证失败。凭证过期了，或者这个远端需要账号密码'
  }
  if (/repository .*does not exist|correct access rights|not appear to be a git repo/i.test(t)) {
    return '远端仓库访问不了。git remote -v 看一眼地址对不对，私有库还要有权限'
  }
  if (/local changes|would be overwritten|CONFLICT|Merge conflict|unmerged/i.test(t)) {
    return '本地文件被改过，和新版本撞了。发 #meme插件强制更新 覆盖掉本地修改\n（用户配置 config/config.yaml 不在版本库里，不会丢）'
  }
  if (/no tracking information|no upstream/i.test(t)) {
    return '当前分支没有关联远端。手动跑一次 git branch --set-upstream-to=origin/main'
  }
  if (/detached HEAD|not currently on any branch/i.test(t)) {
    return '仓库处于游离 HEAD 状态。手动跑一次 git checkout main'
  }
  // 认不出来就原样带最后几行，至少别让主人对着「更新失败」干瞪眼
  return t.split('\n').map(s => s.trim()).filter(Boolean).slice(-3).join('\n').slice(0, 300)
}

export class memeSelfUpdate extends plugin {
  constructor () {
    super({
      name: 'meme插件更新',
      dsc: '更新 meme-plugin 插件本体',
      event: 'message',
      priority: 4000,
      rule: [
        {
          // 必须带「插件」二字才算，否则会和 #meme更新（更新表情资源）撞车。
          // 「不重启」后缀留给「只想先拉下来、稍后自己重启」的场景
          reg: '^#?meme(插件|-?plugin)(强制)?更新(不重启)?$',
          fnc: 'update',
          permission: 'master'
        },
        {
          reg: '^#?(强制)?更新meme(插件|-?plugin)(不重启)?$',
          fnc: 'update',
          permission: 'master'
        },
        {
          reg: '^#?meme(插件)?版本$',
          fnc: 'version',
          permission: 'master'
        }
      ]
    })
  }

  /** 当前版本 + 远端有没有新东西 */
  async version (e) {
    if (!fs.existsSync(path.join(pluginPath, '.git'))) {
      await e.reply('❌ 插件目录不是 git 仓库，看不到版本，也没法用指令更新')
      return true
    }
    const cur = await head()
    await e.reply(`🔍 当前版本 ${cur.hash}（${cur.time}），正在问远端有没有新的...`)

    const f = await git(['fetch', '--no-tags', '--quiet'], 90000)
    if (!f.ok) {
      await e.reply(`⚠️ 拉取远端信息失败：\n${f.fatal || explain(f.err)}`)
      return true
    }
    const behind = await git(['rev-list', '--count', 'HEAD..@{u}'], 15000)
    const n = Number(behind.out)
    if (!behind.ok || Number.isNaN(n)) {
      await e.reply(`⚠️ 比不出差异：\n${explain(behind.err)}`)
      return true
    }
    if (n === 0) {
      await e.reply(`✅ 已经是最新版本 ${cur.hash}（${cur.time}）`)
      return true
    }
    const logs = await git(['log', '--pretty=%s', `-${Math.min(n, 8)}`, 'HEAD..@{u}'], 15000)
    await e.reply(
      `🆕 远端有 ${n} 个新提交\n` +
      logs.out.split('\n').filter(Boolean).map(s => `· ${s.slice(0, 60)}`).join('\n') +
      (n > 8 ? `\n… 还有 ${n - 8} 条` : '') +
      '\n\n发 #meme插件更新 拉下来'
    )
    return true
  }

  async update (e) {
    if (!fs.existsSync(path.join(pluginPath, '.git'))) {
      await e.reply(
        '❌ 插件目录不是 git 仓库，没法用指令更新\n' +
        '（多半是下载 zip 解压装的）删掉目录重新 clone 一次就能用了：\n' +
        'git clone https://gitcode.com/ccxhan/meme-plugin.git'
      )
      return true
    }

    const force = e.msg.includes('强制')
    const noRestart = e.msg.includes('不重启')
    const before = await head()
    await e.reply(`🔄 开始${force ? '强制' : ''}更新 meme-plugin（当前 ${before.hash}）...`)

    // 强制更新会 checkout 掉所有本地改动。用户配置本来就 gitignore、
    // checkout 不碰未跟踪文件，但万一有人 git add -f 过就真会被覆盖，所以照样备份一手
    const cfg = path.join(pluginPath, 'config', 'config.yaml')
    let bak = ''
    if (force && fs.existsSync(cfg)) {
      bak = `${cfg}.bak.${Date.now()}`
      try {
        fs.copyFileSync(cfg, bak)
      } catch (err) {
        logger.error(`${logPrefix} 备份用户配置失败: ${err.message}`)
        bak = ''
      }
      const co = await git(['checkout', '--', '.'], 60000)
      if (!co.ok) {
        await e.reply(`❌ 放弃本地修改失败：\n${co.fatal || explain(co.err)}`)
        return true
      }
    }

    const pull = await git(['pull', '--no-rebase', '--no-edit'], 300000)

    // 配置被 checkout 覆盖过就还原回来；没被动过就把备份删掉，不留垃圾
    if (bak) {
      try {
        if (fs.readFileSync(bak, 'utf-8') !== fs.readFileSync(cfg, 'utf-8')) {
          fs.copyFileSync(bak, cfg)
          logger.mark(`${logPrefix} 用户配置已从备份还原`)
        }
        fs.unlinkSync(bak)
      } catch {}
    }

    if (!pull.ok) {
      await e.reply(`❌ 更新失败：\n${pull.fatal || explain(`${pull.err}\n${pull.out}`)}`)
      return true
    }

    const after = await head()
    if (after.hash === before.hash) {
      await e.reply(`✅ 已经是最新版本 ${after.hash}（${after.time}），没什么可更新的`)
      return true
    }

    // 变更文件与提交记录 —— 只报数量太干瘪，主人想知道到底改了什么
    const [diff, logs] = await Promise.all([
      git(['diff', '--name-only', `${before.hash}..HEAD`], 30000),
      git(['log', '--pretty=%s', `${before.hash}..HEAD`], 30000)
    ])
    const files = diff.out.split('\n').filter(Boolean)
    const commits = logs.out.split('\n').map(s => s.trim())
      .filter(s => s && !/^Merge (branch|remote)/.test(s))

    const msgs = [
      `✅ 更新成功：${before.hash} → ${after.hash}`,
      `📅 最新提交 ${after.time} · ${files.length} 个文件变更`
    ]
    if (commits.length) {
      msgs.push('')
      msgs.push(...commits.slice(0, 8).map(s => `· ${s.length > 60 ? s.slice(0, 60) + '…' : s}`))
      if (commits.length > 8) msgs.push(`… 共 ${commits.length} 条`)
    }

    const restart = needsRestart(files)
    if (!restart) {
      msgs.push('\n💡 这次只动了网页/文档，不用重启就已经生效啦')
      await e.reply(msgs.join('\n'))
      return true
    }
    if (noRestart) {
      msgs.push('\n⚠️ 改到了代码，要重启 Yunzai 才生效（你加了「不重启」，这里就不动了）')
      await e.reply(msgs.join('\n'))
      return true
    }

    msgs.push('\n🔄 改到了代码，正在重启 Yunzai 以生效...')
    await e.reply(msgs.join('\n'))
    const r = await restartYunzai(e)
    if (!r.ok) {
      await e.reply('❌ 自动重启没成功，请手动重启 Yunzai（更新本身已经拉下来了）')
    }
    return true
  }
}

