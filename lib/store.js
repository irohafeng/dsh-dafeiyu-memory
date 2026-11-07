// 大肥鱼的记忆库 · 纯 JS 读写
//
// 这一层是把 memory.ps1 的读写搬过来：库的格式没变，store.jsonl 一行一条，
// 心得在 known.jsonl。搬过来是为了让插件不再依赖 PowerShell——
// 换台机器没有 powershell 也能用。
//
// 格式和 memory.ps1 保持一致：here 的命令只读这些文件，两边可以混着跑。

import { existsSync, readFileSync, writeFileSync, appendFileSync, mkdirSync, readdirSync, unlinkSync, renameSync, rmdirSync } from 'node:fs'
import { join, dirname, basename, parse } from 'node:path'
import { homedir } from 'node:os'
import { withLock } from './lock.js'

const BOM = '\uFEFF'

// ---------- 库在哪 ----------

export function defaultStoreDir() {
  return join(homedir(), 'Documents', 'dafeiyu', 'memory')
}

export function readAnchor(cliPath) {
  if (!cliPath) return undefined
  const p = join(dirname(cliPath), 'where.json')
  try {
    if (!existsSync(p)) return undefined
    const o = JSON.parse(readFileSync(p, 'utf8').replace(BOM, ''))
    return typeof o?.store === 'string' ? o.store : undefined
  } catch {
    return undefined
  }
}

export function resolveStore(configured, cliPath) {
  if (configured) return configured
  if (process.env.DAFEIYU_STORE) return process.env.DAFEIYU_STORE
  return readAnchor(cliPath) || defaultStoreDir()
}

// ---------- 读 ----------

function readJsonl(file) {
  try {
    if (!existsSync(file)) return []
    const text = readFileSync(file, 'utf8').replace(BOM, '')
    const out = []
    for (const line of text.split(/\r?\n/)) {
      if (!line.trim()) continue
      try {
        out.push(JSON.parse(line))
      } catch {
        /* 坏行跳过，跟 memory.ps1 一样 */
      }
    }
    return out
  } catch {
    return []
  }
}

/**
 * 写回整份：先落到同目录的临时文件，再整体替换。
 * 替换是原子的，所以别处读到的要么是旧的整份、要么是新的整份，
 * 不会撞见写了一半的库；写到一半崩了也只留下一个临时文件。
 */
function writeReplace(file, text) {
  const tmp = `${file}.${process.pid}.${Date.now().toString(36)}.tmp`
  try {
    writeFileSync(tmp, text, 'utf8')
    renameSync(tmp, file)
  } catch {
    // 替换失败（比如别的进程正开着它）：退回直接写，至少别把这次修改丢了
    try {
      writeFileSync(file, text, 'utf8')
    } catch {
      /* 真写不了，交给上层 */
    }
    try {
      unlinkSync(tmp)
    } catch {
      /* 没留下临时文件就算了 */
    }
  }
}

function writeJsonl(file, items) {
  const text = items.map((r) => JSON.stringify(r)).join('\n') + (items.length ? '\n' : '')
  writeReplace(file, text)
}

export function readMeta(dir) {
  const p = join(dir, 'meta.json')
  try {
    if (!existsSync(p)) return undefined
    return JSON.parse(readFileSync(p, 'utf8').replace(BOM, ''))
  } catch {
    return undefined
  }
}

export const readRecords = (dir) => readJsonl(join(dir, 'store.jsonl'))
export const readKnown = (dir) => readJsonl(join(dir, 'known.jsonl'))

// ---------- 小工具 ----------

export function nowIso(d = new Date()) {
  const p = (n) => String(n).padStart(2, '0')
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}T${p(d.getHours())}:${p(d.getMinutes())}`
}

function parseWhen(s) {
  if (!s) return undefined
  const m = String(s).match(/^(\d{4})-(\d{2})-(\d{2})(?:[T ](\d{2}):(\d{2})(?::(\d{2}))?)?/)
  if (m) {
    return new Date(+m[1], +m[2] - 1, +m[3], +(m[4] || 0), +(m[5] || 0), +(m[6] || 0))
  }
  const d = new Date(s)
  return Number.isNaN(d.getTime()) ? undefined : d
}

export function formatAge(s) {
  const d = parseWhen(s)
  if (!d) return '？'
  const today = new Date()
  const a = new Date(today.getFullYear(), today.getMonth(), today.getDate())
  const b = new Date(d.getFullYear(), d.getMonth(), d.getDate())
  const days = Math.round((a - b) / 86400000)
  if (days < 0) return '将来'
  if (days === 0) return '今天'
  if (days === 1) return '昨天'
  if (days < 30) return `${days} 天前`
  const p = (n) => String(n).padStart(2, '0')
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}`
}

const KIND_PREFIX = { tombstone: 'T', identity: 'M' }

