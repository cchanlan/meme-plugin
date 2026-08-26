/**
 * 表情包 Web 预览服务
 * 路由分发见 ./routes/index.js
 */
import http from 'node:http'
import Config from '../model/config.js'
import { logPrefix } from '../constants/path.js'
import { getRoute } from './routes/index.js'

export function startWebServer () {
  // 防热更冲突：Yunzai 热重载会重新执行本文件，旧的 listen 不关掉会 EADDRINUSE
  if (global.memePluginServer) {
    try {
      global.memePluginServer.close()
      delete global.memePluginServer
    } catch (err) {
      logger.error(`${logPrefix} 关闭遗留服务失败: ${err.message}`)
    }
  }

  const server = http.createServer(async (req, res) => {
    let urlObj
    try {
      urlObj = new URL(req.url, `http://${req.headers.host}`)
    } catch {
      res.writeHead(400)
      res.end('Bad Request')
      return
    }

    try {
      const handler = getRoute(urlObj.pathname, req.method)
      if (handler) {
        await handler(req, res, urlObj)
        return
      }
      res.writeHead(404)
      res.end('Not Found')
    } catch (err) {
      logger.error(`${logPrefix} Web 服务异常: ${err.stack || err.message}`)
      if (!res.headersSent) {
        res.writeHead(500, { 'Content-Type': 'text/plain; charset=utf-8' })
        // 具体错误只进日志：这个站是公开无鉴权的，err.message 里常带绝对路径
        res.end('Server Error')
      }
    }
  })

  const port = Config.get('webPort') || 3132

  server.on('error', err => {
    if (err.code === 'EADDRINUSE') {
      logger.error(`${logPrefix} 端口 ${port} 已被占用，Web 预览站未启动。可在配置里改 webPort`)
    } else {
      logger.error(`${logPrefix} Web 服务错误: ${err.message}`)
    }
  })

  server.listen(port, () => {
    logger.info(`${logPrefix} Web 预览站已启动: ${Config.getWebUrl()}/memes`)
  })

  global.memePluginServer = server
}

export function stopWebServer () {
  if (global.memePluginServer) {
    try {
      global.memePluginServer.close()
      delete global.memePluginServer
    } catch {}
  }
}
