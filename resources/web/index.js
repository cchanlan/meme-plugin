'use strict'

const $ = s => document.querySelector(s)
const grid = $('#grid')
const tplCard = $('#card-tpl')

let ALL = []
let TAGS = []
let CAN_MAKE = false
let MAX_MB = 10
let curTag = ''
let curQuery = ''
let renderToken = 0

// ── 数据加载 ──
async function boot () {
  try {
    const r = await fetch('/memes/data.json')
    if (!r.ok) throw new Error('HTTP ' + r.status)
    const data = await r.json()
    ALL = data.memes || []
    TAGS = data.tags || []
    CAN_MAKE = !!data.canMake
    MAX_MB = data.maxFileSize || 10
    $('#stat').textContent = `共 ${data.total} 个表情 · ${data.keywords} 个关键词`
    renderTags()
    render()
  } catch (err) {
    $('#stat').textContent = '数据加载失败：' + err.message
  }
}

function renderTags () {
  const box = $('#tags')
  box.innerHTML = ''
  const mk = (label, value) => {
    const b = document.createElement('button')
    b.className = 'tag' + (curTag === value ? ' on' : '')
    b.textContent = label
    b.onclick = () => {
      curTag = curTag === value ? '' : value
      renderTags()
      render()
    }
    return b
  }
  box.appendChild(mk('全部', ''))
  for (const t of TAGS) box.appendChild(mk(`${t.tag} ${t.count}`, t.tag))
}

// ── 过滤 ──
function match (m, q) {
  if (m.keywords.some(k => k.toLowerCase().includes(q))) return true
  if (m.tags.some(t => t.toLowerCase().includes(q))) return true
  return m.key.toLowerCase().includes(q)
}

function filtered () {
  const q = curQuery.trim().toLowerCase()
  return ALL.filter(m => {
    if (curTag && !m.tags.includes(curTag)) return false
    if (q && !match(m, q)) return false
    return true
  })
}

// ── 渲染 ──
// 837 张预览图一次性插入会卡住手机浏览器，分批 60 个用 rAF 递进
function render () {
  const list = filtered()
  const token = ++renderToken
  grid.innerHTML = ''
  $('#empty').hidden = list.length > 0
  if (!list.length) {
    // 「整站零个表情」和「搜索没命中」得分开说：卸载本机服务后本地索引会被清空，
    // 这时候还挂着「试试搜猫」，访客只会以为搜索坏了
    const none = ALL.length === 0
    $('#empty-title').textContent = none ? '还没有表情数据' : '没找到相关表情'
    $('#empty-hint').textContent = none
      ? 'meme 服务可能没在跑，让机器人主人发 #meme刷新 拉一次'
      : '试试搜「猫」「举牌」「鸣潮」这类词'
  }

  const total = ALL.length
  const shown = list.length
  $('#stat').textContent = shown === total
    ? `共 ${total} 个表情`
    : `筛出 ${shown} / ${total} 个`

  let i = 0
  const step = () => {
    if (token !== renderToken) return
    const frag = document.createDocumentFragment()
    for (let n = 0; n < 60 && i < list.length; n++, i++) {
      frag.appendChild(card(list[i]))
    }
    grid.appendChild(frag)
    if (i < list.length) requestAnimationFrame(step)
  }
  step()
}

// 真懒加载：只有滚进视口才设 src。
// 原始预览图平均 281KB（最大 1.38MB），837 张合计约 230MB，
// 光靠 loading=lazy 浏览器仍会预取大量图，手机上会卡死。
const io = new IntersectionObserver((entries, obs) => {
  for (const en of entries) {
    if (!en.isIntersecting) continue
    const img = en.target
    if (img.dataset.src) {
      img.src = img.dataset.src
      delete img.dataset.src
    }
    obs.unobserve(img)
  }
}, { rootMargin: '300px 0px' })

