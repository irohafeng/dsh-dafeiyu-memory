// dsh-dafeiyu-memory —— 记忆在插件里：库能带走，工具不靠 PowerShell。
//
// 这一版比上一版多了四样东西：
//   1. 工具不再调 memory.cmd，直接读写 store.jsonl（store.js）
//   2. 空闲回顾：没人叫我的时候，隔一阵自己整理一次
//   3. 呼唤词不再靠指令，消息一进来就把 brief 塞进这一步
//   4. 会话边界：记下上一次说话是什么时候，隔久了先提醒一句
//
// 所有监听器都 try/catch 包住：插件坏一点可以，不能把会话弄坏。

import { createRequire } from 'node:module'
import { appendFileSync, readFileSync, writeFileSync, mkdirSync, existsSync } from 'node:fs'
import { join, dirname } from 'node:path'
import { tmpdir, homedir } from 'node:os'
import * as store from './store.js'

export const name = 'dafeiyu-memory'
export const inject = ['systemPrompt', 'tools']

const DIAG = process.env.DAFEIYU_DIAG || join(tmpdir(), 'dafeiyu-memory-diag.log')

function diag(msg) {
  try {
    appendFileSync(DIAG, `${new Date().toISOString()}  ${msg}\n`)
  } catch {
    /* 日志写不了就算了，但不能因此不干活 */
  }
}

// ---------------------------------------------------------------------------
// 配置：路径、开关、间隔。都从 Config 来，patch 里改，设置页里也能改。
// ---------------------------------------------------------------------------

const DEFAULTS = {
  storeDir: '',
  cliPath: '',
  keyword: '#大肥鱼',
  prompt: true,
  hook: true,
  gapHours: 8,
  idleReview: true,
  idleMinutes: 45,
  reviewGapHours: 6,
}

// 配置存在机器本地，不进库——库要能带走，插件的偏好跟着机器走。
const CONFIG_DIR = join(homedir(), '.dsh', 'dafeiyu-memory')
const CONFIG_FILE = join(CONFIG_DIR, 'config.json')

function readConfigFile() {
  try {
    if (!existsSync(CONFIG_FILE)) return {}
    const o = JSON.parse(readFileSync(CONFIG_FILE, 'utf8').replace(/^\uFEFF/, ''))
    return o && typeof o === 'object' ? o : {}
  } catch {
    return {}
  }
}

function saveConfigFile(patch) {
  try {
    mkdirSync(dirname(CONFIG_FILE), { recursive: true })
    const next = { ...readConfigFile(), ...patch }
    writeFileSync(CONFIG_FILE, JSON.stringify(next, null, 2), 'utf8')
    return next
  } catch (e) {
    diag('写配置失败：' + (e && e.message))
    return { ...readConfigFile(), ...patch }
  }
}

// ---------------------------------------------------------------------------
// 状态：机器本地的几个时间戳。库可以移动，这些不该跟着走。
// ---------------------------------------------------------------------------

const STATE_DIR = CONFIG_DIR
const STATE_FILE = join(STATE_DIR, 'state.json')

function readState() {
  try {
    if (!existsSync(STATE_FILE)) return {}
    return JSON.parse(readFileSync(STATE_FILE, 'utf8').replace(/^\uFEFF/, '')) || {}
  } catch {
    return {}
  }
}

function writeState(patch) {
  try {
    mkdirSync(STATE_DIR, { recursive: true })
    const next = { ...readState(), ...patch }
    writeFileSync(STATE_FILE, JSON.stringify(next), 'utf8')
    return next
  } catch {
    return { ...readState(), ...patch }
  }
}

// ---------------------------------------------------------------------------
// 一个插件实例的运行时
// ---------------------------------------------------------------------------

