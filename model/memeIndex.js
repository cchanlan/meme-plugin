import fs from 'node:fs'
import Config from './config.js'
import MemeApi from './memeApi.js'
import FirstSeen from './firstSeen.js'
import { dataPath } from '../utils/file.js'
import { logPrefix } from '../constants/path.js'
import { argSchemas } from '../utils/args.js'

const KEYMAP_FILE = () => dataPath('keyMap.json')
const INFOS_FILE = () => dataPath('infos.json')

/** 关键词 → 表情 code */
let keyMap = {}
/** 表情 code → info */
let infos = {}
/**
 * keyMap 的关键词按长度降序缓存，用于最长匹配。
 * 用首个匹配会让「摸」抢走「摸鱼」、「跳」抢走「跳舞」，
 * 实测有 51 个短关键词会吃掉 75 个长关键词，那些表情永远打不出来。
 */
let sortedKeys = []

function rebuildIndex () {
  sortedKeys = Object.keys(keyMap).sort((a, b) => b.length - a.length)
}

/** blackMemes 解析结果的缓存，避免每条消息都重算一遍 */
let blockCache = { sig: null, set: new Set() }

/**
 * 拉黑的表情 code 集合。
 *
 * 配置里既能填英文 code（如 petpet），也能填中文关键词（如 摸头）——
 * 主人多半只记得关键词。命中关键词时屏蔽的是它背后的整个表情，
 * 所以该表情的其他别名也一起失效，不会从别的名字绕进来。
 *
 * 过滤统一放在索引层：生成、搜索、分类、列表、随机、Web 站全都走这里，
 * 配一处就全局生效，不用在每个 app 里各写一遍。
 */
function blockedCodes () {
  const raw = Config.get('blackMemes') || []
  const list = (Array.isArray(raw) ? raw : [raw]).map(x => String(x).trim()).filter(Boolean)
  // sortedKeys.length 一起进签名：刷新索引后关键词映射可能变了，缓存要失效
  const sig = `${list.join('')}|${sortedKeys.length}`
  if (blockCache.sig === sig) return blockCache.set

  const set = new Set()
  for (const item of list) {
    if (item in infos) set.add(item)
    else if (keyMap[item]) set.add(keyMap[item])
  }
  blockCache = { sig, set }
  return set
}

