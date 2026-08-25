import _ from 'lodash'

/**
 * 中文方向/模式词 → 服务端的英文枚举值。
 * schema 里只有 left/right/loop 这类英文值，中文说法推不出来，这是必须保留的领域知识。
 */
const DIRECTION_ALIAS = {
  左: 'left',
  右: 'right',
  上: 'top',
  下: 'bottom',
  两边: 'both',
  循环: 'loop',
  套娃: 'circle',
  前: 'front',
  后: 'behind',
  随机: 'random'
}

/** 布尔参数的否定词，用于 schema 兜底时判断 */
const BOOL_FALSE_WORDS = ['否', '不', 'no', 'false', '0']

/**
 * 需要特殊领域知识的表情，逐一复刻原有行为，保证零回归。
 * 这里有 4 处默认值与服务端 schema 的 default 不同（gun 是 right 而非 left、
 * clown_mask 是 behind 而非 front、crawl/firefly_holdsign 不传参时随机而非 0），
 * 沿用插件历史选择，避免改变既有效果。
 * 不在此表中的表情走 schemaArgs() 的通用推导。
 */
const SPECIAL_ARGS = {
  look_flat: args => ({ ratio: parseInt(args || '2') }),
  crawl: args => ({ number: parseInt(args) ? parseInt(args) : _.random(1, 92, false) }),
  firefly_holdsign: args => ({ number: parseInt(args) ? parseInt(args) : _.random(1, 21, false) }),
  symmetric: args => ({ direction: DIRECTION_ALIAS[args.trim()] || 'left' }),
  petpet: args => ({ circle: args.startsWith('圆') }),
  jiji_king: args => ({ circle: args.startsWith('圆') }),
  kirby_hammer: args => ({ circle: args.startsWith('圆') }),
  dog_dislike: args => ({ circle: args.startsWith('圆') }),
  clown: args => ({ person: args.startsWith('爷') }),
  my_friend: (args, userInfos) => ({ name: args || _.trim(userInfos[0].text, '@') }),
  always: args => ({ mode: { '': 'normal', 循环: 'loop', 套娃: 'circle' }[args] || 'normal' }),
  gun: args => ({ position: DIRECTION_ALIAS[args.trim()] || 'right' }),
  bubble_tea: args => ({ position: DIRECTION_ALIAS[args.trim()] || 'right' }),
  note_for_leave: args => (args ? { time: args } : {}),
  mourning: args => ({ black: args.startsWith('黑白') || args.startsWith('灰') }),
  genshin_eat: args => {
    const roleMap = { 八重: 1, 胡桃: 2, 妮露: 3, 可莉: 4, 刻晴: 5, 钟离: 6 }
    return { character: roleMap[args.trim()] || 0 }
  },
  clown_mask: args => ({ mode: args === '前' ? 'front' : 'behind' }),
  alipay: args => ({ message: args || '' }),
  wechat_pay: args => ({ message: args || '' }),
  panda_dragon_figure: args => ({ name: args || '' })
}

/** 取参数的 enum 候选值，兼容 enum 直接挂在属性上和包在 allOf 里两种写法 */
export function getEnum (schema) {
  if (Array.isArray(schema.enum)) return schema.enum
  if (Array.isArray(schema.allOf) && Array.isArray(schema.allOf[0]?.enum)) return schema.allOf[0].enum
  return null
}

/**
 * 取该表情除 user_infos 之外的参数 schema
 * @returns {Array<[string, object]>} [名称, schema] 数组
 */
export function argSchemas (info) {
  const props = info?.params_type?.args_type?.args_model?.properties || {}
  return Object.entries(props).filter(([name]) => name !== 'user_infos')
}

/**
 * 按服务端返回的 JSON Schema 推导参数值。
 * 原本只硬编码了 21 个表情，而服务里有 57 个带参表情，
 * 剩下 37 个（ba_say、certificate、kokona_seal 等）完全传不了参数。
 */
function schemaArgs (info, args, userInfos) {
  const schemas = argSchemas(info)
  if (schemas.length === 0) return {}
  // 参数分隔符是 #，调用方只切出一个 args，故只填充第一个参数
  const [name, schema] = schemas[0]
  const raw = (args || '').trim()
  const enums = getEnum(schema)
  let val

  if (enums) {
    const mapped = DIRECTION_ALIAS[raw]
    if (mapped && enums.includes(mapped)) val = mapped
    else if (raw && enums.includes(raw)) val = raw
    else val = schema.default
  } else if (schema.type === 'integer' || schema.type === 'number') {
    const n = parseInt(raw)
    val = Number.isNaN(n) ? (schema.default ?? 0) : n
  } else if (schema.type === 'boolean') {
    val = raw !== '' && !BOOL_FALSE_WORDS.includes(raw.toLowerCase())
  } else {
    // 字符串：为空时 name 类参数回退到 @ 的人/发送者，与 my_friend 的历史行为一致
    if (raw) val = raw
    else if (name === 'name') val = _.trim(userInfos?.[0]?.text || '', '@')
    else val = schema.default ?? ''
  }

  if (val === undefined) return {}
  return { [name]: val }
}

/**
 * 生成发给服务端的 args JSON
 * @param {string} key 表情 code
 * @param {object} info 该表情的 info
 * @param {string} args 用户输入的参数串
 * @param {Array} userInfos [{text, gender}]
 */
export function handleArgs (key, info, args, userInfos) {
  if (!args) args = ''
  const argsObj = SPECIAL_ARGS[key]
    ? SPECIAL_ARGS[key](args, userInfos)
    : schemaArgs(info, args, userInfos)

  argsObj.user_infos = userInfos.map(u => ({
    name: _.trim(u.text, '@'),
    gender: u.gender || 'unknown'
  }))
  return JSON.stringify(argsObj)
}

/**
 * 拼「xx详情」的说明文案。
 * 直接读 schema 生成，覆盖全部 57 个带参表情，而不是硬编码那 21 段。
 */
export function detail (code, info) {
  if (!info) return '未找到该表情，试试 #meme更新'
  const pt = info.params_type || {}
  const keywords = (info.keywords || []).join('、')
  let ins = `【代码】${info.key || code}\n【名称】${keywords}\n【图片数量】${pt.min_images}~${pt.max_images}\n【文本数量】${pt.min_texts}~${pt.max_texts}\n`
  if (pt.default_texts?.length) {
    ins += `【默认文本】${pt.default_texts.join('/')}\n`
  }
  const schemas = argSchemas(info)
  if (schemas.length > 0) {
    ins += '【支持参数】'
    for (const [name, schema] of schemas) {
      const enums = getEnum(schema)
      let line = `\n  ${name}`
      if (schema.description) line += `：${schema.description}`
      if (enums) line += `\n    可选：${enums.join(' / ')}`
      if (schema.default !== undefined && schema.default !== '') {
        line += `${enums ? '，' : '\n    '}默认：${schema.default}`
      }
      ins += line
    }
    ins += `\n用法：#${(info.keywords || [code])[0]}#参数`
  }
  return ins
}

export { SPECIAL_ARGS, DIRECTION_ALIAS }