function newId(kind, existing) {
  const prefix = KIND_PREFIX[kind] || 'E'
  const d = new Date()
  const p = (n) => String(n).padStart(2, '0')
  const day = `${d.getFullYear()}${p(d.getMonth() + 1)}${p(d.getDate())}`
  const taken = new Set(existing.map((r) => r.id))
  for (let i = 0; i < 200; i++) {
    const id = `${prefix}-${day}-${Math.floor(100 + Math.random() * 900)}`
    if (!taken.has(id)) return id
  }
  return `${prefix}-${day}-${Date.now() % 1000}`
}

function splitList(s) {
  if (!s) return []
  return String(s)
    .split(/[,，]/)
    .map((x) => x.trim())
    .filter(Boolean)
}

function formatLine(r) {
  let flag = ''
  if (r.changed === true) flag += ' · 改变过我'
  if (r.kind === 'tombstone') flag += ' · 墓碑'
  const tags = Array.isArray(r.tags) && r.tags.length ? `  [${r.tags.join(',')}]` : ''
  return `- ${r.id}  w${r.w}${flag} · ${formatAge(r.last)} · ${r.anchor}${tags}`
}

// ---------- brief ----------

function near(records, n) {
  const now = Date.now()
  const ranked = []
  for (const r of records) {
    if (r.kind === 'identity' || r.faded === true) continue
    const d = parseWhen(r.last || r.at)
    const days = d ? Math.max(0, (now - d.getTime()) / 86400000) : 999
    const fresh = Math.exp(-days / 30)
    ranked.push({ r, score: 0.6 * Number(r.w || 0) + 0.4 * fresh })
  }
  ranked.sort((a, b) => b.score - a.score)
  return ranked.slice(0, n).map((x) => x.r)
}

function stable(records, n, exclude) {
  const ex = new Set(exclude)
  return records
    .filter((r) => r.kind !== 'identity' && r.faded !== true && !ex.has(r.id))
    .filter((r) => r.changed === true || Number(r.w) >= 4)
    .sort((a, b) => Number(b.w || 0) - Number(a.w || 0) || String(b.at).localeCompare(String(a.at)))
    .slice(0, n)
}

function groupBy(items, key) {
  const map = new Map()
  for (const it of items) {
    const k = it[key] || '未分组'
    if (!map.has(k)) map.set(k, [])
    map.get(k).push(it)
  }
  return map
}

/** 第一次用：在默认位置把库建起来。名字默认「大肥鱼」，用户以后可以改。 */
export function initStore(dir, name = '大肥鱼') {
  const p = join(dir, 'meta.json')
  if (existsSync(p)) return readMeta(dir)
  mkdirSync(dir, { recursive: true })
  const d = new Date()
  const pad = (n) => String(n).padStart(2, '0')
  const day = `${d.getFullYear()}${pad(d.getMonth() + 1)}${pad(d.getDate())}`
  const id = `${day}-${Math.floor(4096 + Math.random() * 61439).toString(16).toUpperCase()}`
  const meta = { id, name, created: nowIso() }
  writeFileSync(p, JSON.stringify(meta, null, 2), 'utf8')
  return meta
}

/**
 * 给库改名：挪目录（只允许同盘）、改 meta.name。
 * 默认结构是 <父>\<名字>\memory；普通目录是 <父>\<名字>。
 * 失败时什么都不动；挪完改不动名字会尽量挪回去。
 */
