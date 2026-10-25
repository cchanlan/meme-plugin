/**
 * 数 GIF 的帧数。
 *
 * 只服务 Web 站：站内生成的结果要分「动图 / 静态图」，而静态模板（比如舔脚）
 * 输出的也是 .gif，只是只有 1 帧。页面上照旧写「保存 GIF」+「存成 .gif 再发」，
 * 用户下下来发现不动，只会以为生成坏了 —— 那两句提示得按真实帧数换掉。
 *
 * 不能直接 `buf.includes(0x21,0xF9,0x04)`：LZW 图像数据里同样会出现这串字节，
 * 用朴素扫描会把静态图误判成动图。这里按 GIF 的块结构走一遍，
 * 跳过调色板和扩展块的子块，只数图像描述符（0x2C）。
 *
 * 结构对不上就返回已知帧数（0 表示不是 GIF）。
 */
export function countGifFrames (buf) {
  if (!Buffer.isBuffer(buf) || buf.length < 14) return 0
  const sig = buf.toString('latin1', 0, 6)
  if (sig !== 'GIF89a' && sig !== 'GIF87a') return 0

  let p = 6
  // 逻辑屏幕描述符：宽 2 + 高 2 + flags 1 + 背景色 1 + 像素比 1
  const gflags = buf[p + 4]
  p += 7
  if (gflags & 0x80) p += 3 * (1 << ((gflags & 0x07) + 1))

  let frames = 0
  const skipSubBlocks = () => {
    while (p < buf.length) {
      const n = buf[p++]
      if (!n) return
      p += n
    }
  }

  while (p < buf.length) {
    const b = buf[p++]
    if (b === 0x3b) break // trailer，正常结束
    if (b === 0x2c) {
      frames++
      const lflags = buf[p + 8]
      p += 9 // 左 2 + 上 2 + 宽 2 + 高 2 + flags 1
      if (lflags & 0x80) p += 3 * (1 << ((lflags & 0x07) + 1))
      p++ // LZW 最小码长
      skipSubBlocks()
    } else if (b === 0x21) {
      p++ // 扩展块 label，块体本身就是子块结构
      skipSubBlocks()
    } else {
      // 对不上的字节说明文件不符合预期（或已被截断），别硬数
      break
    }
  }
  return frames
}
