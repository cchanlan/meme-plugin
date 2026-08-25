import fs from 'node:fs'
import path from 'node:path'
import { execSync } from 'node:child_process'
import Config from '../model/config.js'
import MemeApi from '../model/memeApi.js'
import MemeIndex from '../model/memeIndex.js'
import Preview from '../model/preview.js'
import { dataDir, logPrefix } from '../constants/path.js'
import { mkdirs } from '../utils/file.js'
import { syncMemeDirs, reposRoot } from '../utils/memeDirs.js'

/**
 * 单个仓库的路径。
 * reposRoot 复用 utils/memeDirs.js 那份 —— 这里原本自己抄了一遍，
 * 两处实现容易改漏（比如尾部反斜杠的处理），而且必须和写进 meme_dirs 的路径完全一致。
 */
function resolveRepoPath (repo) {
  return path.join(reposRoot(), repo.dir)
}

export class memeUpdate extends plugin {
  constructor () {
    super({
      name: 'meme更新',
      dsc: '更新表情包资源仓库并刷新索引',
      event: 'message',
      priority: 4000,
      rule: [
        {
          reg: '^#?meme更新$',
          fnc: 'update',
          permission: 'master'
        },
        {
          reg: '^#?meme(重载|刷新)$',
          fnc: 'reloadOnly',
          permission: 'master'
        },
        {
          reg: '^#?meme清缓存$',
          fnc: 'clearCache',
          permission: 'master'
        }
      ]
    })
  }

  /** 手动清缓存。平时有定时维护，这里给「就是现在想腾空间」用 */
  async clearCache (e) {
    const before = Preview.stats()
    clearImageCaches()
    const mb = n => (n / 1048576).toFixed(1)
    await e.reply(
      '🧹 出图缓存已清空\n' +
      `预览图 ${before.full} 张（${mb(before.fullSize)}MB）· 缩略图 ${before.thumb} 张（${mb(before.thumbSize)}MB）\n` +
      '下次访问会重新回源，Web 站首屏会慢一点'
    )
    return true
  }

  /** 只刷新索引，不动仓库（服务端已经是新的时候用这个更快） */
  async reloadOnly (e) {
    await e.reply('正在热加载表情索引...')
    try {
      const r = await MemeIndex.refreshFromApi()
      clearImageCaches()
      let msg = `✅ 已热加载：${r.count} 个表情 / ${r.keywordCount} 个关键词`
      if (r.added.length) {
        msg += `\n🆕 新增 ${r.added.length} 个：${r.added.slice(0, 12).join('、')}${r.added.length > 12 ? ' …' : ''}`
        msg += '\n不用重启，直接发就能用~'
      }
      await e.reply(msg)
    } catch (err) {
      await e.reply(`❌ 热加载失败：${err.message}`)
    }
    return true
  }