function card (m) {
  const node = tplCard.content.cloneNode(true)
  const el = node.querySelector('.card')
  const img = node.querySelector('img')
  // 列表用压缩后的小图，点开详情才加载原图
  img.dataset.src = `/memes/thumb/${encodeURIComponent(m.key)}`
  img.onerror = () => { img.classList.add('err'); img.alt = '预览不可用' }
  io.observe(img)

  const cmd = '#' + (m.keywords[0] || m.key)
  node.querySelector('.cmd').textContent = cmd

  const alias = m.keywords.slice(1)
  node.querySelector('.alias').textContent = alias.length ? alias.join(' / ') : ' '

  const need = node.querySelector('.need')
  need.appendChild(badge(imgText(m)))
  if (m.args.length) need.appendChild(badge('可带参数', 'arg'))

  el.onclick = () => copy(cmd, m)
  return node
}

function imgText (m) {
  const parts = []
  if (m.maxImages > 0) {
    parts.push(m.minImages === m.maxImages ? `${m.maxImages}图` : `${m.minImages}-${m.maxImages}图`)
  }
  if (m.maxTexts > 0) {
    parts.push(m.minTexts === m.maxTexts ? `${m.maxTexts}字段` : `${m.minTexts}-${m.maxTexts}字段`)
  }
  return parts.join(' + ') || '直接用'
}

function badge (text, cls) {
  const s = document.createElement('span')
  s.className = 'badge' + (cls ? ' ' + cls : '')
  s.textContent = text
  return s
}

// ── 复制 + 详情 ──
async function copy (cmd, m) {
  let done = false
  try {
    if (navigator.clipboard && window.isSecureContext) {
      await navigator.clipboard.writeText(cmd)
      done = true
    }
  } catch {}
  if (!done) {
    // http 明文访问时 clipboard API 不可用，退回 execCommand
    const ta = document.createElement('textarea')
    ta.value = cmd
    ta.style.position = 'fixed'
    ta.style.opacity = '0'
    document.body.appendChild(ta)
    ta.select()
    try { done = document.execCommand('copy') } catch {}
    ta.remove()
  }
  toast(done ? `已复制 ${cmd}` : '复制失败，请长按选择')
  if (m) openSheet(m)
}

let toastTimer
function toast (msg) {
  const t = $('#toast')
  t.textContent = msg
  t.classList.add('show')
  clearTimeout(toastTimer)
  toastTimer = setTimeout(() => t.classList.remove('show'), 1600)
}

function openSheet (m) {
  const sheet = $('#sheet')
  const cmd = '#' + (m.keywords[0] || m.key)
  sheet.querySelector('.sheet-img').src = `/memes/preview/${encodeURIComponent(m.key)}`
  sheet.querySelector('.sheet-title').textContent = m.keywords[0] || m.key
  sheet.querySelector('.sheet-cmd').textContent = cmd

  const dl = sheet.querySelector('.sheet-info')
  dl.innerHTML = ''
  const row = (k, v) => {
    const dt = document.createElement('dt')
    dt.textContent = k
    const dd = document.createElement('dd')
    dd.textContent = v
    dl.append(dt, dd)
  }
  if (m.keywords.length > 1) row('别名', m.keywords.join(' / '))
  row('代码', m.key)
  row('需要', imgText(m))
  if (m.tags.length) row('分类', m.tags.join('、'))
  if (m.defaultTexts.length) row('默认文本', m.defaultTexts.join(' / '))
  for (const a of m.args) {
    let v = a.description || a.name
    if (a.enum) v += `（可选：${a.enum.join(' / ')}）`
    if (a.default !== undefined && a.default !== '' && a.default !== null) v += `，默认 ${a.default}`
    row(`参数 ${a.name}`, v)
  }
  if (m.args.length) row('带参用法', `${cmd}#参数`)

  sheet.querySelector('.sheet-copy').onclick = () => copy(cmd, null)
  buildMake(m)
  sheet.hidden = false
  // 上一个表情滚到一半就关了，新开的得从头看
  sheet.querySelector('.sheet-body').scrollTop = 0
}

function closeSheet () { $('#sheet').hidden = true }