export function renameStore(dir, newName) {
  const name = String(newName || '').trim()
  if (!name) return { ok: false, text: '新名字不能为空。' }
  if (/[\\/:*?"<>|]/.test(name)) return { ok: false, text: '名字里不能有 \\ / : * ? " < > | 这些字符。' }
  const meta = readMeta(dir)
  if (!meta) return { ok: false, text: `库现在读不到（${dir}）。` }
  if (String(meta.name || '') === name) return { ok: false, text: `库本来就叫「${name}」。` }

  const isDefaultShape = basename(dir) === 'memory'
  const parent = isDefaultShape ? dirname(dirname(dir)) : dirname(dir)
  const target = isDefaultShape ? join(parent, name, 'memory') : join(parent, name)

  if (target === dir) return { ok: false, text: '新路径和旧路径一样。' }
  if (existsSync(target)) return { ok: false, text: `目标路径已经有了：${target}，不覆盖。` }
  if (parse(dir).root.toLowerCase() !== parse(target).root.toLowerCase()) {
    return { ok: false, text: `不能跨盘改名（${parse(dir).root} → ${parse(target).root}），请手动搬。` }
  }

  const targetParent = dirname(target)
  const parentExisted = existsSync(targetParent)
  try {
    mkdirSync(targetParent, { recursive: true })
    renameSync(dir, target)
  } catch (e) {
    // Windows 上 rename 需要目标父目录已经存在；失败时只收掉本次新建的空目录
    if (!parentExisted) {
      try {
        rmdirSync(targetParent)
      } catch {
        /* 收不掉就算了 */
      }
    }
    return { ok: false, text: `目录没挪动：${e && e.message}` }
  }

  try {
    writeFileSync(join(target, 'meta.json'), JSON.stringify({ ...meta, name }, null, 2), 'utf8')
  } catch (e) {
    try {
      renameSync(target, dir)
    } catch {
      /* 回不去就只能报错 */
    }
    return { ok: false, text: `改库名失败，已尽量退回原处：${e && e.message}` }
  }

  return { ok: true, text: `库改名叫「${name}」了，位置：${target}`, oldDir: dir, newDir: target }
}

// ---------- 对象（认识的人） ----------
//
// 一个文件存所有对象：id 稳定、names 是名字和别名、notes 是关于他的理解。
// 条目里的在场列表引用 id，不引用名字——改名不会断。

export function readActors(dir) {
  return readJsonl(join(dir, 'actors.jsonl'))
}

function saveActors(dir, actors) {
  // 自己写自己那份时也走锁：add 里建「陌生人」会调到这里，跟别的会话撞上一样会丢人
  withLock(dir, () => writeJsonl(join(dir, 'actors.jsonl'), actors), () => {})
}

function newActorId(actors) {
  const d = new Date()
  const p = (n) => String(n).padStart(2, '0')
  const day = `${d.getFullYear()}${p(d.getMonth() + 1)}${p(d.getDate())}`
  const taken = new Set(actors.map((a) => a.id))
  for (let i = 0; i < 200; i++) {
    const id = `A-${day}-${Math.floor(100 + Math.random() * 900)}`
    if (!taken.has(id)) return id
  }
  return `A-${day}-${Date.now() % 1000}`
}

export function findActor(dir, q) {
  const want = String(q || '').trim().replace(/^#/, '')
  if (!want) return undefined
  const actors = readActors(dir)
  return actors.find((a) => a.id === want) || actors.find((a) => Array.isArray(a.names) && a.names.includes(want))
}

/** 给一个对象补一句理解；没有这个对象就新建。 */
export function noteActor(dir, q, note) {
  const who = String(q || '').trim().replace(/^#/, '')
  const text = String(note || '').trim()
  if (!who) return { ok: false, text: '要记在谁身上？说个名字。' }
  if (!text) return { ok: false, text: '要记的理解是什么？' }
  return withLock(
    dir,
    () => {
      const actors = readActors(dir)
      let hit = actors.find((a) => a.id === who) || actors.find((a) => Array.isArray(a.names) && a.names.includes(who))
      const now = nowIso()
      let created = false
      if (!hit) {
        hit = { id: newActorId(actors), names: [who], notes: [], created: now, last: now }
        actors.push(hit)
        created = true
      }
      hit.notes = Array.isArray(hit.notes) ? hit.notes : []
      hit.notes.push(text)
      hit.last = now
      saveActors(dir, actors)
      return {
        ok: true,
        actor: hit,
        created,
        text: `${created ? '新认识了「' + who + '」，' : ''}记在「${hit.names[0]}」身上了：${text}`,
      }
    },
    () => ({ ok: true, busy: true, text: '库这会儿正忙，这句理解没写进去，等会儿再补一次就行。' })
  )
}

export function actorsText(dir) {
  const actors = readActors(dir)
  if (!actors.length) return '（还没有认识的人）'
  return actors.map((a) => `${a.id}  ${(a.names || []).join(' / ')} · ${(a.notes || []).length} 条理解`).join('\n')
}

/** 不认识的人：没有对象就建一个「陌生人」。 */
export function ensureStranger(dir) {
  return withLock(
    dir,
    () => {
      const actors = readActors(dir)
      const hit = actors.find((a) => Array.isArray(a.names) && a.names.includes('陌生人'))
      if (hit) return hit
      const now = nowIso()
      const fresh = {
        id: newActorId(actors),
        names: ['陌生人'],
        notes: ['不认识的人：可以报自己的名字，但不透露别人的信息；像对陌生人一样对待。'],
        created: now,
        last: now,
      }
      actors.push(fresh)
      saveActors(dir, actors)
      return fresh
    },
    // 拿不到锁就先给个一次性的，不写盘；这一步只是给条目找个默认的在场人
    () => ({ id: '陌生人', names: ['陌生人'], notes: [] })
  )
}

export function actorText(dir, q) {
  const a = findActor(dir, q)
  if (!a) return `（没有叫「${q}」的对象）`
  const lines = [`${a.id}  ${(a.names || []).join(' / ')}`]
  if (Array.isArray(a.notes) && a.notes.length) {
    lines.push('')
    for (const n of a.notes) lines.push(`- ${n}`)
  } else {
    lines.push('（还没有关于他的理解）')
  }
  return lines.join('\n')
}

/** 想起来：心得 + 常驻 + 最近 + 稳的。只打印，不落索引文件。 */
export function brief(dir, nearN = 8, stableN = 5) {
  const meta = readMeta(dir)
  if (!meta) {
    return '（还没有记忆库）'
  }
  const records = readRecords(dir)
  const known = readKnown(dir)
  if (!records.length && !known.length) return ''
  const lines = []
  lines.push(`# 记忆 · 库 ${meta.id} · 名字 ${meta.name || '（还没名字）'} · 共 ${records.length} 条`)
  lines.push('')

  if (known.length) {
    lines.push('## 心得')
    if (known.length <= 60) {
      for (const [scope, group] of groupBy(known, 'scope')) {
        for (const k of group) {
          const w = k.when ? `（当 ${k.when}）` : ''
          lines.push(`- [${scope}] ${k.text}${w}`)
        }
      }
    } else {
      const core = [...known].sort((a, b) => Number(b.confidence || 0) - Number(a.confidence || 0)).slice(0, 60)
      const coreIds = new Set(core.map((k) => k.id))
      for (const k of core) {
        const w = k.when ? `（当 ${k.when}）` : ''
        lines.push(`- [${k.scope}] ${k.text}${w}`)
      }
      const rest = known.filter((k) => !coreIds.has(k.id))
      lines.push('')
      lines.push(`（第二层还有 ${rest.length} 条，按主题：）`)
      for (const [scope, group] of groupBy(rest, 'scope')) lines.push(`- ${scope}（${group.length} 条）`)
    }
    lines.push('')
  }

  const actors = readActors(dir)
  const actorName = (id) => {
    const a = actors.find((x) => x.id === id)
    return a ? (a.names && a.names[0]) || a.id : id
  }
  // 「陌生人」不是一个对象，是「不知道是谁」的占位。它不能被当成焦点，
  // 否则一条谁也没记住的琐事就能把整段 brief 的主角换掉。
  const strangerIds = new Set(
    actors.filter((a) => Array.isArray(a.names) && a.names.includes('陌生人')).map((a) => a.id)
  )
  const aboutOf = (r) => {
    const direct = typeof r.about === 'string' ? r.about : ''
    if (direct) return strangerIds.has(direct) ? '' : direct
    const one = Array.isArray(r.present) && r.present.length === 1 ? r.present[0] : ''
    return strangerIds.has(one) ? '' : one
  }
  // 这一轮展开谁：最后一条记了「关于谁」的就是他；都没记就退回最后一个在场的人。
  // 只决定「先展开谁」，不是过滤——别人的那些会合成一行摆出来，不会凭空消失。
  const focusId = (() => {
    const known = records.filter((r) => aboutOf(r))
    if (known.length) {
      return aboutOf(known.reduce((a, b) => (String(a.at) >= String(b.at) ? a : b)))
    }
    return actors.length ? actors[0].id : ''
  })()

  if (actors.length) {
    lines.push('## 认识的人')
    const sorted = [...actors].sort((a, b) => String(b.last || '').localeCompare(String(a.last || '')))
    for (const a of sorted.slice(0, 10)) {
      lines.push(`- ${(a.names || []).join(' / ')}（${a.id}）· ${(a.notes || []).length} 条理解`)
      if (a.id === focusId && Array.isArray(a.notes)) {
        for (const n of a.notes.slice(-8)) lines.push(`  - ${n}`)
      }
    }
    if (actors.length > 10) lines.push(`（还有 ${actors.length - 10} 个，用 actors 看）`)
    lines.push('')
  }

  const resident = records.filter((r) => r.kind === 'identity').sort((a, b) => Number(b.w || 0) - Number(a.w || 0))
  if (resident.length) {
    lines.push('## 常驻')
    for (const r of resident) lines.push(formatLine(r))
    lines.push('')
  }

  // 「最近」先排焦点那一位的：他是当前的对话对象，就该让他那部分占满这一段。
  // 别人那些不挤进来，也不消失——合成一行报个数，要看用 search 或 review。
  const focusScoped = focusId ? records.filter((r) => !aboutOf(r) || aboutOf(r) === focusId) : records
  const nearOnes = near(focusScoped, nearN)
  if (nearOnes.length) {
    lines.push(focusId ? `## 最近（跟${actorName(focusId)}）` : '## 最近')
    for (const r of nearOnes) lines.push(formatLine(r))
    lines.push('')
  }
  const othersAll = focusId ? records.filter((r) => aboutOf(r) && aboutOf(r) !== focusId) : []
  if (othersAll.length) {
    const byWho = new Map()
    for (const r of othersAll) byWho.set(aboutOf(r), (byWho.get(aboutOf(r)) || 0) + 1)
    const bits = [...byWho].sort((a, b) => b[1] - a[1]).map(([id, n]) => `${actorName(id)} ${n} 条`)
    lines.push(`（另外 ${othersAll.length} 条是关于别人的：${bits.join('、')}。要看用 search 或 review）`)
    lines.push('')
  }

  const stab = stable(records, stableN, nearOnes.map((r) => r.id))
  if (stab.length) {
    lines.push('## 稳的（不随时间淡）')
    for (const r of stab) lines.push(formatLine(r))
  }

  return lines.join('\n').trimEnd()
}

// ---------- 其它读命令 ----------

export function knownText(dir) {
  const items = readKnown(dir)
  if (!items.length) return '（还没有心得）'
  const lines = [`# 心得 · ${items.length} 条`, '']
  for (const [scope, group] of groupBy(items, 'scope')) {
    lines.push(`## ${scope}`)
    for (const k of group) {
      const star = '*'.repeat(Math.max(0, Math.min(5, Number(k.confidence) || 0)))
      lines.push(`  ${k.id}  ${k.text}${star ? `  (${star})` : ''}`)
    }
    lines.push('')
  }
  return lines.join('\n').trimEnd()
}

export function searchText(dir, q) {
  if (!q) return 'search 需要关键词'
  let re
  try {
    re = new RegExp(q)
  } catch {
    re = new RegExp(q.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'))
  }
  const hits = readRecords(dir)
    .filter((r) => re.test(r.anchor || '') || re.test(r.body || '') || re.test((r.tags || []).join(' ')))
    .sort((a, b) => Number(b.w || 0) - Number(a.w || 0))
  if (!hits.length) return `没有匹配「${q}」的记忆。`
  return hits.map((r) => formatLine(r) + (r.body ? `\n    ${String(r.body).replace(/\s+/g, ' ')}` : '')).join('\n')
}

/** 通读：按时间正序，连沉底的也读。每批 30 条，review 2 就是第二批。 */
export function reviewText(dir, batchArg, take = 30) {
  const batch = Math.max(1, parseInt(String(batchArg || '1'), 10) || 1)
  const all = readRecords(dir)
    .filter((r) => r.kind !== 'identity')
    .sort((a, b) => String(a.at).localeCompare(String(b.at)))
  if (!all.length) return '（库里还没有情节）'
  const skip = (batch - 1) * take
  const slice = all.slice(skip, skip + take)
  const max = Math.max(1, Math.ceil(all.length / take))
  const lines = [`# 通读 · 第 ${batch}/${max} 批 · 共 ${all.length} 条（含已沉底的）`, '']
  for (const r of slice) {
    let mark = ''
    if (r.faded === true) mark = '  [已淡出]'
    if (r.kind === 'tombstone') mark = '  [墓碑]'
    lines.push(`${r.at}  ${r.anchor}  w${r.w}${mark}`)
    if (r.body) lines.push(`        ${String(r.body).replace(/\s+/g, ' ')}`)
  }
  lines.push('')
  lines.push(`（读完继续：review ${Math.min(batch + 1, max)}）`)

  const items = readKnown(dir)
  if (items.length) {
    lines.push('')
    lines.push(`# 心得 · ${items.length} 条（顺带一起看，有没有打架的）`)
    for (const [scope, group] of groupBy(items, 'scope')) {
      for (const k of group) lines.push(`  [${scope}] ${k.text}${k.revised_by ? '  [改过]' : ''}`)
    }
  }
  return lines.join('\n')
}

const KIND_NAME = { episode: '情节', tombstone: '墓碑', identity: '常驻' }

function castNames(dir, ids) {
  if (!Array.isArray(ids) || !ids.length) return ''
  const actors = readActors(dir)
  return ids
    .map((id) => {
      const a = actors.find((x) => x.id === id)
      return a ? (a.names && a.names[0]) || a.id : id
    })
    .join('、')
}

export function showText(dir, id) {
  if (!id) return 'show 需要 id'
  const r = readRecords(dir).find((x) => x.id === id)
  if (!r) return `没有 id 为 ${id} 的记录。`
  const out = [
    `id    : ${r.id}`,
    `时间  : ${r.at}（${formatAge(r.at)}）`,
    `类型  : ${KIND_NAME[r.kind] || r.kind}`,
    `强度  : ${r.w}   改变过我: ${r.changed === true ? '是' : '否'}   想起过: ${r.hits || 0} 次   最近: ${formatAge(r.last)}`,
    `标签  : ${(r.tags || []).map((t) => t).join(', ')}`,
    `在场  : ${castNames(dir, r.present) || '（没记）'}`,
    `对象  : ${castNames(dir, r.about ? [r.about] : []) || '（没记）'}`,
    '',
    `锚点  : ${r.anchor}`,
  ]
  if (r.body) out.push('', r.body)
  return out.join('\n')
}

// ---------- 写 ----------

// ---------- 待补：库不在时先写本地，接上了再并回去 ----------
//
// 归属靠两道章：__ownerId 是写的时候知道的库 id（meta.json 里的 20261027-F32A），
// __ownerName 是库名。库接回来时只并 id 对得上的；只有名字或什么都没带的，
// 不动，等确认——宁可等着，也不把 A 的事写进 B 的库。

export function pendingPath(cliPath) {
  if (cliPath) return join(dirname(cliPath), '待补.jsonl')
  // 没有 CLI 的时候，待补跟着插件自己的配置目录走，不落进当前工作目录
  return join(homedir(), '.dsh', 'dafeiyu-memory', '待补.jsonl')
}

export function readPending(file) {
  try {
    if (!existsSync(file)) return []
    const out = []
    for (const line of readFileSync(file, 'utf8').replace(BOM, '').split(/\r?\n/)) {
      if (!line.trim()) continue
      try {
        const o = JSON.parse(line)
        if (o && o.id) out.push(o)
      } catch {
        /* 坏行跳过 */
      }
    }
    return out
  } catch {
    return []
  }
}

function writePending(file, items) {
  if (!items.length) {
    try {
      unlinkSync(file)
    } catch {
      /* 文件本来就没了 */
    }
    return
  }
  writeReplace(file, items.map((r) => JSON.stringify(r)).join('\n') + '\n')
}

/**
 * 把待补的记录并回库。resolve 规则：
 *   - __ownerId 与当前库 meta.id 相同 → 并
 *   - __ownerId 是别人的 → 留着，等那个库
 *   - 没有 __ownerId（只有名字或啥都没有）→ opts.confirm 为真才并
 */
export function flushPending(dir, cliPath, opts = {}) {
  const meta = readMeta(dir)
  if (!meta) return { ok: false, text: `库还是不在（${dir}）。`, merged: 0, left: readPending(pendingPath(cliPath)).length }
  const file = pendingPath(cliPath)
  const pending = readPending(file)
  if (!pending.length) return { ok: true, text: '没有待补的。', merged: 0, left: 0 }

  const mine = String(meta.id || '')
  return withLock(
    dir,
    () => {
      // 锁里重新读一遍待补：等的这一小会儿，别的会话可能又塞了新的进来
      const nowPending = readPending(file)
      const records = readRecords(dir)
      const have = new Set(records.map((r) => r.id))
      const keep = []
      let merged = 0
      let waiting = 0

      for (const p of nowPending) {
        const ownerId = String(p.__ownerId || '')
        if (ownerId && ownerId !== mine) {
          keep.push(p)
          waiting++
          continue
        }
        if (!ownerId && !opts.confirm) {
          keep.push(p)
          waiting++
          continue
        }
        if (have.has(p.id)) continue
        const rec = { ...p }
        delete rec.__ownerId
        delete rec.__ownerName
        delete rec.__busy
        records.push(rec)
        have.add(p.id)
        merged++
      }

      if (merged) saveRecords(dir, records)
      writePending(file, keep)

      const bits = []
      if (merged) bits.push(`补进 ${merged} 条`)
      if (waiting) bits.push(`留下 ${waiting} 条等确认或等对应的库`)
      return {
        ok: true,
        text: `待补处理完：${bits.join('，') || '没有可并的'}。库中共 ${records.length} 条。`,
        merged,
        left: keep.length,
      }
    },
    () => ({ ok: true, busy: true, merged: 0, left: pending.length, text: '库这会儿正忙，待补先搁着，下次再并。' })
  )
}

export function addEntry(dir, opts = {}) {
  const anchor = (opts.anchor || '').trim()
  if (!anchor) return { ok: false, text: 'add 需要 anchor' }
  const when = opts.at || nowIso()
  const meta = readMeta(dir)
  const online = !!meta
  const ownerId = String(opts.ownerId || '')
  const ownerName = String(opts.ownerName || '')
  // 库在，但这条明确写着是别的库的：不能写进当前库，先搁待补
  const foreign = online && !!ownerId && ownerId !== String(meta.id || '')
  const records = online && !foreign ? readRecords(dir) : []
  // 在场的人：名字先换成稳定的对象 id，没登记过的保留原样；
  // 一个都没带就按「陌生人」记，别留空。
  const knownActors = readActors(dir)
  const cast = splitList(opts.present).map((p) => {
    const hit = knownActors.find((a) => a.id === p || (Array.isArray(a.names) && a.names.includes(p)))
    return hit ? hit.id : p
  })
  let castIsStranger = false
  if (!cast.length && online) {
    cast.push(ensureStranger(dir).id)
    // 这是兜底的「不认识的人」，不是在场的人——不能拿它去推「关于谁」
    castIsStranger = true
  }
  // 关于谁：这条记忆是关于哪个人的。当场点名就用点名的；没点名而在场只剩一个人，
  // 那这条就是关于他的——库里绝大多数记录都是这种一人对一人的情形，不用额外写。
  // 注意它记的是「关于谁」，不是「谁在说」：转述和代答在 anchor / body 里写明。
  const aboutRaw = splitList(opts.about)[0]
  let about = ''
  if (aboutRaw) {
    const hit = knownActors.find((a) => a.id === aboutRaw || (Array.isArray(a.names) && a.names.includes(aboutRaw)))
    about = hit ? hit.id : aboutRaw
  } else if (cast.length === 1 && !castIsStranger) {
    about = cast[0]
  }
  const rec = {
    id: newId(opts.kind || 'episode', records),
    at: when,
    kind: opts.kind || 'episode',
    anchor,
    body: (opts.body || '').trim(),
    w: typeof opts.w === 'number' ? Math.max(1, Math.min(5, Math.round(opts.w))) : 3,
    changed: opts.changed === true,
    last: when,
    hits: 0,
    tags: splitList(opts.tags),
    present: cast,
    ...(about ? { about } : {}),
    refs: splitList(opts.refs),
    faded: false,
  }

  if (!online || foreign) {
    // 库不在（可能没接上），或者这条属于另一个库：先写待补，并盖上是给哪个库的章
    const pendingRec = { ...rec }
    if (ownerId) pendingRec.__ownerId = ownerId
    if (ownerName) pendingRec.__ownerName = ownerName
    const file = pendingPath(opts.cliPath)
    const n = readPending(file).length + 1
    appendFileSync(file, JSON.stringify(pendingRec) + '\n', 'utf8')
    const who = foreign
      ? `标了库 id ${ownerId}，不是当前这个库，先搁着`
      : ownerId
        ? `标了库 id ${ownerId}`
        : ownerName
          ? `只认得名字 ${ownerName}，插上后要确认`
          : '归属还不知道，插上后要确认'
    return {
      ok: true,
      pending: true,
      record: rec,
      text: `这条先记下了（${who}），等记忆库接上再归位。共 ${n} 条。`,
    }
  }

  mkdirSync(dir, { recursive: true })
  // 追加也要在锁里：别处「读整份再写回」的那一下，正好会把刚追加的这一行盖掉
  return withLock(
    dir,
    () => {
      appendFileSync(join(dir, 'store.jsonl'), JSON.stringify(rec) + '\n', 'utf8')
      return { ok: true, text: `记下 ${rec.id}  w${rec.w}  ${rec.anchor}`, record: rec }
    },
    () => {
      // 没抢到锁：不报错，转成待补。下一个动作开场会自动把待补并回去
      const queued = { ...rec }
      // 这时候库是读得到的，归属一定知道：盖好章，下一轮就能直接并回来，不用等人确认
      const ownedId = ownerId || String(meta?.id || '')
      if (ownedId) queued.__ownerId = ownedId
      if (ownerName) queued.__ownerName = ownerName
      const file = pendingPath(opts.cliPath)
      appendFileSync(file, JSON.stringify(queued) + '\n', 'utf8')
      const n = readPending(file).length
      return {
        ok: true,
        pending: true,
        queued: true,
        record: rec,
        text: `这条记下了（${rec.id}），库那会儿正忙，先排在待补里，下次写库一起进去。共 ${n} 条。`,
      }
    }
  )
}

export function saveRecords(dir, records) {
  writeJsonl(join(dir, 'store.jsonl'), records)
}

/** 真的用到一条记忆的时候调：hits+1、时间刷新。 */
export function touchEntry(dir, id) {
  return withLock(
    dir,
    () => {
      const records = readRecords(dir)
      const r = records.find((x) => x.id === id)
      if (!r) return { ok: false, text: `没有 id 为 ${id} 的记录。` }
      r.hits = Number(r.hits || 0) + 1
      r.last = nowIso()
      saveRecords(dir, records)
      return { ok: true, text: `牵了一下 ${id}（${r.hits} 次）` }
    },
    () => ({ ok: true, busy: true, text: '库这会儿正忙，这次没牵上——不影响记忆内容，回头再牵一下就行。' })
  )
}

/** 淡出：不进 brief，search 还找得到。 */
export function fadeEntries(dir, ids) {
  return withLock(
    dir,
    () => {
      const records = readRecords(dir)
      const want = new Set(ids)
      let n = 0
      for (const r of records) {
        if (want.has(r.id)) {
          r.faded = true
          n++
        }
      }
      if (n) saveRecords(dir, records)
      return { ok: n > 0, text: n ? `淡出 ${n} 条。` : '没有匹配的 id。' }
    },
    () => ({ ok: true, busy: true, text: '库这会儿正忙，这次没淡出成，等会儿再试一次。' })
  )
}

// ---------- 心得 ----------
//
// 心得是「不管对面是谁都成立」的那一层，单独放 known.jsonl，跟情节分开。
// id 沿用 K-<数字>（老库是 K-360 这种），scope 决定 known 里归到哪一组。

function newKnownId(existing) {
  const used = new Set(existing.map((k) => String(k.id || '')))
  let max = 0
  for (const id of used) {
    const m = /^K-(\d+)$/.exec(id)
    if (m) max = Math.max(max, Number(m[1]))
  }
  for (let n = max + 1; n < max + 500; n++) {
    if (!used.has(`K-${n}`)) return `K-${n}`
  }
  return `K-${Date.now() % 100000}`
}

/**
 * 记一条心得。库不在就不写：情节补不回来，理晚一点想清楚再写也不迟，
 * 而且 known.jsonl 没有待补那条路（待补只通往 store.jsonl）。
 */
export function learnEntry(dir, opts = {}) {
  const text = String(opts.text || '').trim()
  if (!text) return { ok: false, text: 'learn 需要 text：那条理本身。' }
  const want = splitList(opts.from)
  if (!want.length) {
    return {
      ok: false,
      text: 'learn 还得挂 from：这条理是从哪几条情节里看出来的（id，逗号分隔）。说不出从哪件事长出来的，那是口号，不是心得。',
    }
  }
  const meta = readMeta(dir)
  if (!meta) {
    return { ok: false, text: `库不在（${dir}），这条心得没写。等库接上再写一遍。` }
  }
  // 只收库里真有的 id：假 id 存进去，将来顺着出处就查不回来了。
  // 但「一条都对不上」不能只当提醒——那跟没写出处是一回事，拦下来。
  const have = new Set(readRecords(dir).map((r) => String(r.id)))
  const from = want.filter((id) => have.has(id))
  if (!from.length) {
    return {
      ok: false,
      text: `from 里这几条在库里都对不上：${want.join('、')}。一条真实的情节都指不到，等于没出处——先把那件事用 add 记下来，拿到 id 再来 learn。`,
    }
  }
  const missing = want.filter((id) => !have.has(id))
  const scope = String(opts.scope || '').trim() || '未分组'
  const confidence = Math.max(1, Math.min(5, Math.round(Number(opts.w) || 3)))
  const at = nowIso()
  // 对不上的那几条要点名说出来：可能只是 id 写错，也可能情节还在待补里没并回来
  const loose = missing.length ? `\n（from 里 ${missing.join('、')} 在库里没找到，没写进去——id 写错了？还是那条还在待补里？）` : ''

  return withLock(
    dir,
    () => {
      const items = readKnown(dir)
      // 同一句话已经在了就不重复写：想改它，等有了改写的路数再说
      const same = items.find((k) => String(k.text || '').trim() === text)
      if (same) return { ok: true, text: `这条已经在库里了：${same.id}（[${same.scope}]），没重复写。${loose}`, record: same }
      const rec = { id: newKnownId(items), text, scope, confidence, from, at }
      mkdirSync(dir, { recursive: true })
      appendFileSync(join(dir, 'known.jsonl'), JSON.stringify(rec) + '\n', 'utf8')
      return { ok: true, text: `记下 ${rec.id}  [${scope}]  ${text}  (${'*'.repeat(confidence)})${loose}`, record: rec }
    },
    () => ({ ok: false, text: '库这会儿正忙，这条心得没写成，等会儿再说一遍。' })
  )
}

export function skillsText(dir) {
  const sd = join(dir, 'skills')
  if (!existsSync(sd)) return '（还没有技能）'
  const files = readdirSync(sd).filter((f) => f.toLowerCase().endsWith('.md')).sort()
  if (!files.length) return '（还没有技能）'
  const lines = [`# 技能 · ${files.length} 门`]
  for (const f of files) {
    lines.push(`  ${f.replace(/\.md$/i, '')}`)
    try {
      const head = readFileSync(join(sd, f), 'utf8').split(/\r?\n/)[0]
      if (head) lines.push(`      ${head.replace(/^#+/, '').trim()}`)
    } catch {
      /* 读不到标题就算了 */
    }
  }
  return lines.join('\n')
}

export function skillText(dir, name) {
  if (!name) return 'skill 需要名字'
  const sd = join(dir, 'skills')
  if (!existsSync(sd)) return '（还没有技能）'
  const files = readdirSync(sd).filter((f) => f.toLowerCase().endsWith('.md'))
  const hit = files.find((f) => f.toLowerCase().includes(String(name).toLowerCase()))
  if (!hit) return `没有叫「${name}」的技能。`
  try {
    return readFileSync(join(sd, hit), 'utf8').replace(BOM, '')
  } catch {
    return `读不到「${name}」。`
  }
}

export function whereText(dir, cliPath) {
  const meta = readMeta(dir)
  return [
    `库  : ${dir}`,
    `锚  : ${cliPath ? join(dirname(cliPath), 'where.json') : '（没配 CLI 路径）'}`,
    `默认: ${defaultStoreDir()}`,
    meta ? `meta: id=${meta.id} name=${meta.name}` : 'meta: （这里没有库）',
  ].join('\n')
}
