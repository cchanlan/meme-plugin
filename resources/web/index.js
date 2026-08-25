'use strict'

const $ = s => document.querySelector(s)
const grid = $('#grid')
const tplCard = $('#card-tpl')

let ALL = []
let TAGS = []
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
  sheet.hidden = false
}

function closeSheet () { $('#sheet').hidden = true }

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
