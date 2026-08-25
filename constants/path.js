import { basename, dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

/** Yunzai 根目录 */
const _path = process.cwd().replace(/\\/g, '/')
const pluginPath = join(dirname(fileURLToPath(import.meta.url)), '..').replace(/\\/g, '/')
const pluginName = basename(pluginPath)
const pluginResources = join(pluginPath, 'resources').replace(/\\/g, '/')

/** 数据目录名，落在 Yunzai 的 data/ 下 */
const dataDirName = 'meme-plugin'
const dataDir = join(_path, 'data', dataDirName).replace(/\\/g, '/')

const logPrefix = '[meme]'

export {
  _path,
  pluginPath,
  pluginName,
  pluginResources,
  dataDirName,
  dataDir,
  logPrefix
}