// ── 在线生成 ──
// 图走 base64 塞 JSON：后端是 Node 原生 http，没有表单解析，
// 自己拆 multipart 边界纯属给自己找 bug
let slots = []
let textEls = []
let argEls = []
let nickEl = null
let lastOut = ''

function readAsDataURL (f) {
  return new Promise((resolve, reject) => {
    const r = new FileReader()
    r.onload = () => resolve(r.result)
    r.onerror = () => reject(new Error('读取文件失败'))
    r.readAsDataURL(f)
  })
}

function field (label, ctrl) {
  const row = document.createElement('label')
  row.className = 'fld'
  const t = document.createElement('span')
  t.textContent = label
  row.append(t, ctrl)
  return row
}

/** 一个图片位：选文件 或 填 QQ 号取头像，二选一 */
function slot (i, m) {
  const wrap = document.createElement('div')
  wrap.className = 'slot'
  const pick = document.createElement('label')
  pick.className = 'slot-pick'
  const file = document.createElement('input')
  file.type = 'file'
  file.accept = 'image/*'
  file.hidden = true
  const face = document.createElement('span')
  face.className = 'slot-face'
  face.textContent = i < m.minImages ? `＋ 第 ${i + 1} 张` : `＋ 第 ${i + 1} 张 · 可选`
  pick.append(file, face)

  const qq = document.createElement('input')
  qq.className = 'slot-qq'
  qq.placeholder = '或填 QQ 号取头像'
  qq.inputMode = 'numeric'

  const st = { dataUrl: '', qq }
  file.onchange = async () => {
    const f = file.files[0]
    if (!f) return
    // 前端先拦一次：10MB 的图 base64 之后 13MB，传上去只为了被后端退回
    if (f.size > MAX_MB * 1048576) {
      toast(`图片超过 ${MAX_MB}MB 了`)
      file.value = ''
      return
    }
    try {
      st.dataUrl = await readAsDataURL(f)
    } catch (err) {
      toast(err.message)
      return
    }
    face.textContent = ''
    const img = document.createElement('img')
    img.src = st.dataUrl
    face.appendChild(img)
    qq.value = ''
  }
  wrap.append(pick, qq)
  slots.push(st)
  return wrap
}

function buildMake (m) {
  const box = $('#sheet').querySelector('.make')
  box.hidden = !CAN_MAKE
  if (!CAN_MAKE) return

  const slotBox = box.querySelector('.make-slots')
  const fieldBox = box.querySelector('.make-fields')
  const out = box.querySelector('.make-out')
  slotBox.innerHTML = ''
  fieldBox.innerHTML = ''
  out.innerHTML = ''
  slots = []
  textEls = []
  argEls = []
  nickEl = null

  for (let i = 0; i < m.maxImages; i++) slotBox.appendChild(slot(i, m))

  for (let i = 0; i < m.maxTexts; i++) {
    const inp = document.createElement('input')
    inp.type = 'text'
    inp.placeholder = i < m.minTexts ? '必填' : '可留空'
    // 有默认文本就先填上：直接点生成也能出图，不用猜该写什么
    if (m.defaultTexts[i]) inp.value = m.defaultTexts[i]
    textEls.push(inp)
    fieldBox.appendChild(field(m.maxTexts > 1 ? `文字 ${i + 1}` : '文字', inp))
  }

  for (const a of m.args) {
    let ctrl
    if (a.enum) {
      ctrl = document.createElement('select')
      for (const v of a.enum) {
        const o = document.createElement('option')
        o.value = v
        o.textContent = v
        if (v === a.default) o.selected = true
        ctrl.appendChild(o)
      }
    } else if (a.type === 'boolean') {
      ctrl = document.createElement('input')
      ctrl.type = 'checkbox'
      ctrl.checked = a.default === true
    } else if (a.type === 'integer' || a.type === 'number') {
      ctrl = document.createElement('input')
      ctrl.type = 'number'
      if (a.default !== undefined && a.default !== null) ctrl.value = a.default
    } else {
      ctrl = document.createElement('input')
      ctrl.type = 'text'
      if (a.default) ctrl.value = a.default
    }
    argEls.push({ a, ctrl })
    fieldBox.appendChild(field(a.description || a.name, ctrl))
  }

  if (m.needsName) {
    nickEl = document.createElement('input')
    nickEl.type = 'text'
    nickEl.placeholder = '部分表情会用到，可留空'
    fieldBox.appendChild(field('昵称', nickEl))
  }

  const btn = box.querySelector('.make-go')
  btn.disabled = false
  btn.textContent = '生成表情'
  btn.onclick = () => make(m, box)
}

