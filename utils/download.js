/**
 * 下载用户图 / 头像。
 *
 * 单独放在 utils 而不是留在 apps/meme.js 里：`index.js` 加载 apps 时取的是
 * `Object.keys(mod)[0]`，而 ESM 命名空间对象的键是**字母序**的 ——
 * 在 apps/meme.js 里多导出一个 `fetchImage`，挂载的就变成这个函数而不是
 * memeMaker 类，整条表情指令会静默失效。apps 下每个文件只能有一个导出。
 */

/**
 * 下一张图。两处都是踩过的：
 * - 必须带超时：裸 fetch 遇上 QQ 图床偶发不返回时，会把整条消息一直挂在那儿，
 *   等 Yunzai 自己超时，期间这个人再发指令还会叠一份
 * - 大小要先看 content-length：原来只在下载完之后用 checkFileSize 拦，
 *   流量已经吃进来了，maxFileSize 只挡住了生成、没挡住下载
 *
 * @param {string} url
 * @param {number} maxBytes 超过就抛错，错误对象带 oversize 标记
 * @param {number} timeoutMs
 * @returns {Promise<{buffer: Buffer, ext: string}>}
 */
export async function fetchImage (url, maxBytes, timeoutMs) {
  const res = await fetch(url, { signal: AbortSignal.timeout(timeoutMs) })
  if (!res.ok) throw new Error(`HTTP ${res.status}`)
  const tooBig = n => {
    const err = new Error(`图片 ${(n / 1048576).toFixed(1)}MB，超过 ${(maxBytes / 1048576).toFixed(0)}MB 限制`)
    err.oversize = true
    return err
  }
  const len = Number(res.headers.get('content-length'))
  if (len && len >= maxBytes) throw tooBig(len)
  const buffer = Buffer.from(await res.arrayBuffer())
  // 分块传输不给 content-length，这种只能下完再判
  if (buffer.length >= maxBytes) throw tooBig(buffer.length)
  const type = (res.headers.get('Content-Type') || 'image/jpeg').split(';')[0]
  return { buffer, ext: type.split('/')[1] || 'jpeg' }
}
