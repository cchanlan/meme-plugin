import fs from 'node:fs'
import path from 'node:path'
import net from 'node:net'
import { spawn, spawnSync } from 'node:child_process'
import Config from '../model/config.js'
import { dataDir } from '../constants/path.js'
import { reposRoot, expectedDirs } from './memeDirs.js'

/**
 * 调 docker 的统一入口。
 *
 * 照 utils/pm2.js 那套写的，理由也一样：Yunzai 进程的 PATH 停在它启动那一刻，
 * 之后装的 docker 它看不见（Windows 上还有「裸名字不带 .exe 不能 spawn」的坑），
 * 所以先按 PATH 找，找不到再去常见安装位置按文件名捞。
 *
 * 与 pm2 那边最大的一点不同：**容器参数在这里统一算**。`#meme部署` 起容器、
 * `#meme更新` 重建容器、`#meme部署状态` / `#meme卸载` 认容器，全都走 runArgs()，
 * 这样「正在跑的容器」和「下次重建的容器」不可能出现参数分叉。
 */

const IS_WIN = process.platform === 'win32'

/** 宿主的表情仓库目录挂到容器里的这个位置 */
export const CONTAINER_MOUNT = '/data/memes'
/** 镜像内部写死监听这个端口（上游 docker/config.toml.template 的 server.port），不可改 */
export const CONTAINER_PORT = 2233

/** 归属标记。卸载/状态靠这些 label 认人 —— 光比容器名会把用户自己的同名容器删掉 */
export const LABEL_MANAGED = 'meme-plugin.managed'
export const LABEL_ROLE = 'meme-plugin.role'
export const LABEL_DATADIR = 'meme-plugin.datadir'

/** 镜像兜底值（配置项 dockerImage 为空时用） */
export const DEFAULT_IMAGE = 'ghcr.nju.edu.cn/memecrafters/meme-generator:0.1.14'
/** 官方地址，加速站失效时的备选；提示文案里会用到 */
export const OFFICIAL_PREFIX = 'ghcr.io/memecrafters/meme-generator'

const LABEL_MANAGED_VALUE = '1'
const LABEL_ROLE_VALUE = 'meme-service'

// ── 找 docker ───────────────────────────────────────────

let cached
let cachedResolved = false

function needsShell (bin) {
  return IS_WIN && !/\.exe$/i.test(bin)
}

