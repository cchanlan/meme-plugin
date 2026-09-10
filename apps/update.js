import fs from 'node:fs'
import path from 'node:path'
import Config from '../model/config.js'
import MemeApi from '../model/memeApi.js'
import MemeIndex from '../model/memeIndex.js'
import Preview from '../model/preview.js'
import { logPrefix } from '../constants/path.js'
import { syncMemeDirs, tomlPath, venvMemePath } from '../utils/memeDirs.js'
import { syncRepos } from '../utils/repos.js'
import { clearImageCaches } from '../utils/cleanup.js'
import { pm2 } from '../utils/pm2.js'
import { containerInfo, isOurs, memeDirsEnv, recreateContainer, containerLogs } from '../utils/docker.js'
import { beginTask, endTask, busyTip } from '../utils/lock.js'

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
          fnc: 'updateEntry',
          permission: 'master'
        },
        {
          reg: '^#?meme(重载|刷新)$',
          fnc: 'reloadEntry',
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

  /**
   * 指令入口。update 和 reloadOnly 本体不上锁（update 内部会复用 reloadOnly，
   * 上在本体里会撞自己的锁），锁统一加在入口这一层。
   */
  async updateEntry (e) {
    if (!beginTask('更新表情')) {
      await e.reply(busyTip('更新表情'))
      return true
    }
    try {
      return await this.update(e)
    } finally {
      endTask()
    }
  }

  async reloadEntry (e) {
    if (!beginTask('刷新索引')) {
      await e.reply(busyTip('刷新索引'))
      return true
    }
    try {
      return await this.reloadOnly(e)
    } finally {
      endTask()
    }
  }

  /** 只刷新索引，不动仓库（服务端已经是新的时候用这个更快） */
  async reloadOnly (e, quiet = false) {
    if (!quiet) await e.reply('正在热加载表情索引...')
    try {
      const r = await MemeIndex.refreshFromApi()
      clearImageCaches()
      let msg = `✅ 已热加载：${r.count} 个表情 / ${r.keywordCount} 个关键词`
      if (r.added.length) {
        msg += `\n🆕 新增 ${r.added.length} 个：${r.added.slice(0, 12).join('、')}${r.added.length > 12 ? ' …' : ''}`
        msg += '\n不用重启，直接发就能用~'
      } else {
        msg += '\n没有新表情，服务端和本地已经一致'
      }
      // 个别 info 没拉到时表情数会悄悄少一截，不说清楚只会被当成「服务缺表情」
      if (r.failed.length) {
        msg += `\n⚠️ 有 ${r.failed.length} 个没拉到（${r.failed.slice(0, 5).join('、')}${r.failed.length > 5 ? ' …' : ''}）`
        msg += '\n多半是网络抖动，再发一次 #meme刷新 就好'
      }
      await e.reply(msg)
    } catch (err) {
      await e.reply(
        `❌ 热加载失败：${err.message}\n` +
        `当前服务地址：${Config.getApiUrl()}\n` +
        '发 #meme部署状态 可以看连通性'
      )
    }
    return true
  }

  async update (e) {
    // 服务不在本机的话，这条指令后面那一整套（拉仓库 → 写 meme_dirs → 重启 pm2）
    // 对它一点作用都没有：表情资源是服务方那边的事，这边把几个 G 的仓库拉下来
    // 也没有任何进程会去扫，纯占磁盘 + 被 clone 报错刷屏。所以直接退化成刷索引。
    if (!Config.isLocalService()) {
      // 「正在刷」这句得并进这条里：刷索引要按表情逐个拉 info，连公网服务时
      // 几百个表情要几十秒，中间一句话都没有的话用户只会以为指令没生效
      await e.reply(
        `ℹ️ 你连的是外部 meme 服务（${Config.getApiUrl()}）\n` +
        '表情资源由服务提供方维护，本机拉仓库、改 config.toml、重启进程都作用不到它身上，\n' +
        '所以这里只刷新本地索引（和 #meme刷新 一样）。\n' +
        '👉 服务方更新了表情，你发这个就能同步到\n\n' +
        '⏳ 正在刷新索引，要按表情逐个问服务，几十秒左右，完了会再回一条\n\n' +
        '（如果 meme 服务其实就在这台机器上、想让插件接管资源，把配置 serviceMode 改成 local）'
      )
      return this.reloadOnly(e, true)
    }

    // 服务压根没在这台机器上装过时，下面那一整套（克隆几个 G 的仓库 → 写 meme_dirs
    // → 重启服务）没有一步能生效：没有人会去读拉下来的目录，纯占磁盘，还要等十几分钟。
    // 所以先确认「确实有个本机服务等着喂」，没有就直接指路 #meme部署。
    //
    // 判据取四样全缺才算没装：服务连不通、config.toml 不在、venv 里没有 meme、
    // 也没有插件装的容器 —— 容器停着的时候前两样可能都不在，不能把这种情况当成没装。
    // 任一样在就说明装过（服务只是没起来 / 手动装的 / 容器方式部署的），
    // 照旧走完整流程 —— 拦截宁松勿严，误伤「服务挂了想更新」比漏放几次严重得多。
    const isDocker = !!Config.get('deployed') &&
      String(Config.get('deployMode') || '').toLowerCase() === 'docker'
    const hasOurContainer = isDocker &&
      isOurs(containerInfo(Config.get('deployPm2Name') || 'meme-plugin'))
    if (!await MemeApi.ping() && !fs.existsSync(tomlPath()) &&
      !fs.existsSync(venvMemePath()) && !hasOurContainer) {
      await e.reply(
        '❌ 这台机器上还没有 meme 服务，就不白下载几个 G 了\n' +
        '#meme更新 只负责给已经装好的服务换表情资源\n\n' +
        '👉 要装服务发 #meme部署（第一次要几分钟）\n' +
        '👉 连的是别人的服务，把配置 memeApiUrl 改成那个地址，再发这个就能同步'
      )
      return true
    }

    const repos = Config.get('repos') || []
    if (repos.length === 0) {
      await e.reply('没有配置任何表情仓库')
      return true
    }

    await e.reply('🔄 开始更新表情包资源...')
    const msgs = []
    // 拉仓库那套搬到 utils/repos.js 了：docker 部署也要用同一份
    const sync = await syncRepos({ onMessage: t => msgs.push(t) })
    const noChange = sync.noChange
    const hasUpdates = sync.hasUpdates

    if (!hasUpdates) {
      await e.reply(msgs.length
        ? `${msgs.join('\n')}\n\n📭 其余仓库无更新`
        : '📭 全部仓库都已是最新，无需更新')
      return true
    }

    if (noChange.length) msgs.push(`（${noChange.length} 个仓库无更新）`)

    // ① 把仓库登记进 meme_dirs。
    // venv 方式写宿主 config.toml；docker 方式走启动参数（见下），两种情况都要在
    // 重启之前算清楚 —— 服务只在启动时读这份目录清单。
    if (isDocker) {
      // 容器读的是启动时的环境变量，改宿主那份 config.toml 进不去容器。
      // 说清楚而不是静默跳过，免得有人对着「明明改了却没生效」查半天
      const { count, skipped } = memeDirsEnv()
      msgs.push(`\n📝 表情目录 ${count} 个：容器方式由启动参数带上，宿主配置不动`)
      if (skipped?.length) {
        msgs.push(`⚠️ ${skipped.length} 个仓库的表情目录不存在，会被跳过：`)
        for (const k of skipped.slice(0, 4)) msgs.push(`　${k.name} → ${k.path}`)
        msgs.push('　（多半是 memeSubDir 填错了，去锅巴面板确认）')
      }
    } else {
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
    }

    // ② 让服务重新加载表情。
    // meme-generator 只在进程启动时扫描 meme_dirs，不重启就永远加载不到新表情。
    if (isDocker) {
      // 容器方式必须【重建】而不是 docker restart：meme_dirs 是启动时的环境变量，
      // 重启拿到的还是旧那份，新加的表情仓库照样扫不到
      const cName = Config.get('deployPm2Name') || 'meme-plugin'
      const port = Number(Config.get('deployPort')) || 2233
      msgs.push(`\n🔄 正在重建容器（${cName}）...`)
      await e.reply(msgs.join('\n'))
      const rc = await recreateContainer({ name: cName, port, notify: t => e.reply(t).catch(() => {}) })
      if (!rc.ok) {
        msgs.push(`❌ 容器重建失败：${rc.error}`)
        if (rc.hint) msgs.push(`👉 ${rc.hint}`)
        const logs = containerLogs(cName).split('\n').map(l => l.trim()).filter(Boolean).slice(-6)
        if (logs.length) msgs.push(`容器日志：\n${logs.map(l => `　${l}`).join('\n')}`)
        await e.reply(msgs.join('\n'))
        return true
      }
      msgs.push(`✅ 容器已按新表情重建${rc.created ? '（之前不在，这次新建）' : ''}`)
    } else {
      // 必须按【名字】重启：pm2 的数字 ID 会随进程增删而错位，
      // 之前写死的 `pm2 restart 2` 实际重启的是 kugou-api-new，meme 服务从未重启过。
      const pm2Name = Config.get('deployed')
        ? Config.get('deployPm2Name')
        : Config.get('memePm2Name')
      msgs.push(`\n🔄 正在重启 meme 服务（${pm2Name}）...`)
      // 走 utils/pm2.js：Windows / nvm 环境下 PATH 里常常没有 pm2，
      // 直接 execSync('pm2 …') 会报 command not found，很容易被当成进程名填错
      const r = pm2(['restart', pm2Name])
      if (!r.ok) {
        msgs.push(`❌ meme 服务重启失败：${(r.err || r.out || 'pm2 restart 失败').split('\n')[0]}`)
        msgs.push(r.missing
          ? '（这台机器上找不到 pm2 命令，不是进程名的问题）'
          : `请检查 pm2 里的进程名是否叫「${pm2Name}」，可在配置里改 memePm2Name`)
        await e.reply(msgs.join('\n'))
        return true
      }
      msgs.push('✅ meme 服务重启成功')
    }

    // ③ 等服务重新扫描完 meme_dirs。
    // 实测它是扫完才开始监听（重启后约 7 秒连接被拒），所以能响应就代表扫完了；
    // waitReady 仍会多确认一拍数量不变，防它以后改成边扫边服务
    if (!await MemeApi.waitReady(isDocker ? 90 : 60)) {
      msgs.push(`⚠️ meme 服务 ${isDocker ? 90 : 60} 秒内没就绪，索引未刷新\n稍后手动发 #meme刷新`)
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
      if (r.failed.length) {
        msgs.push(`⚠️ 有 ${r.failed.length} 个没拉到 info，再发一次 #meme刷新 补上`)
      }
    } catch (err) {
      msgs.push(`⚠️ 索引热加载失败：${err.message}`)
    }

    // ⑤ 热加载没成功才重启 Yunzai 兜底 —— 主人的要求是「不行的话也要顺便重启云崽」
    if (!hotOk) {
      msgs.push('🔄 正在重启云崽兜底...')
      await e.reply(msgs.join('\n'))
      // 进程名可能不叫 TRSS-Yunzai，兜底按 pm2 自身给的 id 重启
      let done = false
      for (const target of ['TRSS-Yunzai', process.env.pm_id, 'Yunzai']) {
        if (target === undefined || target === null || target === '') continue
        const r = pm2(['restart', String(target)])
        if (r.ok) { done = true; break }
        logger.error(`${logPrefix} pm2 restart ${target} 失败: ${(r.err || '').split('\n')[0]}`)
      }
      if (!done) await e.reply('❌ 自动重启失败，请手动重启 Yunzai')
      return true
    }

    await e.reply(msgs.join('\n'))
    return true
  }
}

/**
 * 表情变了，出图缓存全作废 —— 实现搬到了 utils/cleanup.js，
 * 卸载那侧也要用同一份（两处各写一遍容易漏掉新增的缓存目录）。
 */