  async update (e) {
    const repos = Config.get('repos') || []
    if (repos.length === 0) {
      await e.reply('没有配置任何表情仓库')
      return true
    }

    await e.reply('🔄 开始更新表情包资源...')
    const msgs = []
    const noChange = []
    let hasUpdates = false
    mkdirs(reposRoot())

    for (const repo of repos) {
      const repoPath = resolveRepoPath(repo)
      try {
        // 仓库不存在就克隆
        if (!fs.existsSync(path.join(repoPath, '.git'))) {
          const url = Config.proxyUrl(repo.url)
          execSync(`git clone --depth 1 -b ${repo.branch || 'main'} "${url}" "${repoPath}"`, {
            encoding: 'utf-8',
            timeout: 600000
          })
          msgs.push(`📥 ${repo.name} 首次克隆完成`)
          hasUpdates = true
          continue
        }

        const oldHead = execSync('git rev-parse HEAD', { cwd: repoPath, encoding: 'utf-8' }).trim()
        execSync('git pull', { cwd: repoPath, encoding: 'utf-8', timeout: 600000 })
        const newHead = execSync('git rev-parse HEAD', { cwd: repoPath, encoding: 'utf-8' }).trim()

        if (oldHead === newHead) {
          // 没更新的攒起来一句话带过，不逐个报
          noChange.push(repo.name)
          continue
        }

        hasUpdates = true
        const diffFiles = execSync(`git diff --name-only ${oldHead} ${newHead}`, {
          cwd: repoPath,
          encoding: 'utf-8'
        }).trim().split('\n').filter(Boolean)
        const commitLogs = execSync(
          `git log --pretty=format:"%s" ${oldHead}..${newHead}`,
          { cwd: repoPath, encoding: 'utf-8' }
        ).trim()

        msgs.push(`✅ ${repo.name}：${diffFiles.length} 个文件`)
        if (commitLogs) {
          const first = commitLogs.split('\n')[0]
          msgs.push(`   ${first.length > 60 ? first.slice(0, 60) + '…' : first}`)
        }
      } catch (err) {
        let errMsg = `❌ ${repo.name} 失败：`
        if (err.message.includes('not a git repository')) errMsg += '目录不是 git 仓库'
        else if (err.message.includes('Could not resolve host')) errMsg += '网络不通，检查 gitProxy'
        else if (err.message.includes('Authentication failed')) errMsg += '认证失败'
        else errMsg += err.message.split('\n')[0].slice(0, 60)
        msgs.push(errMsg)
      }
    }

    if (!hasUpdates) {
      await e.reply(msgs.length
        ? `${msgs.join('\n')}\n\n📭 其余仓库无更新`
        : '📭 全部仓库都已是最新，无需更新')
      return true
    }

    if (noChange.length) msgs.push(`（${noChange.length} 个仓库无更新）`)

    // ① 把仓库登记进 config.toml 的 meme_dirs。
    // 必须在重启之前做：meme-generator 只在启动时读这一行，
    // 顺序颠倒的话新仓库这次重启还是扫不到，得再更新一遍才生效。
    try {
      const s = syncMemeDirs()
      if (!s.ok) {
        msgs.push(`⚠️ meme_dirs 同步失败：${s.reason}`)
        msgs.push('新仓库可能加载不到，需手动改 config.toml')
      } else if (s.changed) {
        msgs.push(`\n📝 已登记 ${s.dirs.length} 个表情目录到 config.toml`)
        if (s.added?.length) msgs.push(`＋ ${s.added.map(d => path.basename(path.dirname(d))).join('、')}`)
        if (s.removed?.length) msgs.push(`－ ${s.removed.map(d => path.basename(path.dirname(d))).join('、')}`)
      }
      if (s.skipped?.length) {
        msgs.push(`⚠️ ${s.skipped.length} 个仓库的表情目录不存在，已跳过：`)
        for (const k of s.skipped.slice(0, 4)) msgs.push(`　${k.name} → ${k.path}`)
        msgs.push('　（多半是 memeSubDir 填错了，去锅巴面板确认）')
      }
    } catch (err) {
      msgs.push(`⚠️ meme_dirs 同步异常：${err.message}`)
    }

    // ② 重启 meme 服务。
    // meme-generator 只在进程启动时扫描 meme_dirs，不重启就永远加载不到新表情。
    // 必须按【名字】重启：pm2 的数字 ID 会随进程增删而错位，
    // 之前写死的 `pm2 restart 2` 实际重启的是 kugou-api-new，meme 服务从未重启过。
    const pm2Name = Config.get('deployed')
      ? Config.get('deployPm2Name')
      : Config.get('memePm2Name')
    try {
      msgs.push(`\n🔄 正在重启 meme 服务（${pm2Name}）...`)
      execSync(`pm2 restart ${pm2Name}`, { encoding: 'utf-8', timeout: 120000 })
      msgs.push('✅ meme 服务重启成功')
    } catch (err) {
      msgs.push(`❌ meme 服务重启失败：${err.message.split('\n')[0]}`)
      msgs.push(`请检查 pm2 里的进程名是否叫「${pm2Name}」，可在配置里改 memePm2Name`)
      await e.reply(msgs.join('\n'))
      return true
    }

    // ③ 等服务重新扫描完 meme_dirs。
    // 实测它是扫完才开始监听（重启后约 7 秒连接被拒），所以能响应就代表扫完了；
    // waitReady 仍会多确认一拍数量不变，防它以后改成边扫边服务
    if (!await MemeApi.waitReady(60)) {
      msgs.push('⚠️ meme 服务 60 秒内没就绪，索引未刷新\n稍后手动发 #meme刷新')
      await e.reply(msgs.join('\n'))
      return true
    }

    // ④ 刷新 Yunzai 侧的第二层缓存 —— 只重启服务不刷这里，新表情照样打不出来。
    // 走热加载：索引直接换成新的、旧出图缓存清掉，不用重启 Yunzai。
    let hotOk = false
    try {
      const r = await MemeIndex.refreshFromApi()
      clearImageCaches()
      hotOk = true
      msgs.push(`✅ 索引已热加载：${r.count} 个表情 / ${r.keywordCount} 个关键词`)
      if (r.added.length) {
        msgs.push(`🆕 新增 ${r.added.length} 个：${r.added.slice(0, 12).join('、')}${r.added.length > 12 ? ' …' : ''}`)
        msgs.push('不用重启，现在直接发就能用~')
      } else {
        msgs.push('（关键词无变化）')
      }
    } catch (err) {
      msgs.push(`⚠️ 索引热加载失败：${err.message}`)
    }

    // ⑤ 热加载没成功才重启 Yunzai 兜底 —— 主人的要求是「不行的话也要顺便重启云崽」
    if (!hotOk) {
      msgs.push('🔄 正在重启云崽兜底...')
      await e.reply(msgs.join('\n'))
      try {
        execSync('pm2 restart TRSS-Yunzai', { encoding: 'utf-8', timeout: 120000 })
      } catch (err) {
        // 进程名可能不叫 TRSS-Yunzai，兜底按 pm2 自身的 id 重启
        logger.error(`${logPrefix} 按名字重启云崽失败: ${err.message}`)
        try {
          execSync(`pm2 restart ${process.env.pm_id ?? 'Yunzai'}`, { encoding: 'utf-8', timeout: 120000 })
        } catch (err2) {
          logger.error(`${logPrefix} 重启云崽失败: ${err2.message}`)
          await e.reply(`❌ 自动重启失败，请手动重启：${err2.message.split('\n')[0]}`)
        }
      }
      return true
    }

    await e.reply(msgs.join('\n'))
    return true
  }
}

/**
 * 表情变了，出图缓存全作废。
 * 列表分页图、分类/搜索拼图、以及旧表情的预览图和缩略图都要清，
 * 否则会拿旧图糊弄人。
 */
function clearImageCaches () {
  for (const sub of ['list_cache', 'preview_cache', 'thumb_cache']) {
    const dir = path.join(dataDir, sub)
    try {
      if (!fs.existsSync(dir)) continue
      for (const f of fs.readdirSync(dir)) {
        try { fs.unlinkSync(path.join(dir, f)) } catch {}
      }
    } catch (err) {
      logger.error(`${logPrefix} 清理 ${sub} 失败: ${err.message}`)
    }
  }
}
