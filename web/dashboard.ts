/**
 * Trace / Eval 看板（TypeScript，无框架、无运行时依赖）
 *
 * 为什么不用 React/Vue：这个项目的定位是「自研薄层」，看板只需要读三个只读接口、
 * 画几张 SVG；引入框架反而会在「TS 全栈」这句话里掺进一个和 runtime 无关的技术栈。
 * 编译：npx tsc -p tsconfig.web.json → public/dashboard.js（浏览器直接跑的普通脚本）
 *
 * 数据来源：
 *   /v1/eval             → reports/eval-summary.json（离线 A/B 实验结论）
 *   /v1/traces           → TRACE_DIR 下的 JSONL 运行列表
 *   /v1/traces/<runId>   → 某次 run 的逐轮 Trace
 * 页面本身不含任何数据；服务若设了 AUTH_TOKEN，需在右上角填一次（存 sessionStorage）。
 */

;(function (): void {
  'use strict'

  // ── 类型 ────────────────────────────────────────────────────

  interface Strategy {
    key: string
    label: string
    tasks: number
    success: number
    lossRate: number
    costUSD: number
    inputTokens: number
    compactions: number
    recoveryCalls: number
    turns: number
  }
  interface SweepPoint {
    minResultChars?: number
    costReductionPct: number
    recoveryCalls?: number
    success?: number
  }
  interface EvalSuite {
    key: string
    name: string
    taskCount: number
    strategies: Strategy[]
    sweep: SweepPoint[]
    headline: Record<string, number>
  }
  interface EvalSummary {
    available?: boolean
    suites?: EvalSuite[]
    highlights?: string[]
    boundary?: string[]
  }
  interface TraceRun {
    runId: string
    turns: number
    costUSD: number
    compactions: number
    lastTs: string
  }
  interface TracesResp {
    traceDir: string | null
    runs: TraceRun[]
    summary: Record<string, number>
  }
  interface TurnPoint {
    turn: number
    contextTokens: number
    costUSD: number
    compactionSavedTokens: number
    compactionEvents: Array<{ applied: boolean; turn: number }>
    tools: string[]
  }
  interface RunDetail {
    runId: string
    turns: TurnPoint[]
    summary: Record<string, number>
  }
  interface Series {
    name: string
    color: string
    values: number[]
  }

  const state: {
    token: string
    evalData: EvalSummary | null
    traces: TracesResp | null
    detail: RunDetail | null
    selectedRun: string | null
  } = {
    token: sessionStorage.getItem('agent-runtime-token') ?? '',
    evalData: null,
    traces: null,
    detail: null,
    selectedRun: null,
  }

  const NS = 'http://www.w3.org/2000/svg'
  const W = 600
  const H = 230
  const PAD = { l: 58, r: 16, t: 16, b: 38 }

  // ── DOM 小工具 ─────────────────────────────────────────────

  function must<T extends Element>(id: string): T {
    const node = document.getElementById(id)
    if (!node) throw new Error(`缺少 DOM 节点 #${id}`)
    return node as unknown as T
  }

  function setNotice(msg: string, isError: boolean): void {
    const n = must<HTMLElement>('notice')
    n.textContent = msg
    n.className = isError ? 'notice error' : 'notice'
  }

  async function api<T>(path: string): Promise<T> {
    const headers: Record<string, string> = {}
    if (state.token) headers.Authorization = `Bearer ${state.token}`
    const res = await fetch(path, { headers })
    if (res.status === 401) throw new Error('鉴权失败：服务设置了 AUTH_TOKEN，请在右上角填写')
    if (!res.ok) throw new Error(`${path} → HTTP ${res.status}`)
    return (await res.json()) as T
  }

  function svgNode(tag: string, attrs: Record<string, string | number>): SVGElement {
    const n = document.createElementNS(NS, tag)
    for (const [k, v] of Object.entries(attrs)) n.setAttribute(k, String(v))
    return n
  }

  function clear(svg: SVGSVGElement): void {
    while (svg.firstChild) svg.removeChild(svg.firstChild)
  }

  function label(
    svg: SVGSVGElement,
    x: number,
    y: number,
    content: string,
    fill: string,
    size: number,
    anchor: 'start' | 'middle' | 'end' = 'start',
  ): void {
    const t = svgNode('text', { x, y, fill, 'font-size': size, 'text-anchor': anchor })
    t.textContent = content
    svg.appendChild(t)
  }

  function niceMax(v: number): number {
    if (v <= 0) return 1
    const pow = Math.pow(10, Math.floor(Math.log10(v)))
    return Math.ceil(v / pow) * pow
  }

  function compact(n: number): string {
    if (Math.abs(n) >= 1000) return `${(n / 1000).toFixed(1)}k`
    return n.toFixed(0)
  }

  /** 通用折线图：主 Y 轴带数值刻度，可叠加竖线标记 */
  function drawLines(
    svg: SVGSVGElement,
    opts: { labels: string[]; series: Series[]; markers?: number[]; yFmt?: (n: number) => string },
  ): void {
    clear(svg)
    const all = opts.series.flatMap((s) => s.values)
    const rawMin = Math.min(0, ...all)
    const rawMax = niceMax(Math.max(1, ...all))
    const lo = Math.min(0, rawMin)
    const hi = rawMax
    const span = hi - lo || 1
    const n = Math.max(1, opts.labels.length)
    const xAt = (i: number): number =>
      PAD.l + (n === 1 ? (W - PAD.l - PAD.r) / 2 : (i * (W - PAD.l - PAD.r)) / (n - 1))
    const yAt = (v: number): number => H - PAD.b - ((v - lo) / span) * (H - PAD.t - PAD.b)
    const fmt = opts.yFmt ?? compact

    for (let g = 0; g <= 4; g += 1) {
      const v = lo + (span * g) / 4
      const y = yAt(v)
      svg.appendChild(
        svgNode('line', { x1: PAD.l, y1: y, x2: W - PAD.r, y2: y, stroke: '#e8edf4', 'stroke-width': 1 }),
      )
      label(svg, PAD.l - 8, y + 4, fmt(v), '#8a97ab', 10, 'end')
    }
    svg.appendChild(
      svgNode('line', {
        x1: PAD.l, y1: H - PAD.b, x2: W - PAD.r, y2: H - PAD.b, stroke: '#cbd5e1', 'stroke-width': 1,
      }),
    )

    const step = Math.max(1, Math.ceil(n / 8))
    opts.labels.forEach((l, i) => {
      if (i % step !== 0 && i !== n - 1) return
      label(svg, xAt(i), H - PAD.b + 16, l, '#8a97ab', 10, 'middle')
    })

    for (const i of opts.markers ?? []) {
      if (i < 0 || i >= n) continue
      const x = xAt(i)
      svg.appendChild(
        svgNode('line', {
          x1: x, y1: PAD.t, x2: x, y2: H - PAD.b,
          stroke: '#7c3aed', 'stroke-width': 1.5, 'stroke-dasharray': '4 4', opacity: 0.75,
        }),
      )
      label(svg, x, PAD.t + 2, '压缩', '#7c3aed', 9, 'middle')
    }

    for (const s of opts.series) {
      if (s.values.length === 0) continue
      const pts = s.values.map((v, i) => `${xAt(i)},${yAt(v)}`).join(' ')
      svg.appendChild(
        svgNode('polyline', {
          points: pts, fill: 'none', stroke: s.color, 'stroke-width': 2.2,
          'stroke-linejoin': 'round', 'stroke-linecap': 'round',
        }),
      )
      s.values.forEach((v, i) => {
        svg.appendChild(svgNode('circle', { cx: xAt(i), cy: yAt(v), r: 3, fill: s.color }))
      })
    }
  }

  /** 柱状图：柱顶标数值、柱底标短标签 */
  function drawBars(
    svg: SVGSVGElement,
    bars: Array<{ label: string; value: number; note?: string; color: string }>,
    valueFmt: (n: number) => string,
  ): void {
    clear(svg)
    const hi = niceMax(Math.max(0.0001, ...bars.map((b) => b.value)))
    const n = bars.length
    const slot = (W - PAD.l - PAD.r) / Math.max(1, n)
    const bw = Math.min(58, slot * 0.62)

    for (let g = 0; g <= 4; g += 1) {
      const v = (hi * g) / 4
      const y = H - PAD.b - (v / hi) * (H - PAD.t - PAD.b)
      svg.appendChild(
        svgNode('line', { x1: PAD.l, y1: y, x2: W - PAD.r, y2: y, stroke: '#e8edf4', 'stroke-width': 1 }),
      )
      label(svg, PAD.l - 8, y + 4, valueFmt(v), '#8a97ab', 10, 'end')
    }
    // 零线（扫描图里的正负分界）
    svg.appendChild(
      svgNode('line', {
        x1: PAD.l, y1: H - PAD.b, x2: W - PAD.r, y2: H - PAD.b, stroke: '#cbd5e1', 'stroke-width': 1,
      }),
    )

    bars.forEach((b, i) => {
      const cx = PAD.l + slot * i + slot / 2
      const h = Math.abs(b.value / hi) * (H - PAD.t - PAD.b)
      const y = H - PAD.b - h
      svg.appendChild(
        svgNode('rect', { x: cx - bw / 2, y, width: bw, height: Math.max(1, h), rx: 3, fill: b.color, opacity: 0.88 }),
      )
      label(svg, cx, y - 6, valueFmt(b.value), '#334155', 10.5, 'middle')
      label(svg, cx, H - PAD.b + 15, b.label, '#66748a', 10, 'middle')
      if (b.note) label(svg, cx, H - PAD.b + 28, b.note, '#94a3b8', 9, 'middle')
    })
  }

  // ── 渲染 ────────────────────────────────────────────────────

  function renderKpis(): void {
    const box = must<HTMLElement>('kpis')
    box.innerHTML = ''
    const suites = state.evalData?.suites ?? []
    const compaction = suites.find((s) => s.key === 'compaction')
    const scenario = suites.find((s) => s.key === 'scenario')
    const tr = state.traces?.summary ?? {}

    const items: Array<{ label: string; value: string; hint: string }> = [
      {
        label: '压缩实验 · 成本降幅',
        value: compaction ? `${Number(compaction.headline.costReductionPct).toFixed(1)}%` : '—',
        hint: compaction ? `${compaction.taskCount} 个埋值-引用任务` : '未跑 npm run eval:all',
      },
      {
        label: '场景实验 · 成本降幅',
        value: scenario ? `${Number(scenario.headline.costReductionPct).toFixed(1)}%` : '—',
        hint: scenario ? `成功率 ${scenario.headline.recommendedSuccess}/${scenario.taskCount}` : '未跑评测',
      },
      {
        label: '参数照搬 · 反例',
        value: scenario ? `${Number(scenario.headline.aggressiveCostReductionPct).toFixed(1)}%` : '—',
        hint: '负数 = 因额外重读倒赔',
      },
      {
        label: 'Trace 累计轮数',
        value: String(tr.turns ?? 0),
        hint: `成本 $${Number(tr.costUSD ?? 0).toFixed(4)}`,
      },
      {
        label: '不可恢复对照组',
        value: scenario ? `${scenario.headline.irreversibleSuccess}/${scenario.taskCount}` : '—',
        hint: '证据丢失导致任务失败',
      },
    ]
    for (const it of items) {
      const d = document.createElement('div')
      d.className = 'kpi'
      d.innerHTML =
        `<div class="label"></div><div class="value"></div><div class="hint"></div>`
      const parts = d.querySelectorAll<HTMLElement>('div')
      parts[0]!.textContent = it.label
      parts[1]!.textContent = it.value
      parts[2]!.textContent = it.hint
      box.appendChild(d)
    }
  }

  function renderAB(): void {
    const svg = must<SVGSVGElement>('chartAB')
    const table = must<HTMLElement>('abTable')
    const scenario = state.evalData?.suites?.find((s) => s.key === 'scenario')
    const strategies = scenario?.strategies ?? []
    if (strategies.length === 0) {
      clear(svg)
      table.innerHTML = '<div class="empty">暂无评测数据，运行 <code>npm run eval:all</code></div>'
      return
    }
    const colors: Record<string, string> = {
      A: '#94a3b8', B: '#dc2626', C: '#d97706', D: '#0f9d6e',
    }
    drawBars(
      svg,
      strategies.map((s) => ({
        label: s.key,
        value: s.costUSD,
        note: `${s.success}/${s.tasks} 成功`,
        color: colors[s.key] ?? '#2563eb',
      })),
      (v) => `$${v.toFixed(3)}`,
    )
    const rows = strategies
      .map(
        (s) =>
          `<tr><td>${s.label}</td><td>${s.success}/${s.tasks}</td>` +
          `<td>${(s.lossRate * 100).toFixed(1)}%</td><td>${s.inputTokens.toLocaleString()}</td>` +
          `<td>$${s.costUSD.toFixed(4)}</td><td>${s.compactions}</td><td>${s.recoveryCalls}</td></tr>`,
      )
      .join('')
    table.innerHTML =
      `<table style="margin-top:12px"><thead><tr><th>策略</th><th>成功</th><th>丢失率</th>` +
      `<th>input tok</th><th>成本</th><th>压缩</th><th>重读</th></tr></thead><tbody>${rows}</tbody></table>`
  }

  function renderSweep(): void {
    const svg = must<SVGSVGElement>('chartSweep')
    const scenario = state.evalData?.suites?.find((s) => s.key === 'scenario')
    const points = (scenario?.sweep ?? []).filter((p) => typeof p.minResultChars === 'number')
    if (points.length === 0) {
      clear(svg)
      label(svg, W / 2, H / 2, '暂无扫描数据', '#94a3b8', 12, 'middle')
      return
    }
    const labels = points.map((p) => compact(p.minResultChars!))
    const vals = points.map((p) => p.costReductionPct)
    // 用柱状而非折线：这里横轴是离散参数档位，正负都可能出现
    drawBars(
      svg,
      points.map((p, i) => ({
        label: labels[i]!,
        value: p.costReductionPct,
        note: `重读 ${p.recoveryCalls ?? 0}`,
        color: p.costReductionPct > 0 ? '#0f9d6e' : p.costReductionPct < 0 ? '#dc2626' : '#94a3b8',
      })),
      (v) => `${v.toFixed(1)}%`,
    )
    // 负值时柱体要向下画：drawBars 用绝对值，这里补一条说明避免误读
    label(svg, PAD.l + 4, PAD.t + 10, '绿=省钱 · 红=倒赔 · 灰=退化成基线', '#66748a', 10)
    void vals
  }

  function renderRuns(): void {
    const list = must<HTMLElement>('runList')
    list.innerHTML = ''
    const runs = state.traces?.runs ?? []
    if (runs.length === 0) {
      const li = document.createElement('li')
      li.innerHTML = '<span class="empty">暂无运行记录。设置 <code>TRACE_DIR</code> 并跑一次 /v1/sessions/:id/runs</span>'
      list.appendChild(li)
      return
    }
    for (const r of runs) {
      const li = document.createElement('li')
      li.className = r.runId === state.selectedRun ? 'active' : ''
      const id = document.createElement('span')
      id.className = 'id'
      id.textContent = r.runId
      const meta = document.createElement('span')
      meta.className = 'meta'
      meta.textContent = `${r.turns} 轮 · $${r.costUSD.toFixed(4)} · 压缩 ${r.compactions}`
      li.append(id, meta)
      li.addEventListener('click', () => void selectRun(r.runId))
      list.appendChild(li)
    }
  }

  async function selectRun(runId: string): Promise<void> {
    state.selectedRun = runId
    renderRuns()
    try {
      state.detail = await api<RunDetail>(`/v1/traces/${encodeURIComponent(runId)}`)
      renderTurns()
    } catch (err) {
      setNotice(String(err instanceof Error ? err.message : err), true)
    }
  }

  function renderTurns(): void {
    const svg = must<SVGSVGElement>('chartTurns')
    const legend = must<HTMLElement>('turnsLegend')
    const d = state.detail
    const turns = d?.turns ?? []
    if (turns.length === 0) {
      clear(svg)
      legend.innerHTML = ''
      label(svg, W / 2, H / 2, '选择一次 run 查看逐轮 Trace', '#94a3b8', 12, 'middle')
      return
    }
    const markers: number[] = []
    turns.forEach((t, i) => {
      if (t.compactionEvents.some((e) => e.applied)) markers.push(i)
    })
    drawLines(svg, {
      labels: turns.map((t) => `T${t.turn}`),
      series: [
        { name: 'contextTokens', color: '#2563eb', values: turns.map((t) => t.contextTokens) },
      ],
      markers,
      yFmt: compact,
    })

    // 第二张图：每轮成本柱状（单独刻度，避免双轴误导）
    const old = document.getElementById('chartCost')
    if (old) old.remove()
    const costSvg = document.createElementNS(NS, 'svg') as SVGSVGElement
    costSvg.id = 'chartCost'
    costSvg.setAttribute('viewBox', `0 0 ${W} ${H}`)
    costSvg.setAttribute('role', 'img')
    costSvg.setAttribute('aria-label', '每轮成本')
    svg.insertAdjacentElement('afterend', costSvg)
    drawBars(
      costSvg,
      turns.map((t) => ({ label: `T${t.turn}`, value: t.costUSD, color: '#7c3aed' })),
      (v) => `$${v.toFixed(4)}`,
    )

    const toolSeq = turns.flatMap((t) => t.tools).join(' → ')
    legend.innerHTML =
      `<span><i style="background:#2563eb"></i>contextTokens（上）</span>` +
      `<span><i style="background:#7c3aed"></i>每轮成本 USD（下）</span>` +
      `<span><i style="background:#7c3aed;opacity:.5"></i>虚线 = 该轮触发压缩</span>` +
      `<span>共 ${turns.length} 轮 · 压缩 ${markers.length} 次</span>` +
      (toolSeq ? `<span>工具：${toolSeq}</span>` : '')
  }

  function renderFooter(): void {
    const f = must<HTMLElement>('footer')
    const boundary = state.evalData?.boundary ?? []
    const lines = boundary.map((b) => `· ${b}`).join('<br>')
    f.innerHTML =
      `<strong>数据口径</strong><br>${lines || '· 评测数据尚未生成'}<br>` +
      `· 页面只读 <code>/v1/eval</code> / <code>/v1/traces</code> / <code>/v1/traces/:runId</code>；` +
      `Trace 来自 <code>TRACE_DIR</code> 下的 JSONL，进程重启后仍可回放。`
  }

  async function loadAll(): Promise<void> {
    setNotice('正在加载评测与 Trace 数据…', false)
    try {
      const [ev, traces] = await Promise.all([
        api<EvalSummary>('/v1/eval'),
        api<TracesResp>('/v1/traces'),
      ])
      state.evalData = ev.available === false ? null : ev
      state.traces = traces
      renderKpis()
      renderAB()
      renderSweep()
      renderRuns()
      renderFooter()
      renderTurns()
      const noEval = !state.evalData?.suites?.length
      const noRun = (state.traces?.runs?.length ?? 0) === 0
      if (noEval || noRun) {
        setNotice(
          `已连接。${noEval ? '评测数据未生成 → 运行 npm run eval:all。' : ''}` +
            `${noRun ? '暂无 Trace → 设置 TRACE_DIR 并发起一次 run。' : ''}`,
          false,
        )
        if (noRun && !state.selectedRun) {
          // 无真实 run 时用评测数据画一张示例折线，保证看板不是空白
          // 但不伪造 Trace：明确标注数据来源为离线评测
          const svg = must<SVGSVGElement>('chartTurns')
          const scenario = state.evalData?.suites?.find((s) => s.key === 'scenario')
          if (scenario && scenario.sweep.length > 0) {
            drawLines(svg, {
              labels: scenario.sweep.map((p) => String(p.minResultChars ?? '')),
              series: [
                {
                  name: '成本降幅 %',
                  color: '#0f9d6e',
                  values: scenario.sweep.map((p) => p.costReductionPct),
                },
              ],
              yFmt: (v) => `${v.toFixed(0)}%`,
            })
          }
        }
      } else {
        setNotice(
          `已连接：${state.evalData?.suites?.length ?? 0} 个评测套件 · ` +
            `${state.traces?.runs?.length ?? 0} 次 run。全部数据来自本地文件，无 API key。`,
          false,
        )
        if (state.traces && state.traces.runs.length > 0 && !state.selectedRun) {
          await selectRun(state.traces.runs[0]!.runId)
        }
      }
    } catch (err) {
      setNotice(`加载失败：${err instanceof Error ? err.message : String(err)}`, true)
    }
  }

  // ── 事件绑定 ───────────────────────────────────────────────

  const tokenInput = must<HTMLInputElement>('token')
  tokenInput.value = state.token
  must<HTMLElement>('saveToken').addEventListener('click', () => {
    state.token = tokenInput.value.trim()
    if (state.token) sessionStorage.setItem('agent-runtime-token', state.token)
    else sessionStorage.removeItem('agent-runtime-token')
    void loadAll()
  })
  must<HTMLElement>('refresh').addEventListener('click', () => void loadAll())
  tokenInput.addEventListener('keydown', (e: KeyboardEvent) => {
    if (e.key === 'Enter') must<HTMLElement>('saveToken').click()
  })

  void loadAll()
})()
