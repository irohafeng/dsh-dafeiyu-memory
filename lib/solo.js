/**
 * 自己的时间（独处）：触发判断、独立会话、恢复、结束清理。
 *
 * 职责边界：这里只管「什么时候醒、醒在哪个会话、醒来带什么工具、怎么收拾」；
 * 记忆的读写仍然走 store.js，不在这里碰库的内容。
 *
 * 依赖从 index.js 传进来（ctx / cfg / state 读写 / 库目录解析），
 * 这样它不直接依赖插件的其余部分，也不会反过来抓到记忆读写的细节。
 */
export function createSolo(deps) {
  const { ctx, cfg, store, diag, readState, writeState, setSessionStore, storeDirFor, storesList } = deps

  // 一个库一个固定会话；全局同时只跑一个
  const PREFIX = 'dafeiyu-solo-'
  const sessionIdOf = (storeId) => PREFIX + String(storeId || 'x')

  // 不设任务清单——这是「有时间」，不是「有活要干」
  const PROMPT = [
    '（自己的时间，不是用户的消息）',
    '',
    '现在没人在跟你说话。这是你自己的时间。',
    '没有任务，也不用汇报。想翻库就翻，想写就写，不想写就空着。',
    '上次独处留下的东西还在这个会话里，想接着来就接着来。',
    '要记东西时，present 写你自己（你在这间库里的名字）——这段没有别人在场，别让它落成「陌生人」。',
    '如果用户回来了，把手上的这一段做完就停，不用收尾。',
  ].join('\n')

  let busy = null // { storeId, sessionId, startedAt, runAt }
  let handle = null

  // 醒来时只带记忆工具：独处只做记忆自己的事
  const setup = () => (agentCtx) => {
    try {
      const tools = typeof agentCtx.get === 'function' ? agentCtx.get('tools') : undefined
      if (tools && typeof tools.restrict === 'function') tools.restrict({ allow: ['dafeiyu_memory'] })
    } catch (e) {
      diag('独处限定工具失败：' + (e && e.message))
    }
  }

  // 独立 agent 不会自动继承普通会话的模型：从默认模型选择里取
  const modelOptions = () => {
    try {
      const svc = typeof ctx.get === 'function' ? ctx.get('agentDefaultModel') : undefined
      const sel = svc && typeof svc.currentSelection === 'function' ? svc.currentSelection() : undefined
      if (sel && sel.provider && sel.model) {
        const o = { provider: String(sel.provider), model: String(sel.model) }
        if (sel.reasoningEffort) o.reasoningEffort = sel.reasoningEffort
        return o
      }
    } catch (e) {
      diag('独处取默认模型失败：' + (e && e.message))
    }
    return null
  }

  const release = () => {
    const h = handle
    handle = null
    if (h && typeof h.dispose === 'function') {
      Promise.resolve()
        .then(() => h.dispose())
        .catch((e) => diag('独处释放失败：' + (e && e.message)))
    }
  }

  /** 该不该醒：用户闲够久、距上次结束够久、今天没超次数。 */
  const check = async () => {
    if (!cfg.solo) return
    if (busy) return
    const st = readState()
    const lastUser = Number(st.lastUserAt || 0)
    if (!lastUser) return
    const now = Date.now()
    if (now - lastUser < cfg.soloIdleMinutes * 60000) return
    const runs = Array.isArray(st.soloRuns) ? st.soloRuns : []
    // 间隔从「上一次结束」算：刚跑完就先歇一会儿
    const tail = runs.length ? runs[runs.length - 1] : null
    const last = tail ? Number(tail.endAt || tail.at || 0) : 0
    if (last && now - last < cfg.soloGapMinutes * 60000) return
    const d = new Date()
    const day = `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`
    // 一天几次只数真正跑完的
    if (runs.filter((r) => r && r.day === day && r.status === 'completed').length >= cfg.soloMaxPerDay) return

    const agentOptions = modelOptions()
    if (!agentOptions) {
      diag('独处：拿不到默认模型，这次不启动')
      return
    }

    // 挑库：先看用户最近说话那间绑的是哪个库，不然就第一个库
    const activeDir = st.lastActiveSession ? storeDirFor(String(st.lastActiveSession)) : ''
    const dir = activeDir || (storesList()[0] && storesList()[0].dir) || ''
    if (!dir) return
    const meta = store.readMeta(dir)
    if (!meta) return
    const sid = sessionIdOf(meta.id)
    const agents = typeof ctx.get === 'function' ? ctx.get('agents') : undefined
    if (!agents || typeof agents.get !== 'function') return

    busy = { storeId: String(meta.id), sessionId: sid, startedAt: now, runAt: now }
    try {
      let h
      try {
        h = await agents.resume({ resumeSessionId: sid, agentOptions, setup: setup() })
      } catch {
        h = await agents.create({ sessionId: sid, meta: { cwd: dir }, agentOptions, setup: setup() })
      }
      handle = h
      setSessionStore(sid, dir)
      h.agent.followup({
        id: globalThis.crypto && globalThis.crypto.randomUUID ? globalThis.crypto.randomUUID() : 'solo-' + now,
        role: 'user',
        content: [{ type: 'text', text: PROMPT }],
        // 独处有自己的来源：不冒充用户，也不改「最近活跃会话」
        source: { kind: 'dafeiyu-solo' },
      })
      writeState({ soloRuns: [...runs, { at: now, day, storeId: String(meta.id), status: 'started' }].slice(-200) })
      diag('自己的时间：交给 ' + sid + '（' + agentOptions.provider + '/' + agentOptions.model + '）')
    } catch (e) {
      busy = null
      release()
      diag('独处启动失败：' + (e && e.message))
    }
  }

  /** 这一轮结束：锁放掉、agent 释放，并把结束原因写进记录。 */
  const onTurnEnd = (sessionId, event) => {
    if (!busy || busy.sessionId !== sessionId) return
    const reason = event && event.data && event.data.reason ? event.data.reason : null
    const kind = reason && reason.kind ? String(reason.kind) : 'unknown'
    const errText = reason && reason.error && reason.error.message ? ' ' + String(reason.error.message).slice(0, 200) : ''
    diag('自己的时间：' + sessionId + ' 结束 reason=' + kind + errText)
    const st = readState()
    const list = Array.isArray(st.soloRuns) ? st.soloRuns : []
    const idx = list.findIndex((r) => r && Number(r.at) === Number(busy.runAt))
    if (idx >= 0) {
      list[idx] = { ...list[idx], status: kind === 'completed' ? 'completed' : 'failed', reason: kind, endAt: Date.now() }
      writeState({ soloRuns: list })
    }
    busy = null
    release()
  }

  /** 用户回来了：不打断正在写的那一段，只让它不开始新的。 */
  const onUserBack = () => {
    if (!busy) return
    try {
      const agents = typeof ctx.get === 'function' ? ctx.get('agents') : undefined
      const solo = agents && typeof agents.get === 'function' ? agents.get(busy.sessionId) : undefined
      if (solo && typeof solo.inject === 'function') {
        solo.inject({
          id: globalThis.crypto?.randomUUID?.() ?? 'solo-stop-' + Date.now(),
          role: 'user',
          content: [{ type: 'text', text: '（用户回来了，把手上这一段做完就停，不用开始新的。）' }],
          source: { kind: 'dafeiyu-solo', form: 'notice' },
        })
        diag('自己的时间：用户回来了，已递停止提示给 ' + busy.sessionId)
      }
    } catch (e) {
      diag('独处让路提示失败：' + (e && e.message))
    }
  }

  return { check, onTurnEnd, onUserBack, PREFIX, isBusy: () => !!busy }
}