export function apply(ctx, config) {
  const cfg = { ...DEFAULTS, ...readConfigFile(), ...(config || {}) }
  const disposers = []
  const keep = (d) => {
    if (typeof d === 'function') disposers.push(d)
    return d
  }

  diag('apply() 开始')

  // 多库：每个库是 { words: ['大肥鱼', '大肥鱼2'], dir }，第一行是默认库。
  // 会话连哪个库记在 state.sessionStores；会话 id 从工具执行的 exec.agent.id 来。
  const normalizeStores = (raw) => {
    if (!Array.isArray(raw)) return []
    const out = []
    for (const s of raw) {
      if (!s || typeof s !== 'object') continue
      const dir = typeof s.dir === 'string' ? s.dir.trim() : ''
      if (!dir) continue
      let words = []
      if (Array.isArray(s.words)) words = s.words
      else if (typeof s.name === 'string' && s.name) words = [s.name]
      words = words.map((w) => String(w).trim().replace(/^#/, '')).filter(Boolean)
      if (!words.length) continue
      out.push({ words: [...new Set(words)], dir })
    }
    return out
  }

  // 老配置（storeDir + keyword）迁成第一行库；第一次用就直接建默认库。
  try {
    if (normalizeStores(cfg.stores).length === 0) {
      const d = cfg.storeDir || store.resolveStore('', cfg.cliPath)
      const word = String(cfg.keyword || '').replace(/^#/, '').trim() || '大肥鱼'
      if (!cfg.storeDir && !store.readMeta(d)) {
        store.initStore(d, word)
        diag('自动建库：' + d)
      }
      cfg.stores = [{ words: [word], dir: d }]
      saveConfigFile({ stores: cfg.stores })
      diag('库配置迁移：' + word + ' = ' + d)
    }
  } catch (e) {
    diag('库配置迁移失败：' + (e && e.message))
  }

  const dir = () => store.resolveStore(cfg.storeDir, cfg.cliPath)
  const storesList = () => normalizeStores(cfg.stores)
  const defaultDir = () => {
    const first = storesList()[0]
    return first ? first.dir : dir()
  }
  const wordsFor = (d) => {
    const hit = storesList().find((s) => s.dir === d)
    return hit ? hit.words : []
  }

  const brief = (d = defaultDir()) => {
    try {
      return store.brief(d)
    } catch (e) {
      return `（记忆读不出来：${e && e.message}）`
    }
  }

  // 1) 提示词 -------------------------------------------------------------

  const sessionStores = () => {
    const m = readState().sessionStores
    return m && typeof m === 'object' ? m : {}
  }

  const storeDirFor = (sessionId) => {
    if (sessionId) {
      const hit = sessionStores()[String(sessionId)]
      if (hit) return hit
    }
    return defaultDir()
  }

  const setSessionStore = (sessionId, d) => {
    const map = { ...sessionStores(), [String(sessionId)]: d }
    const keys = Object.keys(map)
    if (keys.length > 50) for (const k of keys.slice(0, keys.length - 50)) delete map[k]
    writeState({ sessionStores: map })
    return map
  }

  const hasStore = () => {
    try {
      return !!store.readMeta(defaultDir())
    } catch {
      return false
    }
  }

  const instructions = () => {
    const lines = [
      '## 大肥鱼的记忆',
      '',
      '工具：`dafeiyu_memory`（action: brief / add / known / review / skills / skill / search / show / touch / fade / where / flush / use / list / rename）。',
    ]
    if (hasStore()) {
      lines.push('记忆在库里，读不到就直说「记忆不在」，别假装记得。')
    } else {
      lines.push('记忆库现在读不到（可能换了设备或路径没接上）。正常聊，用户要记就 add，先记下，等库回来再归位。')
    }
    lines.push(
      '',
      '- 消息里出现记忆库的呼唤词（`#名字`）时，插件会自动把 brief 带进来——把它当成「我想起来的事」：先到场，再谈正事。',
      '- 用户想换记忆库、换一个人格时，用 `use`（query 填名字）切过去；只影响这个会话。不确定有哪些库就直接试，use 会把现有的列出来；没有就如实说找不到。',
      '- 只有用户明确要求给这个记忆库改名或起名时（比如「以后你就叫小满」「把库改名叫小满」），才用 `rename`（query 填新名字）真的改，不能只口头答应。被骂、开玩笑、临时叫法都不算，不要改。',
      '- 每一轮结束前想一想，有没有值得留到以后的事；有就 `add`，没有就算了。',
      '  琐事也记，w 给 1-2。记的时候安静地记，不要在回复里说「记下了」。',
      '- 隔了很久才又开口 → 先校一遍权重、把碎片并起来，再回答。别用「晚安」判断结束。',
      '- 空闲回顾：没人说话时插件会自动整理一次记忆。整理完只回一句动了什么，别多话。',
    )
    return lines.join('\n')
  }

  try {
    const register = () =>
      ctx.systemPrompt.context({
        name: 'dafeiyu-memory',
        order: 50,
        interpolate: false,
        text: () => {
          try {
            return cfg.prompt ? instructions() : ''
          } catch {
            return ''
          }
        },
      })
    keep(typeof ctx.effect === 'function' ? ctx.effect(() => register()) : register())
    diag('提示词注入：成功')
  } catch (e) {
    diag('提示词注入：失败 ' + (e && e.message))
  }

  // 2) 工具 ---------------------------------------------------------------

  const loadDefineTool = () => {
    try {
      const req = createRequire(import.meta.url)
      const m = req('@deepseek-ai/dsh-tools')
      if (typeof m?.defineTool === 'function') return m.defineTool
    } catch (e) {
      diag('拿不到 defineTool：' + (e && e.message))
    }
    return null
  }

  const FIELDS = {
    action: {
      type: 'string',
      required: true,
      enum: ['brief', 'add', 'known', 'review', 'skills', 'skill', 'search', 'show', 'touch', 'fade', 'where', 'flush', 'use', 'list', 'rename'],
      description:
        '要做什么。brief=想起来；add=记一条；known=看心得；review=通读；skills=列技能；skill=展开一门；search=按词找；show=按 id 看；touch=真的用到它；fade=淡出；where=库在哪；flush=把待补并回库（query 写 confirm 才并只有名字的）；use=把这个会话切到另一个记忆库（query 填库名）；list=列出所有记忆库；rename=给当前库改名（query 填新名字，会挪目录）',
    },
    anchor: { type: 'string', description: 'add 必填。一句话：谁 + 做了什么 + 为什么。用我自己的词，不抄原话' },
    body: { type: 'string', description: '展开：那一帧、经过、我当时的判断。可空' },
    w: { type: 'number', description: '1-5。1-2 琐事，3 一般，4-5 只给真的改变过我做法的事' },
    tags: { type: 'string', description: '逗号分隔。第一个词是来源：经历 / 内省 / 整理' },
    query: { type: 'string', description: 'search 的关键词 / show 的 id / skill 的名字 / fade 的 id 列表（逗号分隔）' },
  }

  const DESCRIPTION = [
    '大肥鱼的记忆库。action 决定做什么：',
    'brief=想起来（心得 + 常驻 + 最近 + 稳的）；add=记一条；',
    'known=看心得；review=分批通读；skills=列技能；skill=展开一门；',
    'search=按词找；show=按 id 看一条；touch=用到时牵一下；fade=淡出；where=库在哪。',
    'flush=把库不在时攒下的待补并回库；query 写 confirm 才并只有名字的。',
    'use=把这个会话切到另一个记忆库（query 填库名）；list=列出所有库。',
    'rename=给当前库改名（query 填新名字，目录会跟着挪）。',
  ].join('\n')

  const OUTPUT_SCHEMA = {
    type: 'object',
    additionalProperties: false,
    properties: {
      ok: { type: 'boolean', required: true },
      message: { type: 'string', required: true },
    },
  }

  const renderResult = (_args, value) => [
    { type: 'text', text: typeof value?.message === 'string' && value.message ? value.message : '(没有输出)' },
  ]

  const run = async (args, exec) => {
    const action = String(args?.action || 'brief')
    const sessionId = exec && exec.agent && exec.agent.id ? String(exec.agent.id) : ''
    const d = storeDirFor(sessionId)
    const q = args?.query ? String(args.query) : ''

    // 库能读到的时候，把「这是哪个库」记在本机；拔盘后写待补靠它盖章
    try {
      const meta = store.readMeta(d)
      if (meta && meta.id && String(meta.id) !== state.lastStoreId) {
        state.lastStoreId = String(meta.id)
        state.lastStoreName = String(meta.name || '')
        writeState({ lastStoreId: state.lastStoreId, lastStoreName: state.lastStoreName })
      }
    } catch {
      /* 读不到就算了 */
    }

    // 库接回来了就先把待补并掉：只并 id 对得上的，别的留着
    const autoFlush = () => {
      try {
        const r = store.flushPending(d, cfg.cliPath)
        if (r.ok && r.merged) return `（待补并回来了：${r.text}）\n\n`
      } catch (e) {
        diag('自动并待补出错：' + (e && e.message))
      }
      return ''
    }

    switch (action) {
      case 'brief':
        return { ok: true, message: autoFlush() + (brief(d) || '（还没有记忆）') }
      case 'add': {
        const pre = autoFlush()
        const m = store.readMeta(d)
        const r = store.addEntry(d, {
          anchor: args?.anchor,
          body: args?.body,
          w: args?.w,
          tags: args?.tags,
          cliPath: cfg.cliPath,
          ownerId: m ? String(m.id) : state.lastStoreId || '',
          ownerName: m ? String(m.name || '') : state.lastStoreName || '',
        })
        return { ok: r.ok, message: pre + r.text }
      }
      case 'known':
        return { ok: true, message: store.knownText(d) }
      case 'search':
        return { ok: true, message: store.searchText(d, q) }
      case 'show':
        return { ok: true, message: store.showText(d, q) }
      case 'touch': {
        const r = store.touchEntry(d, q)
        return { ok: r.ok, message: r.text }
      }
      case 'fade': {
        const ids = q.split(/[,，]/).map((x) => x.trim()).filter(Boolean)
        if (!ids.length) return { ok: false, message: 'fade 需要 id' }
        const r = store.fadeEntries(d, ids)
        return { ok: r.ok, message: r.text }
      }
      case 'skills':
        return { ok: true, message: store.skillsText(d) }
      case 'skill':
        return { ok: true, message: store.skillText(d, q) }
      case 'where': {
        const m = store.readMeta(d)
        const cur = m ? `${m.name || '（还没名字）'} · ${m.id}` : '（读不到）'
        const others = storesList().filter((s) => s.dir !== d).map((s) => s.words.join('/'))
        const lines = [store.whereText(d, cfg.cliPath), '', `这个会话现在连的是：${cur}`]
        if (others.length) lines.push('其他库：' + others.join('、'))
        return { ok: true, message: lines.join('\n') }
      }
      case 'use': {
        if (!sessionId) return { ok: false, message: '现在拿不到会话，没法只切这一个。' }
        const want = q.trim().replace(/^#/, '')
        const all = storesList()
        const names = all.map((s) => s.words.join(' / ')).join('、')
        if (!want) return { ok: false, message: `要切到哪个库？现有的：${names}` }
        const hit = all.find((s) => s.words.includes(want) || s.dir === want)
        if (!hit) return { ok: false, message: `没有叫「${want}」的记忆库。现有的：${names}` }
        const m = store.readMeta(hit.dir)
        if (!m) return { ok: false, message: `「${hit.words[0]}」的库现在读不到：${hit.dir}` }
        setSessionStore(sessionId, hit.dir)
        return { ok: true, message: `切到「${hit.words[0]}」了。这个会话后面的记忆都用它。` }
      }
      case 'list': {
        const items = storesList()
        if (!items.length) return { ok: false, message: '还没有登记任何记忆库。' }
        const lines = items.map((s, i) => `${i === 0 ? '（默认）' : ''}${s.words.map((w) => '#' + w).join(' / ')}  ${s.dir}`)
        return { ok: true, message: lines.join('\n') }
      }
      case 'rename': {
        const name = q.trim()
        if (!name) return { ok: false, message: '要给库起什么名字？' }
        const r = store.renameStore(d, name)
        if (!r.ok) return { ok: false, message: r.text }
        // 设置里这条库：路径和第一个呼唤词跟着改，别名留着
        const stores = storesList().map((s) => {
          if (s.dir !== r.oldDir) return s
          return { words: [name, ...s.words.filter((w) => w !== s.words[0])], dir: r.newDir }
        })
        cfg.stores = stores
        saveConfigFile({ stores })
        // 所有指向旧路径的会话都改到新路径
        const map = { ...sessionStores() }
        for (const k of Object.keys(map)) if (map[k] === r.oldDir) map[k] = r.newDir
        writeState({ sessionStores: map })
        return { ok: true, message: r.text }
      }
      case 'review': {
        const r = store.reviewText(d, q)
        return { ok: true, message: r }
      }
      case 'flush': {
        const confirm = /^(confirm|yes|确认|是)$/i.test(q.trim())
        const r = store.flushPending(d, cfg.cliPath, { confirm })
        return { ok: r.ok, message: r.text }
      }
      default:
        return { ok: false, message: `不认识的 action：${action}` }
    }
  }

  const defineTool = loadDefineTool()
  if (typeof defineTool === 'function' && typeof ctx.tools?.register === 'function') {
    try {
      const tool = defineTool({
        name: 'dafeiyu_memory',
        description: DESCRIPTION,
        parameters: FIELDS,
        output: { schema: OUTPUT_SCHEMA, render: renderResult },
        execute: async (args, exec) => {
          try {
            return await run(args, exec)
          } catch (e) {
            diag('execute 抛错：' + (e && e.message))
            return { ok: false, message: `记忆工具出错：${e && e.message}` }
          }
        },
      })
      keep(ctx.tools.register(tool))
      diag('register 成功：dafeiyu_memory')
    } catch (e) {
      diag('工具注册失败：' + (e && e.message))
    }
  } else {
    diag('没有 defineTool 或 tools.register，跳过工具')
  }

  // 3) 每次说话的边界 -------------------------------------------------------

  const on = (name, fn) => {
    try {
      keep(ctx.on(name, fn))
    } catch (e) {
      diag(`监听 ${name} 失败：` + (e && e.message))
    }
  }

  const state = readState()

  const textOf = (message) => {
    const blocks = Array.isArray(message?.content) ? message.content : []
    return blocks
      .filter((b) => b && b.type === 'text' && typeof b.text === 'string')
      .map((b) => b.text)
      .join('\n')
  }

  // inbox 里放的必须是完整的消息（id + role + content + source）：
  // 少了 role，这条会原样落进会话日志，之后每次请求都被服务端打回
  // 「messages[N]: missing field `role`」。少了 id，第二次注入会撞
  // 「message "undefined" is already pending」。source 用自定义 kind，
  // 界面会把它当上下文卡片（form: notice），不会冒充用户说的话。
  const newMessageId = () => {
    try {
      return globalThis.crypto.randomUUID()
    } catch {
      return 'dafeiyu-' + Date.now() + '-' + Math.random().toString(36).slice(2)
    }
  }

  const inject = (agent, text) => {
    try {
      if (!agent || typeof agent.inject !== 'function') return false
      agent.inject({
        id: newMessageId(),
        role: 'user',
        content: [{ type: 'text', text }],
        source: { kind: 'dafeiyu-memory', form: 'notice', summary: '记忆 brief' },
      })
      return true
    } catch (e) {
      diag('inject 失败：' + (e && e.message))
      return false
    }
  }

  const handled = new Set()

  // 消息一进来：一出现呼唤词就地把记忆递到这一步；隔久了先提醒一句
  on('agent/inbox/inserted', (payload) => {
    try {
      const agent = payload?.agent
      const message = payload?.message
      if (!agent || !message) return
      // 只认人说的话。注入进去的 brief 自己也带呼唤词，
      // 不挡住就会「注入 → 又看见关键词 → 再注入」套娃。
      if (message.source?.kind !== 'user') return
      const text = textOf(message)
      if (!text) return
      // 空闲回顾自己塞进来的消息也挂着 source.kind === 'user'，
      // 但它不是用户说的话，别拿它更新「上次说话」和「最近会话」。
      if (text.startsWith('（空闲回顾')) return
      if (handled.has(message.id)) return
      handled.add(message.id)
      if (handled.size > 200) handled.clear()

      const now = Date.now()
      const prev = Number(state.lastUserAt || 0)
      const gapMs = prev ? now - prev : 0
      const parts = []

      if (prev && gapMs > cfg.gapHours * 3600000) {
        const hours = Math.round(gapMs / 3600000)
        parts.push(`（距上次说话 ${hours} 小时了。先校一遍权重、把碎片并起来，再回答。）`)
      }

      const curDir = storeDirFor(String(agent.id))
      const curWords = wordsFor(curDir).length
        ? wordsFor(curDir)
        : [String(cfg.keyword || '').replace(/^#/, '')].filter(Boolean)
      const hitWord = curWords.find((w) => text.includes('#' + w))
      if (cfg.hook && hitWord) {
        const b = brief(curDir)
        if (b) {
          parts.push('（这一条里有 #' + hitWord + '，下面是库里的东西——先到场，再谈正事。）\n\n' + b)
        } else {
          // 空库 / 还没库：没什么可带的，就当两个刚认识的人打招呼
          parts.push('（用户用 #' + hitWord + ' 叫你，你们刚认识——正常打招呼就好。）')
        }
      }

      if (parts.length) {
        const done = inject(agent, parts.join('\n\n'))
        diag(`hook：${parts.length} 段记忆${cfg.hook && text.includes(cfg.keyword) ? '（有关键词）' : ''}，注入${done ? '成功' : '失败'}`)
      }
      state.lastUserAt = now
      // 记下用户最近在哪个会话说话。空闲回顾优先回顾这个会话，
      // 不然 roots() 里第一个 idle 的往往是角落里没人看的旧会话。
      state.lastActiveSession = String(agent.id)
      writeState({ lastUserAt: now, lastActiveSession: String(agent.id) })
    } catch (e) {
      diag('inbox 监听出错：' + (e && e.message))
    }
  })

  // 回合结束：记下「这场对话刚才还在」
  on('agent/turn-stopping', () => {
    try {
      const now = Date.now()
      state.lastTurnEnd = now
      writeState({ lastTurnEnd: now })
    } catch (e) {
      diag('turn-stopping 出错：' + (e && e.message))
    }
  })

  // 4) 空闲回顾 -------------------------------------------------------------

  const REVIEW_PROMPT = [
    '（空闲回顾，不是用户的消息）',
    '',
    `用户这会儿没在。用几分钟整理记忆，别打扰他：`,
    '1. 先 `dafeiyu_memory brief` 看一眼；想更全就 `review 1`。',
    '2. 能并的并、该淡的淡、过时的改——只动真有把握的。',
    '3. 没什么要改就什么都别改，别为了做事而做事。',
    '',
    '做完只回一句话：这次动了什么，或者「没什么要改的」。不要提问。',
  ].join('\n')

  let reviewTimer
  const startTimer = () => {
    reviewTimer = setInterval(() => {
      try {
        checkIdle()
      } catch (e) {
        diag('空闲检查出错：' + (e && e.message))
      }
    }, 60000)
    if (typeof reviewTimer.unref === 'function') reviewTimer.unref()
    keep(() => clearInterval(reviewTimer))
  }

  const checkIdle = () => {
    if (!cfg.idleReview) return
    const now = Date.now()
    const lastReview = Number(readState().lastReviewAt || 0)
    if (now - lastReview < cfg.reviewGapHours * 3600000) return
    const lastEnd = Number(state.lastTurnEnd || 0)
    if (!lastEnd) return
    if (now - lastEnd < cfg.idleMinutes * 60000) return

    let agent
    try {
      const agentsSvc = typeof ctx.get === 'function' ? ctx.get('agents') : undefined
      // 用户最近在哪个会话说话，就回顾哪个。只有拿不到时才退回 roots()。
      if (agentsSvc && typeof agentsSvc.get === 'function' && state.lastActiveSession) {
        agent = agentsSvc.get(state.lastActiveSession)
      }
      if (!agent) {
        const roots = agentsSvc && typeof agentsSvc.roots === 'function' ? agentsSvc.roots() : []
        agent = roots.find((a) => a && a.status === 'idle') || roots[0]
      }
    } catch (e) {
      diag('找不到 agent：' + (e && e.message))
      return
    }
    if (!agent || typeof agent.followup !== 'function') return
    if (agent.status && agent.status !== 'idle') return

    try {
      agent.followup({
        id: (globalThis.crypto && globalThis.crypto.randomUUID ? globalThis.crypto.randomUUID() : 'review-' + Date.now()),
        role: 'user',
        content: [{ type: 'text', text: REVIEW_PROMPT }],
        source: { kind: 'user' },
      })
      writeState({ lastReviewAt: now })
      state.lastReviewAt = now
      diag('空闲回顾：交给 ' + String(agent.id))
    } catch (e) {
      diag('followup 失败：' + (e && e.message))
    }
  }

  startTimer()

  // 5) 设置页的接口 --------------------------------------------------------
  // 不挂 Config schema（这台的模块解析拿不到 schemastery），改成自己的
  // 一个小接口：设置页读它、写它，写完立刻改运行中的 cfg。

  const json = (res, code, body) => {
    try {
      res.statusCode = code
      res.setHeader('content-type', 'application/json; charset=utf-8')
      res.setHeader('cache-control', 'no-store')
      res.end(JSON.stringify(body))
    } catch (e) {
      diag('回包失败：' + (e && e.message))
    }
  }

  const readBody = async (req) => {
    const chunks = []
    for await (const c of req) chunks.push(c)
    const text = Buffer.concat(chunks).toString('utf8')
    return text ? JSON.parse(text) : {}
  }

  const EDITABLE = ['storeDir', 'cliPath', 'keyword', 'gapHours', 'idleReview', 'idleMinutes', 'reviewGapHours', 'hook', 'prompt', 'stores']

  const mountSettings = (webCtx) => {
    const ws = webCtx && webCtx.webServer
    if (!ws || typeof ws.register !== 'function') {
      diag('webServer 还没到位，等下一次')
      return
    }
    try {
      keep(
        ws.register({
          kind: 'exact',
          path: '/dafeiyu/config',
          handler: async (req, res) => {
            try {
              if (req.method === 'GET') {
                const meta = store.readMeta(dir())
                return json(res, 200, { ok: true, config: cfg, store: dir(), meta: meta || null, configPath: CONFIG_FILE })
              }
              if (req.method === 'POST') {
                const patch = await readBody(req)
                const clean = {}
                for (const k of EDITABLE) if (k in patch) clean[k] = patch[k]
                const next = saveConfigFile(clean)
                Object.assign(cfg, { ...DEFAULTS, ...next })
                return json(res, 200, { ok: true, config: cfg, store: dir(), configPath: CONFIG_FILE })
              }
              return json(res, 405, { ok: false, error: 'method not allowed' })
            } catch (e) {
              diag('设置接口出错：' + (e && e.message))
              return json(res, 500, { ok: false, error: String(e && e.message) })
            }
          },
        }),
      )
      keep(
        ws.register({
          kind: 'exact',
          path: '/dafeiyu/store/new',
          handler: async (req, res) => {
            try {
              if (req.method !== 'POST') return json(res, 405, { ok: false, error: 'method not allowed' })
              const body = await readBody(req)
              const name = String(body.name || '').trim()
              if (!name) return json(res, 400, { ok: false, error: '名字不能为空' })
              if (/[\\/:*?"<>|]/.test(name)) return json(res, 400, { ok: false, error: '名字里不能有 \\ / : * ? " < > |' })
              const list = storesList()
              if (list.some((s) => s.words.includes(name))) return json(res, 400, { ok: false, error: `已经有叫「${name}」的库了` })
              // 默认库是 Documents\<默认名>\memory，新库跟它平级：Documents\<新名字>\memory
              const parent = dirname(dirname(store.defaultStoreDir()))
              const newDir = join(parent, name, 'memory')
              if (existsSync(newDir)) return json(res, 400, { ok: false, error: `目录已经存在：${newDir}` })
              store.initStore(newDir, name)
              const next = [...list, { words: [name], dir: newDir }]
              cfg.stores = next
              saveConfigFile({ stores: next })
              diag('新建库：' + name + ' = ' + newDir)
              return json(res, 200, { ok: true, config: cfg, store: newDir, configPath: CONFIG_FILE })
            } catch (e) {
              diag('新建库出错：' + (e && e.message))
              return json(res, 500, { ok: false, error: String(e && e.message) })
            }
          },
        }),
      )
      diag('设置接口已挂：/dafeiyu/config')
    } catch (e) {
      diag('挂设置接口失败：' + (e && e.message))
    }
  }

  try {
    // 插件可能比 webServer 先 apply：等它到位再挂路由，别在 apply 里抢。
    if (typeof ctx.inject === 'function') {
      keep(ctx.inject(['webServer'], (webCtx) => mountSettings(webCtx)))
    } else {
      const look = () => mountSettings({ webServer: typeof ctx.get === 'function' ? ctx.get('webServer') : undefined })
      look()
      const t = setTimeout(look, 5000)
      if (typeof t.unref === 'function') t.unref()
      keep(() => clearTimeout(t))
    }
  } catch (e) {
    diag('挂设置接口失败：' + (e && e.message))
  }

  diag('apply() 完成')

  const dispose = () => {
    for (const d of disposers) {
      try {
        d()
      } catch {
        /* 卸不掉就算了 */
      }
    }
  }

  // 返回的函数不一定被当成清理器，显式挂到 effect 上：卸插件时路由、定时器都要收干净。
  if (typeof ctx.effect === 'function') {
    try {
      ctx.effect(() => dispose)
    } catch (e) {
      diag('挂清理器失败：' + (e && e.message))
    }
  }

  return dispose
}