function quote (s) {
  return /[\s&|()<>^"]/.test(s) ? `"${String(s).replace(/"/g, '""')}"` : String(s)
}

/** 拿 `--version` 试一下这个名字/路径能不能直接跑起来 */
function probe (bin) {
  try {
    const r = needsShell(bin)
      ? spawnSync(`${quote(bin)} --version`, { shell: true, stdio: 'ignore', timeout: 20000, windowsHide: true })
      : spawnSync(bin, ['--version'], { stdio: 'ignore', timeout: 20000, windowsHide: true })
    return !r.error && r.status === 0
  } catch {
    return false
  }
}

/** docker 可能装在哪 —— PATH 之外的常见位置 */
function candidates () {
  if (IS_WIN) {
    return [
      // Docker Desktop 的默认落点
      path.join(process.env.ProgramFiles || '', 'Docker', 'Docker', 'resources', 'bin', 'docker.exe'),
      path.join(process.env.ProgramData || '', 'DockerDesktop', 'version-bin', 'docker.exe'),
      // 有些机器是 docker-cli 单独装的
      path.join(process.env.ProgramFiles || '', 'Docker', 'cli-plugins', 'docker.exe')
    ]
  }
  return [
    '/usr/bin/docker',
    '/usr/local/bin/docker',
    path.join(process.env.HOME || '', '.local/bin/docker'),
    '/snap/bin/docker',
    // macOS：Docker Desktop 的 app bundle 里也有一份
    '/Applications/Docker.app/Contents/Resources/bin/docker'
  ]
}

/**
 * 找到能用的 docker，找不到返回 null。
 * @returns {string|null}
 */
export function dockerBin () {
  if (cachedResolved) return cached
  cachedResolved = true
  cached = null
  if (probe('docker')) {
    cached = 'docker'
    return cached
  }
  for (const p of candidates()) {
    if (p && fs.existsSync(p) && probe(p)) {
      cached = p
      return cached
    }
  }
  return cached
}

/** 下次调用重新探测（用户刚装完 docker 不用重启 Yunzai 就能被认到） */
export function resetDockerCache () {
  cachedResolved = false
  cached = null
}

/**
 * 跑一条 docker 命令。
 * @param {string[]} args 参数数组，如 ['rm', '-f', 'meme-plugin']
 * @returns {{ok: boolean, out: string, err: string, missing: boolean}}
 */
export function docker (args = [], { timeout = 60000 } = {}) {
  const bin = dockerBin()
  if (!bin) {
    return {
      ok: false,
      out: '',
      missing: true,
      err: IS_WIN
        ? '找不到 docker。装过的话多半是 Yunzai 还拿着旧的 PATH，重启 Yunzai 即可'
        : '找不到 docker 命令'
    }
  }
  const opts = { encoding: 'utf-8', timeout, windowsHide: true, maxBuffer: 8 * 1024 * 1024 }
  const r = needsShell(bin)
    ? spawnSync([bin, ...args].map(quote).join(' '), { shell: true, ...opts })
    : spawnSync(bin, args, opts)
  return {
    ok: !r.error && r.status === 0,
    out: String(r.stdout || '').trim(),
    err: String(r.stderr || '').trim() || (r.error ? r.error.message : ''),
    missing: false
  }
}

/**
 * 流式跑一条 docker 命令（拉镜像用）。
 *
 * 和 docker() 分开是因为 `docker pull` 的进度是**一条条 \r 刷新的**、而且打在 stderr 上，
 * 用 spawnSync 攒到结束再返回的话，几分钟里一个字都看不到，看着就像卡死了。
 * 成败只看退出码 —— stderr 上有进度输出是正常的，不能当错误。
 */
export function dockerStream (args = [], { onLine, timeout = 1800000, idleTimeout = 0 } = {}) {
  return new Promise(resolve => {
    const bin = dockerBin()
    if (!bin) return resolve({ ok: false, missing: true, lines: [], err: '找不到 docker 命令' })
    const lines = []
    let timedOut = false
    let idleOut = false
    const child = needsShell(bin)
      ? spawn([bin, ...args].map(quote).join(' '), { shell: true, windowsHide: true })
      : spawn(bin, args, { windowsHide: true })

    // 空闲超时：一段时间没有任何输出就当作卡死。
    // 第三方加速站有时不是「快速失败」而是**挂着不动**（实测南大站对没缓存过的镜像
    // 回源极慢，十分钟一块盘都不写），这时只有整体超时是等不到的 ——
    // 用户会一直卡在那一步，等到天荒地老也不知道该换源
    let idleTimer = null
    const bumpIdle = () => {
      if (!idleTimeout) return
      clearTimeout(idleTimer)
      idleTimer = setTimeout(() => {
        idleOut = true
        try { child.kill('SIGKILL') } catch {}
      }, idleTimeout)
    }
    bumpIdle()

    const handle = chunk => {
      bumpIdle()
      // 进度行之间是 \r 不是 \n，两种都要切
      for (const raw of String(chunk).split(/[\r\n]+/)) {
        const t = raw.trim()
        if (!t) continue
        lines.push(t)
        if (lines.length > 300) lines.shift()
        onLine?.(t)
      }
    }
    child.stdout?.on('data', handle)
    child.stderr?.on('data', handle)

    const timer = setTimeout(() => {
      timedOut = true
      try { child.kill('SIGKILL') } catch {}
    }, timeout)

    child.on('error', err => {
      clearTimeout(timer)
      clearTimeout(idleTimer)
      resolve({ ok: false, lines, err: err.message })
    })
    child.on('close', code => {
      clearTimeout(timer)
      clearTimeout(idleTimer)
      resolve({
        ok: code === 0,
        lines,
        idleOut,
        err: idleOut
          ? `超过 ${Math.round(idleTimeout / 1000)} 秒没有任何下载进展，已中断`
          : (timedOut ? '命令超时被中断' : (code === 0 ? '' : `退出码 ${code}`))
      })
    })
  })
}

// ── 状态探测 ────────────────────────────────────────────

/**
 * docker CLI 在不在 + 守护进程起没起。
 *
 * 这两件事必须分开报：`docker --version` 不连 daemon，拿它当「能用」的判据的话，
 * Docker Desktop 没启动的机器会被误判成正常，然后在拉镜像那步莫名其妙失败。
 */
export function daemonState () {
  const bin = dockerBin()
  if (!bin) return { ok: false, missing: true, started: false, version: '', err: '没找到 docker 命令' }
  const r = docker(['version', '--format', '{{.Server.Version}}'], { timeout: 20000 })
  return {
    ok: r.ok,
    missing: false,
    started: r.ok,
    version: r.ok ? r.out.split('\n')[0].trim() : '',
    err: r.ok ? '' : (r.err || '').split('\n')[0]
  }
}

/** 镜像在不在本地（在的话就不用再拉） */
export function imageExists (image) {
  if (!image) return false
  const r = docker(['image', 'inspect', image, '--format', '{{.Id}}'], { timeout: 20000 })
  return r.ok && !!r.out
}

/**
 * `docker inspect` 拿一个容器的完整信息，没有则 null。
 * 用 inspect 而不是 ps：labels 只有 inspect 里是全的，而归属判据全靠 labels。
 */
export function containerInfo (name) {
  if (!name || !dockerBin()) return null
  const r = docker(['inspect', name, '--format', '{{json .}}'], { timeout: 20000 })
  if (!r.ok || !r.out) return null
  try {
    const d = JSON.parse(r.out.split('\n')[0])
    return {
      id: String(d?.Id || ''),
      name: String(d?.Name || '').replace(/^\//, ''),
      image: String(d?.Config?.Image || ''),
      status: String(d?.State?.Status || ''),
      running: d?.State?.Running === true,
      startedAt: String(d?.State?.StartedAt || ''),
      labels: d?.Config?.Labels || {}
    }
  } catch {
    return null
  }
}

function normPath (p) {
  const s = path.resolve(String(p || ''))
  return IS_WIN ? s.toLowerCase() : s
}

/**
 * 这个容器是不是「插件装出来的」。
 *
 * 三重校验，缺一不算：带归属 label、镜像确实是 meme-generator、数据目录对得上
 * （一台机器上跑两个 Yunzai 时靠最后一条分清是谁的）。
 * 光比名字绝对不行 —— 用户完全可以自己 docker run 一个同名的容器。
 */
export function isOurs (info, { expectName } = {}) {
  if (!info) return false
  if (info.labels?.[LABEL_MANAGED] !== LABEL_MANAGED_VALUE) return false
  const dir = info.labels?.[LABEL_DATADIR]
  if (dir && normPath(dir) !== normPath(dataDir)) return false
  if (!/meme-generator/i.test(String(info.image || '').split(':')[0])) return false
  if (expectName && info.name !== expectName) return false
  return true
}

/**
 * 端口能不能用：自己 bind 一下试试。
 *
 * 比等 `docker run` 回一句 `port is already allocated` 强得多 —— 那句话说不出
 * 「是谁占着」也指不出下一步；这里能提前拦下来，还能给出「先卸载 / 改端口」两条路。
 */
export function portFree (port, host = '127.0.0.1') {
  return new Promise(resolve => {
    const s = net.createServer()
    s.once('error', () => resolve(false))
    s.once('listening', () => s.close(() => resolve(true)))
    s.listen(port, host)
  })
}

// ── 参数拼装（纯函数，好测） ──────────────────────────────

/** 镜像地址：配置优先，空了用兜底 */
export function imageName () {
  return String(Config.get('dockerImage') || '').trim() || DEFAULT_IMAGE
}

/** 从镜像地址里取 tag，取不到给 0.1.14 */
export function imageTag (image) {
  const s = String(image || '')
  const i = s.lastIndexOf(':')
  // 带端口的仓库地址（host:5000/xxx）里那个冒号不算 tag
  if (i < 0 || s.slice(i + 1).includes('/')) return '0.1.14'
  return s.slice(i + 1) || '0.1.14'
}

/** 宿主时区。Node 自己就能给出 IANA 名字，比读 /etc/timezone 跨平台（Windows 上没那个文件） */
export function hostTimeZone () {
  try {
    return Intl.DateTimeFormat().resolvedOptions().timeZone || 'Asia/Shanghai'
  } catch {
    return 'Asia/Shanghai'
  }
}

/** 宿主路径 → 容器内路径。Windows 上 path.relative 会吐反斜杠，必须掰成 / */
export function toContainerPath (hostPath) {
  const rel = path.relative(reposRoot(), String(hostPath))
  return CONTAINER_MOUNT + '/' + rel.split(path.sep).join('/')
}

/**
 * MEME_DIRS 的值。
 *
 * 容器里的 meme_dirs 只能走环境变量（镜像的 start.sh 用 envsubst 把 /app/config.toml.template
 * 渲染成容器内那份 config.toml），所以**绝不能挂载宿主的 ~/.config/meme_generator** ——
 * 那会把镜像里已经下好的内置素材盖掉，而且容器每次启动都会重写那个文件。
 *
 * 只收真实存在的目录（复用 expectedDirs 的过滤，memeSubDir 填错自动跳过）。
 */
export function memeDirsEnv () {
  const { dirs, skipped } = expectedDirs()
  return {
    value: JSON.stringify(dirs.map(toContainerPath)),
    count: dirs.length,
    skipped
  }
}

/**
 * 容器启动参数。
 *
 * 写成纯函数（输入配置 → 输出 argv），`#meme部署` 与 `#meme更新` 共用同一份 ——
 * 这是「更新时直接 rm -f 再 run」能安全的前提：两边算出来的参数必然一致。
 */
export function runArgs ({ name, image, port }) {
  const { value: memeDirs } = memeDirsEnv()
  return [
    'run', '-d',
    '--name', name,
    // 机器重启后自动拉起（和 pm2 save 的语义对齐）；用户手动 stop 过就不再自己起来 —— always 做不到这点
    '--restart', 'unless-stopped',
    '--label', `${LABEL_MANAGED}=${LABEL_MANAGED_VALUE}`,
    '--label', `${LABEL_ROLE}=${LABEL_ROLE_VALUE}`,
    '--label', `${LABEL_DATADIR}=${dataDir}`,
    // 只绑回环：插件就是通过 127.0.0.1 找它的。这个服务没有任何鉴权，
    // 绑 0.0.0.0 等于把它摊给整个局域网
    '-p', `127.0.0.1:${port}:${CONTAINER_PORT}`,
    // 表情仓库挂宿主那份，宿主那边照旧用 git 更新（#meme更新）
    '-v', `${reposRoot()}:${CONTAINER_MOUNT}`,
    '-e', `TZ=${hostTimeZone()}`,
    '-e', 'LOAD_BUILTIN_MEMES=true',
    '-e', `MEME_DIRS=${memeDirs}`,
    '-e', 'MEME_DISABLED_LIST=[]',
    '-e', 'GIF_MAX_SIZE=10.0',
    '-e', 'GIF_MAX_FRAMES=100',
    '-e', 'LOG_LEVEL=INFO',
    image
  ]
}

// ── 拉镜像 / 重建容器 ───────────────────────────────────

function firstLine (s) {
  return String(s || '').split('\n').map(x => x.trim()).filter(Boolean)[0] || ''
}

/** 拉取失败的下一步 —— 主人点名要的「能换回官方地址」就落在这里 */
function pullFailHint (image, lines = [], extra = {}) {
  const text = lines.join('\n')
  const hints = []
  if (/no space left/i.test(text)) {
    hints.push('磁盘满了：先 docker system df 看一眼，这个镜像解压后约 1.5G')
  }
  if (/no matching manifest|not supported/i.test(text)) {
    hints.push('这个 tag 没有你这台机器的架构，换个 tag 再试')
  }
  if (/manifest unknown|not found/i.test(text)) {
    hints.push('这个地址或 tag 不存在。tag 要填 0.1.x —— 0.2 起上游没有 HTTP 服务，插件连不上')
  }
  if (/denied|unauthorized/i.test(text)) {
    hints.push('镜像仓库拒绝访问，多半是地址或 tag 写错了')
  }
  if (extra.fallbackTried) {
    hints.push(`已经自动换官方地址（${extra.fallbackTried}）试过一次，也不通`)
    hints.push('那多半是这台机器到镜像仓库的网络本身有问题，或有代理干扰；先在终端手动跑一次 docker pull 看看报什么')
  } else if (!/^ghcr\.io\//.test(String(image))) {
    hints.push(`也可以换回官方地址重试：把配置 dockerImage 改成 ${OFFICIAL_PREFIX}:${imageTag(image)}，改完再发一次命令`)
  }
  hints.push('镜像拉到本地之后，命令会自动跳过拉取这一步')
  return hints.join('\n👉 ')
}

/** 起容器失败的下一步 */
function runFailHint (err, port, name) {
  const text = String(err || '')
  const hints = []
  if (/port is already allocated|address already in use/i.test(text)) {
    hints.push(`端口 ${port} 被占用了：如果是旧的那套 meme 服务，发 #meme卸载 停掉它再试；想两套并存就去配置把 deployPort 改成别的`)
  }
  if (/is already in use by container|Conflict/i.test(text)) {
    hints.push(`已经有个叫「${name}」的容器了。发 #meme卸载 看看它归谁；确认是插件装的可以删掉再试`)
  }
  if (/permission denied/i.test(text)) {
    hints.push('没有权限调用 docker：把 Yunzai 跑在 docker 组里，或用 root 跑')
  }
  return hints.join('\n👉 ')
}

/** 拉镜像。镜像已在本地就秒过 */
export async function pullImage (image, { notify, idleTimeout = 120000 } = {}) {
  if (imageExists(image)) return { ok: true, skipped: true, lines: [] }

  notify?.('⏳ 正在拉取镜像（第一次要几分钟）...')
  const r = await dockerStream(['pull', image], { timeout: 1800000, idleTimeout })
  if (r.ok) return r

  // **拉不动自动回退官方源**。默认走的是第三方加速站，它一旦失效（或像实测那样
  // 挂着不动、只是不报错），用户就装不下去了。同一个镜像的层是共享的，
  // 换地址重拉不会把已经下好的层再下一遍
  if (!/^ghcr\.io\//.test(String(image))) {
    const fallback = `${OFFICIAL_PREFIX}:${imageTag(image)}`
    notify?.('⚠️ 这个镜像地址拉不动，换官方源重试...')
    const r2 = await dockerStream(['pull', fallback], { timeout: 1800000, idleTimeout })
    if (r2.ok) return { ...r2, fallbackUsed: fallback }
    return { ...r, fallbackTried: fallback, fallbackErr: r2.err }
  }
  return r
}

/**
 * 用当前配置把容器重建一遍：镜像不在就拉、容器在就先删、再 run。幂等。
 *
 * 顺序是「先确保镜像在，再删旧容器」：反过来先删的话，发现要下 500MB 时
 * 服务已经白停几分钟了。
 *
 * 必须**重建**而不是 `docker restart`：meme_dirs 是启动时的环境变量，
 * 新增/删除表情仓库时 restart 拿到的还是旧那份，新表情照样扫不到。
 */
export async function recreateContainer ({ name, image, port, notify } = {}) {
  const d = daemonState()
  if (d.missing) {
    return { ok: false, error: '这台机器上没找到 docker 命令', hint: '想用容器方式要先装 Docker；不想装就发 #meme部署 venv' }
  }
  if (!d.started) {
    return { ok: false, error: 'docker 装了，但没在运行', hint: 'Linux: sudo systemctl start docker；Windows/macOS: 打开 Docker Desktop 等它跑起来' }
  }

  const img = image || imageName()
  const p = await pullImage(img, { notify })
  if (!p.ok) {
    return {
      ok: false,
      error: '拉取镜像失败',
      hint: pullFailHint(img, p.lines, p),
      lines: p.lines.slice(-3)
    }
  }
  // 回退到官方源拉成功的话，跑容器必须用**真正拉下来的那个地址** ——
  // 本地只有它，还用原地址会在 run 那一步报「Unable to find image locally」
  // （实测踩过：拉取回退了、容器却起不来）
  const useImage = p.fallbackUsed || img
  if (p.fallbackUsed) {
    notify?.(`✅ 换官方源拉到了（想以后直接用它，把配置 dockerImage 改成 ${p.fallbackUsed}）`)
  }

  const existed = !!containerInfo(name)
  if (existed) docker(['rm', '-f', name], { timeout: 90000 })

  const r = docker(runArgs({ name, image: useImage, port }), { timeout: 180000 })
  if (!r.ok) {
    return { ok: false, error: firstLine(r.err) || '容器启动失败', hint: runFailHint(r.err, port, name) }
  }
  return { ok: true, created: !existed, image: useImage }
}

/** 容器日志尾巴，起不来时用来给线索 */
export function containerLogs (name, tail = 20) {
  const r = docker(['logs', '--tail', String(tail), name], { timeout: 30000 })
  return (r.out || '') + (r.err || '')
}

/** 容器里能不能看到挂载进来的表情目录 —— Docker Desktop 没共享磁盘时是静默的空目录 */
export function countMountedDirs (name) {
  const r = docker(['exec', name, 'sh', '-c', `ls ${CONTAINER_MOUNT} 2>/dev/null | wc -l`], { timeout: 30000 })
  if (!r.ok) return -1
  return Number(String(r.out).trim()) || 0
}