async function make (m, box) {
  const btn = box.querySelector('.make-go')
  const out = box.querySelector('.make-out')

  const images = slots.map(s => s.dataUrl || s.qq.value.trim()).filter(Boolean)
  if (images.length < m.minImages) {
    toast(`至少要 ${m.minImages} 张图，也可以填 QQ 号`)
    return
  }
  const texts = textEls.map(el => el.value.trim())
  // 只砍尾部的空框：中间留空砍掉会让后面的文字串到前一个位置上
  while (texts.length && !texts[texts.length - 1]) texts.pop()
  if (texts.length < m.minTexts) {
    toast(`至少要填 ${m.minTexts} 段文字`)
    return
  }
  const args = {}
  for (const { a, ctrl } of argEls) {
    args[a.name] = a.type === 'boolean' && !a.enum ? ctrl.checked : ctrl.value
  }

  btn.disabled = true
  btn.textContent = '生成中…'
  out.innerHTML = ''
  try {
    const r = await fetch(`/memes/make/${encodeURIComponent(m.key)}`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ images, texts, args, nick: nickEl ? nickEl.value.trim() : '' })
    })
    if (!r.ok) {
      let msg = 'HTTP ' + r.status
      try { msg = (await r.json()).error || msg } catch {}
      throw new Error(msg)
    }
    const blob = await r.blob()
    // 上一张的 objectURL 不撤掉，连点几次就把 blob 全留在内存里了
    if (lastOut) URL.revokeObjectURL(lastOut)
    lastOut = URL.createObjectURL(blob)
    const isGif = blob.type === 'image/gif'
    const img = document.createElement('img')
    img.className = 'out-img'
    img.src = lastOut
    const save = document.createElement('a')
    save.className = 'out-save'
    save.href = lastOut
    save.download = `${m.key}.${blob.type.split('/')[1] || 'gif'}`
    save.textContent = isGif ? '⬇ 保存 GIF' : '⬇ 保存图片'
    out.append(img, save)
    // 浏览器的右键「复制图像」是把图**解码成位图**放进剪贴板的（剪贴板只认 PNG），
    // GIF 这么复制过去就只剩第一帧 —— 不是这里生成错了，所以得当场说清楚怎么发才对
    if (isGif) {
      const tip = document.createElement('div')
      tip.className = 'out-tip'
      tip.textContent = '这是动图：右键「复制图像」粘到 QQ 会变成静态图，要点上面的按钮存成 .gif 再发（手机长按图片保存）'
      out.appendChild(tip)
    }
  } catch (err) {
    const tip = document.createElement('div')
    tip.className = 'out-err'
    tip.textContent = '生成失败：' + err.message
    out.appendChild(tip)
  } finally {
    btn.disabled = false
    btn.textContent = '再生成一次'
  }
}

// ── 事件绑定 ──
let searchTimer
$('#q').addEventListener('input', e => {
  clearTimeout(searchTimer)
  searchTimer = setTimeout(() => {
    curQuery = e.target.value
    render()
  }, 120)
})

$('#clear').onclick = () => {
  $('#q').value = ''
  curQuery = ''
  render()
  $('#q').focus()
}

$('#sheet').querySelector('.sheet-bg').onclick = closeSheet
$('#sheet').querySelector('.sheet-close').onclick = closeSheet
document.addEventListener('keydown', e => {
  if (e.key === 'Escape') closeSheet()
})

boot()