const MemeIndex = {
  get keyMap () { return keyMap },
  get infos () { return infos },
  get sortedKeys () { return sortedKeys },

  get memeCount () { return Object.keys(infos).length },
  get keywordCount () { return sortedKeys.length },
  get isEmpty () { return sortedKeys.length === 0 },

  /** 该表情是否被拉黑 —— 站内生成走 code 直连，绕过了 match()，得自己查一次 */
  isBlocked (code) { return blockedCodes().has(code) },

  /** 从磁盘缓存载入 */
  loadFromDisk () {
    try {
      if (fs.existsSync(KEYMAP_FILE())) {
        keyMap = JSON.parse(fs.readFileSync(KEYMAP_FILE(), 'utf-8'))
      }
      if (fs.existsSync(INFOS_FILE())) {
        infos = JSON.parse(fs.readFileSync(INFOS_FILE(), 'utf-8'))
      }
    } catch (err) {
      logger.error(`${logPrefix} 载入本地缓存失败: ${err.message}`)
      keyMap = {}
      infos = {}
    }
    rebuildIndex()
    // 首见记录跟着索引一起对账。这里是「首次建立」的唯一入口：
    // 老用户第一次跑到这儿时文件还不存在，全部记 0 让排序回退到作者日期，
    // 不能把已有的 900 多个表情都标成「今天刚见到」
    if (sortedKeys.length) {
      FirstSeen.sync(Object.keys(infos), !FirstSeen.exists())
    }
    return sortedKeys.length
  },

  /**
   * 清空索引并删掉磁盘缓存。
   *
   * 卸载本机服务后必须清 —— 否则重启 Yunzai 会从 keyMap.json 把 944 个表情
   * 原样载回来，列表、搜索、Web 站看着一切正常，一发指令才是 fetch failed。
   * 「显示不出来」比「显示得出来但用不了」好懂得多。
   */
  clear () {
    keyMap = {}
    infos = {}
    rebuildIndex()
    blockCache = { sig: null, set: new Set() }
    let removed = 0
    for (const f of [KEYMAP_FILE(), INFOS_FILE()]) {
      try {
        if (fs.existsSync(f)) {
          fs.rmSync(f, { force: true })
          removed++
        }
      } catch (err) {
        logger.error(`${logPrefix} 删除 ${f} 失败: ${err.message}`)
      }
    }
    return removed
  },

  /**
   * 从服务端拉取最新数据并写盘。
   * meme-generator 只在进程启动时扫描 meme_dirs，所以调用方要先重启 meme 服务；
   * 而这里刷的是 Yunzai 侧的第二层缓存 —— 两层都刷了新表情才真能用。
   * @returns {Promise<{count:number, keywordCount:number, added:string[], addedCodes:string[]}>}
   */
  async refreshFromApi () {
    const oldKeyMap = { ...keyMap }
    const oldCount = Object.keys(infos).length
    const { keyMap: newKeyMap, infos: newInfos, failed = [] } = await MemeApi.fetchAll()
    const newCount = Object.keys(newInfos).length
    if (newCount === 0) {
      throw new Error('从服务端拉到 0 个表情，已保留原缓存')
    }
    // 数量腰斩几乎只有一种原因：服务还在扫 meme_dirs 就被抢先读了。
    // 不阻断（万一真是删了仓库），但要留痕，方便对着日志判断
    if (oldCount > 0 && newCount < oldCount * 0.5) {
      logger.error(
        `${logPrefix} 表情数从 ${oldCount} 掉到 ${newCount}，疑似服务没扫完 meme_dirs 就被读取；` +
        '若非故意删仓库，等十几秒再发一次 #meme刷新'
      )
    }
    keyMap = newKeyMap
    infos = newInfos
    fs.writeFileSync(KEYMAP_FILE(), JSON.stringify(keyMap))
    fs.writeFileSync(INFOS_FILE(), JSON.stringify(infos))
    rebuildIndex()
    const added = Object.keys(keyMap).filter(k => !(k in oldKeyMap))
    // 记下「本机第一次见到」的时间。服务端给的日期是作者标的，跟装机时间无关，
    // 光靠它排序会让刚拉到的表情沉在下面（实测新表情只排到第 26 位）
    const addedCodes = FirstSeen.sync(Object.keys(infos), !FirstSeen.exists())
    logger.mark(`${logPrefix} 索引已刷新：${this.memeCount} 个表情 / ${this.keywordCount} 个关键词`)
    return { count: this.memeCount, keywordCount: this.keywordCount, added, addedCodes, failed }
  },

  /**
   * 按「最近才有的」排前面。
   *
   * 排序键优先用本机首见时间，缺了才回退作者标注的日期 —— 详见 model/firstSeen.js。
   * @param {number} limit 取前几个，不给就全部
   */
  recentCodes (limit) {
    const list = this.allCodes()
      .map(code => ({ code, t: FirstSeen.sortKey(code, infos[code]) }))
      .sort((a, b) => b.t - a.t)
      .map(x => x.code)
    return limit > 0 ? list.slice(0, limit) : list
  },

  /**
   * 最长匹配。sortedKeys 已按长度降序，首个 startsWith 命中即最长。
   * @returns {{keyword: string, code: string, info: object, rest: string}|null}
   */
  match (msg) {
    const blocked = blockedCodes()
    // 跳过被拉黑的表情继续往下找：拉黑「摸头」时，若还有更短的关键词能匹配，
    // 那个表情不该跟着一起哑掉
    const keyword = sortedKeys.find(k => msg.startsWith(k) && !blocked.has(keyMap[k]))
    if (!keyword) return null
    const code = keyMap[keyword]
    return {
      keyword,
      code,
      info: infos[code],
      rest: msg.slice(keyword.length)
    }
  },

  /**
   * 搜索表情。同时匹配关键词、tag 和英文 code，按 code 去重。
   * @returns {Array<{code, info, keywords, hitBy}>}
   */
  search (query) {
    const q = query.trim().toLowerCase()
    if (!q) return []
    const blocked = blockedCodes()
    const hits = new Map()
    for (const [code, info] of Object.entries(infos)) {
      if (blocked.has(code)) continue
      let hitBy = null
      if ((info.keywords || []).some(k => k.toLowerCase().includes(q))) hitBy = 'keyword'
      else if ((info.tags || []).some(t => t.toLowerCase().includes(q))) hitBy = 'tag'
      else if (code.toLowerCase().includes(q)) hitBy = 'code'
      if (hitBy) hits.set(code, { code, info, keywords: info.keywords || [], hitBy })
    }
    // 关键词命中排前面，其次 tag，最后英文 code
    const order = { keyword: 0, tag: 1, code: 2 }
    return [...hits.values()].sort((a, b) => order[a.hitBy] - order[b.hitBy])
  },

  /**
   * 所有 tag 及其表情数量，只保留数量达标的。
   * tag 很碎：90 个 tag 只覆盖三分之一表情，其中 57 个只含 1 个表情。
   */
  getTags () {
    const blocked = blockedCodes()
    const counter = new Map()
    for (const [code, info] of Object.entries(infos)) {
      if (blocked.has(code)) continue
      for (const t of (info.tags || [])) {
        counter.set(t, (counter.get(t) || 0) + 1)
      }
    }
    const min = Config.get('tagMinCount') || 2
    return [...counter.entries()]
      .filter(([, n]) => n >= min)
      .sort((a, b) => b[1] - a[1])
      .map(([tag, count]) => ({ tag, count }))
  },

  /** 某个 tag 下的表情 code */
  getByTag (tag) {
    const t = tag.trim().toLowerCase()
    const blocked = blockedCodes()
    return Object.entries(infos)
      .filter(([code, info]) => !blocked.has(code) && (info.tags || []).some(x => x.toLowerCase() === t))
      .map(([code]) => code)
  },

  /** 全部 code，用于分页 */
  allCodes () {
    const blocked = blockedCodes()
    return Object.keys(infos).filter(code => !blocked.has(code))
  },

  /** 适合随机的表情：只需一张图、不需要文字 */
  randomCandidates () {
    const blocked = blockedCodes()
    return Object.keys(infos).filter(code => {
      if (blocked.has(code)) return false
      const pt = infos[code]?.params_type
      return pt && pt.min_images === 1 && pt.min_texts === 0
    })
  },

  /**
   * 适合「两个人」玩法的表情：正好要两张图、不需要文字。
   *
   * 实测 944 个表情里有 52 个满足（抱、击剑、贴、亲、幻影坦克…），
   * 且 `min_images === 2` 的表情**没有一个是同时要文字的**，
   * 所以不用再操心「抽到了却缺文案」。这些表情的两张图有语义（谁在上谁在下），
   * 调用方给的顺序就是出图顺序。
   */
  pairCandidates () {
    const blocked = blockedCodes()
    return Object.keys(infos).filter(code => {
      if (blocked.has(code)) return false
      const pt = infos[code]?.params_type
      return pt && pt.min_images === 2 && pt.max_images >= 2 && pt.min_texts === 0
    })
  },

  /** 给 web 前端用的精简元数据，按最近更新排前面 */
  toWebData () {
    const blocked = blockedCodes()
    // 排序和 #meme新增 用同一套键：优先本机首见时间，缺了回退作者日期。
    // 原来只比 date_modified 字符串，结果刚 #meme更新 拉到的表情
    // （作者标的日期是几个月前）在站上沉到几十位之后，看着像「没更新成功」
    return Object.entries(infos)
      .filter(([code]) => !blocked.has(code))
      .sort((a, b) => FirstSeen.sortKey(b[0], b[1]) - FirstSeen.sortKey(a[0], a[1]))
      .map(([code, info]) => {
      const pt = info.params_type || {}
      return {
        key: code,
        keywords: info.keywords || [],
        tags: info.tags || [],
        minImages: pt.min_images,
        maxImages: pt.max_images,
        minTexts: pt.min_texts,
        maxTexts: pt.max_texts,
        defaultTexts: pt.default_texts || [],
        // 有 user_infos 的表情，名字类参数是从「@ 的那个人」来的；
        // Web 端没有群成员，得让访客自己填个昵称
        needsName: !!info.params_type?.args_type?.args_model?.properties?.user_infos,
        args: argSchemas(info).map(([name, schema]) => ({
          name,
          type: schema.type,
          description: schema.description || '',
          default: schema.default,
          enum: schema.enum || schema.allOf?.[0]?.enum || null
        }))
      }
    })
  }
}

export default MemeIndex
