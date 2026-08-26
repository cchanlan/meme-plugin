import fs from 'node:fs'

/**
 * Windows / PowerShell 那一侧的三个小工具，从 apps/deploy.js 抽出来单独放，
 * 好处是能脱机断言（deploy.js 依赖 Yunzai 的 plugin 全局，跑不起来）。
 */

/** PowerShell 字面量：单引号串里只需把单引号翻倍，其余一概不转义 */
export function psQuote (s) {
  return `'${String(s).replace(/'/g, "''")}'`
}

/**
 * 兜底执行方式：把脚本正文塞进 -EncodedCommand。
 *
 * `-File` 跑 .ps1 要过执行策略，而 ExecutionPolicy 一旦由**组策略**下发，
 * 命令行上的 `-ExecutionPolicy Bypass` 就是无效的 —— 表现正是「退出码 1 且
 * 一个字都没输出」，因为脚本根本没被加载。-EncodedCommand 走的是「执行一段命令」
 * 而不是「运行脚本文件」，不受该策略约束；编码也由我们自己定（UTF-16LE），
 * 顺带绕开 Windows PowerShell 5.1 按系统 ANSI 读 .ps1 的老毛病。
 *
 * 脚本正文包在 `& { ... }` 里，它自己的 param() 照常绑定命名参数。
 * 实测 6.8K 的脚本编码后约 18K 字符，命令行上限 32767，余量够。
 */
export function encodedCommandArgv (ps1, named = []) {
  const body = fs.readFileSync(ps1, 'utf-8').replace(/^﻿/, '')
  const args = []
  for (let i = 0; i < named.length; i += 2) {
    args.push(named[i], psQuote(named[i + 1]))
  }
  const script = `& {\n${body}\n} ${args.join(' ')}`
  const b64 = Buffer.from(script, 'utf16le').toString('base64')
  return { b64, tooLong: b64.length > 30000 }
}

/** PowerShell 非交互模式下 stderr 会被包成 CLIXML，把里面的人话抠出来 */
export function cleanPsError (lines = []) {
  const out = []
  for (const raw of lines) {
    // 先抠 <S S="Error">…</S>：真实输出里 <Objs> 和 <S> 常在同一行
    // （`<Objs Version="1.1.0.1" xmlns="…"><S S="Error">报错正文</S></Objs>`），
    // 先按 Objs 跳行就把唯一的错误正文一起扔了
    const segs = [...raw.matchAll(/<S S="[^"]*">([^<]*)<\/S>/g)].map(x => x[1])
    if (segs.length) {
      const t = segs.join('').replace(/_x000D_|_x000A_/g, ' ')
        .replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&amp;/g, '&')
        .replace(/\s+/g, ' ').trim()
      if (t) out.push(t)
      continue
    }
    if (/^#< CLIXML/.test(raw)) continue
    if (/^<\/?Objs/.test(raw)) continue
    if (/^</.test(raw)) continue
    out.push(raw)
  }
  return out
}

/** 疑似「脚本文件根本没被加载」——策略拦截、找不到文件、参数绑定失败 */
export function looksBlocked (errLines = []) {
  const t = errLines.join(' ')
  return /running scripts is disabled|UnauthorizedAccess|禁止运行脚本|ExecutionPolicy|not digitally signed|不是数字签名|does not exist|无法找到|参数绑定|ParameterBinding|MissingMandatory/i.test(t)
}
