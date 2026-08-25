import Config from './model/config.js'
import { pluginName } from './constants/path.js'

/**
 * 锅巴面板可视化配置入口
 * 返回 { pluginInfo, configInfo } 给 Guoba-Plugin 读取
 */
export function supportGuoba () {
  return {
    pluginInfo: {
      name: pluginName,
      title: '表情包插件',
      author: '@cchanlan',
      link: '',
      isV3: true,
      isV2: false,
      description: '接 meme-generator 做表情包，带 Web 在线预览站、分页列表、搜索出图、资源自动更新与可选一键部署',
      showInMenu: true,
      icon: 'mdi:emoticon-happy-outline',
      iconColor: '#4c8dff'
    },
    configInfo: {
      schemas: [
        {
          component: 'Divider',
          label: 'meme 服务'
        },
        {
          field: 'memeApiUrl',
          label: '服务地址',
          bottomHelpMessage: 'meme-generator 的地址。用现成的远程服务就填它，本机部署填 http://127.0.0.1:2233',
          component: 'Input',
          componentProps: { placeholder: 'http://127.0.0.1:2233' }
        },
        {
          field: 'apiTimeout',
          label: '请求超时(毫秒)',
          component: 'InputNumber',
          componentProps: { min: 5000, max: 120000 }
        },
        {
          component: 'Divider',
          label: '触发方式'
        },
        {
          field: 'forceSharp',
          label: '必须带 # 前缀',
          bottomHelpMessage: '关掉后「摸头」也能触发，但容易误触发，建议开着',
          component: 'Switch'
        },
        {
          field: 'replyWithQuote',
          label: '发表情时引用回复',
          component: 'Switch'
        },
        {
          field: 'maxFileSize',
          label: '图片大小上限(MB)',
          component: 'InputNumber',
          componentProps: { min: 1, max: 50 }
        },
        {
          field: 'masterProtect',
          label: '主人保护',
          bottomHelpMessage: '开启后，用打人类表情撅主人会被反撅',
          component: 'Switch'
        },
        {
          field: 'protectList',
          label: '参与保护的表情',
          bottomHelpMessage: '填英文 key（如 lash）。只有列进来的表情才会触发上面的反撅，默认已含 41 个打人类和成人向表情',
          component: 'GTags',
          componentProps: {
            placeholder: '输入表情 key 后回车',
            allowAdd: true,
            allowDel: true
          }
        },
        {
          component: 'Divider',
          label: '黑名单'
        },
        {
          field: 'blackUsers',
          label: '拉黑的用户',
          bottomHelpMessage: '填 QQ 号。这些人发表情相关指令一律不响应，且是静默放行不回提示 —— 回「你被拉黑了」反而给了对方刷屏的抓手',
          component: 'GTags',
          componentProps: {
            placeholder: '输入 QQ 号后回车',
            allowAdd: true,
            allowDel: true
          }
        },
        {
          field: 'blackMemes',
          label: '拉黑的表情',
          bottomHelpMessage: '填英文 key（如 petpet）或中文关键词（如 摸头）都行。按关键词拉黑会连带屏蔽该表情的全部别名，不会从另一个名字绕进来。生成、搜索、分类、列表、随机、Web 预览站全都会查不到',
          component: 'GTags',
          componentProps: {
            placeholder: '输入 key 或关键词后回车',
            allowAdd: true,
            allowDel: true
          }
        },
        {
          component: 'Divider',
          label: '列表与搜索'
        },
        {
          field: 'pageSize',
          label: '每页表情数',
          bottomHelpMessage: '服务端字号固定不缩放，数量越多字越小。80 约 1007x1410（3列），是清晰度与页数的平衡点',
          component: 'InputNumber',
          componentProps: { min: 20, max: 300 }
        },
        {
          field: 'searchMaxPreview',
          label: '搜索最多出图数',
          bottomHelpMessage: '搜索命中超过这个数就只出前 N 个的预览图',
          component: 'InputNumber',
          componentProps: { min: 20, max: 300 }
        },
        {
          field: 'tagMinCount',
          label: '分类最少表情数',
          bottomHelpMessage: 'tag 很碎，只显示表情数达到该值的分类',
          component: 'InputNumber',
          componentProps: { min: 1, max: 20 }
        },
        {
          component: 'Divider',
          label: 'Web 预览站'
        },
        {
          field: 'enableWeb',
          label: '启用 Web 预览站',
          bottomHelpMessage: '开启后可在浏览器里看每个表情的预览图并一键复制指令',
          component: 'Switch'
        },
        {
          field: 'webPort',
          label: '监听端口',
          component: 'InputNumber',
          componentProps: { min: 1024, max: 65535 }
        },
        {
          field: 'webUrl',
          label: '对外访问地址',
          bottomHelpMessage: '群里发的链接用它，如 http://your-domain.com。留空则用 localhost',
          component: 'Input',
          componentProps: { placeholder: '留空则用 http://localhost:端口' }
        },
        {
          field: 'enablePreviewCache',
          label: '预览图落盘缓存',
          bottomHelpMessage: '服务端预览接口没有缓存，建议开启。全量约 166MB',
          component: 'Switch'
        },
        {
          component: 'Divider',
          label: '更新与部署'
        },
        {
          field: 'memePm2Name',
          label: 'meme 服务的 pm2 进程名',
          bottomHelpMessage: '更新表情后要重启它才会加载新表情。务必填名字——pm2 的数字 ID 会随进程增删而错位',
          component: 'Input',
          componentProps: { placeholder: 'meme' }
        },
        {
          field: 'reposDir',
          label: '表情仓库目录',
          bottomHelpMessage: '机器上已有仓库（如 /opt/meme）就填那个路径，否则插件会另克隆一份而服务读不到，更新不生效。留空则用 data/meme-plugin/repos',
          component: 'Input',
          componentProps: { placeholder: '留空则用 data/meme-plugin/repos' }
        },
        {
          field: 'repos',
          label: '订阅的表情仓库',
          bottomHelpMessage: '#meme更新 会逐个 git pull 这些仓库，并把 memeSubDir 同步进 meme-generator 的 config.toml。memeSubDir 是仓库里存表情的子目录，各仓库不一样：contrib/jj 是 memes，meme_emoji/crazy_emoji 是 emoji，tudou-meme 是 meme。填错会让 meme_dirs 指向不存在的路径，服务扫不到表情',
          component: 'GSubForm',
          componentProps: {
            multiple: true,
            schemas: [
              {
                field: 'name',
                label: '显示名',
                component: 'Input',
                required: true,
                componentProps: { placeholder: 'meme-generator-contrib' }
              },
              {
                field: 'dir',
                label: '目录名',
                component: 'Input',
                required: true,
                componentProps: { placeholder: 'meme-generator-contrib' }
              },
              {
                field: 'url',
                label: 'git 地址',
                component: 'Input',
                required: true,
                componentProps: { placeholder: 'https://github.com/MemeCrafters/meme-generator-contrib' }
              },
              {
                field: 'branch',
                label: '分支',
                component: 'Input',
                componentProps: { placeholder: 'main' }
              },
              {
                field: 'memeSubDir',
                label: '表情子目录',
                component: 'Input',
                componentProps: { placeholder: 'memes' }
              }
            ]
          }
        },
        {
          field: 'gitProxy',
          label: 'GitHub 代理前缀',
          bottomHelpMessage: '留空为直连（推荐，本机已配 git 代理）。只有直连不通、且没有系统级代理时才填前缀型镜像，如 https://ghproxy.net/ 。这类公共镜像经常失效，报 403/522 就是它挂了，清空即可',
          component: 'Input'
        },
        {
          field: 'pipIndexUrl',
          label: 'pip 镜像源',
          bottomHelpMessage: '仅一键部署时用到',
          component: 'Input'
        },
        {
          field: 'deployPm2Name',
          label: '一键部署的进程名',
          bottomHelpMessage: '默认 meme-plugin，与机器上已有的 meme 进程隔离，避免冲突',
          component: 'Input',
          componentProps: { placeholder: 'meme-plugin' }
        }
      ],
      getConfigData () {
        return Config.getAll()
      },
      setConfigData (data, { Result }) {
        for (const [key, value] of Object.entries(data)) {
          if (value !== undefined) Config.set(key, value)
        }
        return Result.ok({}, '保存成功~')
      }
    }
  }
}
