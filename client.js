// dsh-dafeiyu-memory · 设置页（Client 半）
//
// 挂在「设置 → 记忆」那一栏。只做三件事：看库在哪、改几个间隔、把开关拨回去。
// 数据从 Host 的 /dafeiyu/config 来，不碰别的插件的东西。

window.__ModuleLoader__.load({
  id: 'dsh-dafeiyu-memory',
  factory(require) {
    const React = require('react')
    const h = React.createElement

    const label = { fontSize: 12, color: 'var(--dsw-alias-label-secondary)', marginBottom: 6 }
    const input = {
      width: '100%',
      boxSizing: 'border-box',
      padding: '7px 10px',
      borderRadius: 8,
      border: '1px solid var(--dsw-alias-border-l1)',
      background: 'var(--dsw-alias-bg-layer-1)',
      color: 'var(--dsw-alias-label-primary)',
      fontSize: 13,
      fontFamily: 'inherit',
      outline: 'none',
    }
    const row = { display: 'flex', flexDirection: 'column', marginBottom: 18 }
    const hint = { fontSize: 12, color: 'var(--dsw-alias-label-secondary)', marginTop: 6, lineHeight: 1.5 }
    const sectionTitle = {
      fontSize: 13,
      fontWeight: 600,
      color: 'var(--dsw-alias-label-primary)',
      margin: '0 0 6px',
    }

    function Field(props) {
      return h(
        'div',
        { style: row },
        h('span', { style: label }, props.title),
        props.children,
        props.hint ? h('span', { style: hint }, props.hint) : null,
      )
    }

    function Switch(props) {
      return h(
        'button',
        {
          type: 'button',
          role: 'switch',
          'aria-checked': props.checked ? 'true' : 'false',
          onClick: () => props.onChange(!props.checked),
          style: {
            alignSelf: 'flex-start',
            display: 'inline-flex',
            alignItems: 'center',
            gap: 8,
            padding: '5px 12px 5px 8px',
            borderRadius: 999,
            border: '1px solid var(--dsw-alias-border-l1)',
            background: props.checked ? 'var(--dsw-alias-brand-primary)' : 'var(--dsw-alias-bg-layer-2)',
            color: props.checked ? '#fff' : 'var(--dsw-alias-label-primary)',
            fontSize: 12,
            cursor: 'pointer',
          },
        },
        h('span', {
          style: {
            display: 'inline-block',
            width: 10,
            height: 10,
            borderRadius: 999,
            background: props.checked ? '#fff' : 'var(--dsw-alias-state-idle-primary)',
          },
        }),
        props.checked ? '开着' : '关着',
      )
    }

    function Page() {
      const [cfg, setCfg] = React.useState(null)
      const [store, setStore] = React.useState('')
      const [meta, setMeta] = React.useState(null)
      const [configPath, setConfigPath] = React.useState('')
      const [storesText, setStoresText] = React.useState('')
      const [error, setError] = React.useState('')
      const [saved, setSaved] = React.useState('')
      const [busy, setBusy] = React.useState(false)

      const storesToText = (list) =>
        (Array.isArray(list) ? list : [])
          .map((s) => {
            const words = Array.isArray(s.words) ? s.words : s.name ? [s.name] : []
            return `${words.map((w) => '#' + w).join(';')} = ${s.dir || ''}`
          })
          .join('\n')

      React.useEffect(() => {
        let alive = true
        fetch('/dafeiyu/config', { headers: { accept: 'application/json' } })
          .then(async (r) => {
            const text = await r.text()
            if (!text) throw new Error(`接口没回话（HTTP ${r.status}）`)
            let d
            try {
              d = JSON.parse(text)
            } catch {
              throw new Error(`接口回的不是 JSON（HTTP ${r.status}）`)
            }
            if (!d || !d.ok) throw new Error((d && d.error) || '读不到配置')
            return d
          })
          .then((d) => {
            if (!alive) return
            setCfg(d.config)
            setStore(d.store)
            setMeta(d.meta)
            setConfigPath(d.configPath || '')
            setStoresText(storesToText(d.config?.stores))
          })
          .catch((e) => alive && setError(String((e && e.message) || e)))
        return () => {
          alive = false
        }
      }, [])

      const patch = (k) => (v) => setCfg((c) => ({ ...c, [k]: v }))
      const num = (k) => (e) => setCfg((c) => ({ ...c, [k]: Number(e.target.value) }))

      const save = async () => {
        setBusy(true)
        setError('')
        setSaved('')
        try {
          const stores = storesText
            .split('\n')
            .map((line) => line.trim())
            .filter(Boolean)
            .map((line) => {
              const i = line.indexOf('=')
              if (i < 0) return null
              const words = line
                .slice(0, i)
                .split(/[;；]/)
                .map((w) => w.trim().replace(/^#/, ''))
                .filter(Boolean)
              const dir = line.slice(i + 1).trim()
              return words.length && dir ? { words, dir } : null
            })
            .filter(Boolean)
          const body = {
            storeDir: cfg.storeDir,
            cliPath: cfg.cliPath,
            keyword: cfg.keyword,
            prompt: !!cfg.prompt,
            hook: !!cfg.hook,
            gapHours: Number(cfg.gapHours),
            idleReview: !!cfg.idleReview,
            idleMinutes: Number(cfg.idleMinutes),
            reviewGapHours: Number(cfg.reviewGapHours),
            stores,
          }
          const r = await fetch('/dafeiyu/config', {
            method: 'POST',
            headers: { 'content-type': 'application/json' },
            body: JSON.stringify(body),
          })
          const text = await r.text()
          if (!text) throw new Error(`接口没回话（HTTP ${r.status}）`)
          let d
          try {
            d = JSON.parse(text)
          } catch {
            throw new Error(`接口回的不是 JSON（HTTP ${r.status}）`)
          }
          if (!d || !d.ok) throw new Error((d && d.error) || '保存失败')
          setCfg(d.config)
          setStore(d.store)
          setConfigPath(d.configPath || '')
          setStoresText(storesToText(d.config?.stores))
          setSaved('存好了')
        } catch (e) {
          setError(String((e && e.message) || e))
        } finally {
          setBusy(false)
        }
      }

      if (!cfg) {
        return h(
          'div',
          { style: { padding: 24, fontSize: 13, color: 'var(--dsw-alias-label-secondary)' } },
          error ? `连不上记忆插件：${error}` : '正在读……',
        )
      }

      return h(
        'div',
        { style: { padding: '24px 28px', maxWidth: 640, fontSize: 13, color: 'var(--dsw-alias-label-primary)' } },
        h('h2', { style: { fontSize: 16, margin: '0 0 4px' } }, '大肥鱼的记忆'),
        h(
          'p',
          { style: { ...hint, marginTop: 0, marginBottom: 22 } },
          meta
            ? `库里 ${meta.name || '（还没名字）'} · ${meta.id}`
            : '这个位置没找到库——改一下路径，或者把存着记忆库的设备接上。',
        ),

        h(
          Field,
          { title: '记忆库', hint: '每行一个：呼唤词 = 目录。第一行是默认库；一个库可以有多个呼唤词，用分号隔开，比如 #大肥鱼;#大肥鱼2 = D:\\memory\\大肥鱼2。对话里说「切到 大肥鱼2」，那个会话才换过去，别的窗口不受影响。' },
          h('textarea', {
            style: { ...input, minHeight: 110, resize: 'vertical', fontFamily: 'inherit' },
            value: storesText,
            onChange: (e) => setStoresText(e.target.value),
          }),
        ),

        h('div', { style: row }, h('span', { style: sectionTitle }, '自己待着的时候'), h('div', { style: hint })),

        h(
          Field,
          { title: '空闲回顾' },
          h(Switch, { checked: !!cfg.idleReview, onChange: (v) => patch('idleReview')(v) }),
        ),

        h(
          Field,
          { title: '没人说话多久之后开始整理（分钟）' },
          h('input', {
            style: input,
            type: 'number',
            min: 5,
            value: cfg.idleMinutes,
            onChange: num('idleMinutes'),
          }),
        ),

        h(
          Field,
          { title: '两次整理至少隔多久（小时）' },
          h('input', {
            style: input,
            type: 'number',
            min: 1,
            value: cfg.reviewGapHours,
            onChange: num('reviewGapHours'),
          }),
        ),

        h('div', { style: row }, h('span', { style: sectionTitle }, '什么时候算「隔了很久」'), h('div', { style: hint })),

        h(
          Field,
          { title: '隔多少小时（小时）', hint: '超过这个时间再开口，我先校一遍权重、把碎片并起来。' },
          h('input', { style: input, type: 'number', min: 1, value: cfg.gapHours, onChange: num('gapHours') }),
        ),

        h(
          Field,
          { title: '自动把记忆带进来' , hint: '关掉的话，说到关键词也不会自动想起来。' },
          h(Switch, { checked: !!cfg.hook, onChange: (v) => patch('hook')(v) }),
        ),

        h(
          'div',
          { style: { display: 'flex', alignItems: 'center', gap: 12, marginTop: 6 } },
          h(
            'button',
            {
              type: 'button',
              onClick: save,
              disabled: busy,
              style: {
                padding: '7px 16px',
                borderRadius: 8,
                border: 'none',
                background: 'var(--dsw-alias-brand-primary)',
                color: '#fff',
                fontSize: 13,
                cursor: busy ? 'default' : 'pointer',
                opacity: busy ? 0.6 : 1,
              },
            },
            busy ? '存着……' : '存好',
          ),
          saved ? h('span', { style: { fontSize: 12, color: 'var(--dsw-alias-state-success-primary)' } }, saved) : null,
          error ? h('span', { style: { fontSize: 12, color: 'var(--dsw-alias-state-error-primary)' } }, error) : null,
        ),

        h(
          'p',
          { style: { ...hint, marginTop: 22 } },
          `现在读的是 ${store}。${configPath ? `设置存在 ${configPath}，不跟插件包一起更新。` : ''}`,
        ),
      )
    }

    return {
      inject: ['slots'],
      apply(ctx) {
        ctx.slots.inject('settings.section', () =>
          ctx.slots.register(
            {
              name: 'settings.section',
              id: 'dafeiyu',
              order: 25,
              label: () => '记忆',
            },
            Page,
          ),
        )
      },
    }
  },
})
