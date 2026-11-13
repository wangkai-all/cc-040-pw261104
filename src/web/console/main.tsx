// 采集操作台：建批次、运行/补采、查看每张订单的采集结果、异常与截图、下载导出。
import React, { useEffect, useMemo, useState } from 'react'
import { createRoot } from 'react-dom/client'

const CSS = `
:root{--line:#e3e8ee;--muted:#667085;--ink:#101828;--accent:#155eef;--soft:#f6f8fb;--ok:#067647;--warn:#b54708;--bad:#b42318}
*{box-sizing:border-box}
body{margin:0;font:14px/1.5 "DejaVu Sans","WenQuanYi Zen Hei",system-ui,sans-serif;color:var(--ink);background:#f9fafb}
header.bar{display:flex;align-items:center;justify-content:space-between;padding:14px 26px;background:#fff;border-bottom:1px solid var(--line)}
header.bar h1{font-size:17px;margin:0}
header.bar .links a{color:var(--accent);text-decoration:none;margin-left:16px}
main{max-width:1240px;margin:0 auto;padding:22px}
.grid2{display:grid;grid-template-columns:400px 1fr;gap:18px;align-items:start}
.card{border:1px solid var(--line);border-radius:10px;background:#fff}
.card h2{font-size:15px;margin:0;padding:14px 16px;border-bottom:1px solid var(--line)}
.card .body{padding:16px}
label{display:block;font-size:13px;color:#344054;margin:10px 0 5px}
input[type=text],input[type=date]{width:100%;padding:8px 10px;border:1px solid #cfd6e0;border-radius:8px;font:inherit}
button{padding:7px 14px;border-radius:8px;border:1px solid #cfd6e0;background:#fff;font:inherit;cursor:pointer}
button.primary{background:var(--accent);border-color:var(--accent);color:#fff}
button.ghost{color:var(--accent);border-color:#c7d7fe;background:#f5f8ff}
button:disabled{opacity:.55;cursor:not-allowed}
.row{display:flex;gap:10px;flex-wrap:wrap;align-items:center}
.meta{color:var(--muted);font-size:13px}
.list{max-height:260px;overflow:auto;border:1px solid var(--line);border-radius:8px}
.batch{padding:10px 12px;border-bottom:1px solid var(--line);cursor:pointer}
.batch:hover{background:var(--soft)}
.batch.active{background:#eff4ff}
.batch b{display:block;font-size:13px}
.batch span{font-size:12px;color:var(--muted)}
.badge{display:inline-block;padding:2px 8px;border-radius:999px;font-size:12px;background:#eef2f6;color:#344054}
.badge.ok{background:#e8f5ee;color:var(--ok)}
.badge.warn{background:#fff4e8;color:var(--warn)}
.badge.bad{background:#fee4e2;color:var(--bad)}
.badge.blue{background:#eff4ff;color:var(--accent)}
.stat{display:grid;grid-template-columns:repeat(auto-fit,minmax(120px,1fr));gap:10px;padding:14px 16px;border-bottom:1px solid var(--line)}
.stat div{background:var(--soft);border-radius:8px;padding:10px 12px}
.stat b{display:block;font-size:20px;font-variant-numeric:tabular-nums}
.stat span{font-size:12px;color:var(--muted)}
table{width:100%;border-collapse:collapse}
th,td{padding:9px 12px;border-bottom:1px solid var(--line);text-align:left;vertical-align:top}
th{background:var(--soft);font-size:12px;color:var(--muted);text-transform:uppercase;letter-spacing:.4px}
td.num{text-align:right;font-variant-numeric:tabular-nums}
tr:last-child td{border-bottom:0}
.err{color:var(--bad);font-size:12px}
.tabs{display:flex;gap:4px;padding:10px 16px;border-bottom:1px solid var(--line)}
.tabs button{border:0;background:none;padding:6px 12px;color:var(--muted)}
.tabs button.on{background:#eff4ff;color:var(--accent);border-radius:7px}
.notice{padding:10px 14px;border-radius:8px;border:1px solid #c7d7fe;background:#eff4ff;color:#175cd3;margin-bottom:14px;font-size:13px}
.warnbox{padding:10px 14px;border-radius:8px;border:1px solid #fedf89;background:#fffaeb;color:#b54708;margin-bottom:14px;font-size:13px}
.shot{width:100%;max-height:420px;object-fit:contain;border:1px solid var(--line);border-radius:8px;background:#fff}
.empty{padding:28px;text-align:center;color:var(--muted)}
details summary{cursor:pointer;color:var(--accent);font-size:13px}
pre{background:var(--soft);border-radius:8px;padding:10px;overflow:auto;font-size:12px;max-height:220px}
.spin{font-size:12px;color:var(--accent)}
`

interface BatchSummary {
  id: string
  name: string
  filterFrom: string
  filterTo: string
  expectedCount: number
  dataVersion: string
  status: string
  orders: number
  verified: number
  failed: number
  pending: number
  exceptions: number
  screenshots: number
  progress: { phase?: string; scrollTop?: number; currentOrderNo?: string | null; savedAt?: string } | null
  lastRun: { id: number; status: string; reason: string | null; startedAt: string; finishedAt: string | null } | null
}

interface OrderItem {
  id: number
  orderNo: string
  placedAt: string
  buyer: string
  status: string
  totalText: string
  itemCountText: string
  phase: string
  attemptCount: number
  lastError: string | null
  screenshotPath: string | null
  issues: { code: string; severity: string; message: string }[]
  lines: { lineNo: number; sku: string; name: string; unitPrice: string; quantity: string; amount: string; ok: boolean }[]
}

interface ExceptionItem {
  id: number
  orderNo: string | null
  code: string
  severity: string
  message: string
  createdAt: string
  screenshotPath: string | null
}

interface BatchDetail {
  batch: BatchSummary
  orders: OrderItem[]
  exceptions: ExceptionItem[]
  runs: { id: number; status: string; reason: string | null; startedAt: string; finishedAt: string | null; collectedCount: number; detailCount: number }[]
}

interface SiteMeta {
  dataVersion: string
  snapshotAt: string
  count: number
  allCount: number
  dateRange: { min: string; max: string }
  flags: { detailDelayMs: number; sessionExpiryMs: number; autoLogout: boolean }
  accounts: { username: string; password: string; displayName: string }[]
}

function statusBadge(s: string) {
  const map: Record<string, string> = {
    completed: 'ok',
    verified: 'ok',
    running: 'blue',
    listing: 'blue',
    detail: 'blue',
    paused: 'warn',
    incomplete: 'warn',
    pending: 'warn',
    failed: 'bad',
    error: 'bad',
    draft: '',
  }
  return `badge ${map[s] ?? ''}`
}

const statusText: Record<string, string> = {
  draft: '未开始',
  listing: '采集中',
  detail: '采集中',
  running: '运行中',
  completed: '已完成',
  verified: '已核对',
  failed: '核对失败',
  pending: '待采集',
  paused: '已暂停',
  incomplete: '未完成',
  error: '出错',
}

function App() {
  const [meta, setMeta] = useState<SiteMeta | null>(null)
  const [batches, setBatches] = useState<BatchSummary[]>([])
  const [selected, setSelected] = useState<string | null>(null)
  const [detail, setDetail] = useState<BatchDetail | null>(null)
  const [from, setFrom] = useState('')
  const [to, setTo] = useState('')
  const [busy, setBusy] = useState('')
  const [msg, setMsg] = useState('')
  const [err, setErr] = useState('')
  const [tab, setTab] = useState<'orders' | 'exceptions' | 'runs'>('orders')
  const [phaseFilter, setPhaseFilter] = useState('all')
  const [viewer, setViewer] = useState<{ orderNo: string; path: string } | null>(null)
  const [expanded, setExpanded] = useState<number | null>(null)

  const loadMeta = async () => {
    const r = await fetch('/console/api/meta')
    const j = (await r.json()) as SiteMeta & { error?: string }
    if (j.error) throw new Error(j.error)
    setMeta(j)
  }
  const loadBatches = async () => {
    const r = await fetch('/console/api/batches')
    const j = (await r.json()) as { batches: BatchSummary[] }
    setBatches(j.batches)
    if (!selected && j.batches[0]) setSelected(j.batches[0].id)
  }
  const loadDetail = async (id: string) => {
    const r = await fetch(`/console/api/batches/${encodeURIComponent(id)}`)
    if (r.status === 404) return setDetail(null)
    const j = (await r.json()) as BatchDetail
    setDetail(j)
  }

  useEffect(() => {
    loadMeta().catch((e: Error) => setErr(e.message))
    loadBatches().catch((e: Error) => setErr(e.message))
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [])

  useEffect(() => {
    if (!selected) return
    loadDetail(selected).catch((e: Error) => setErr(e.message))
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [selected])

  // 运行中自动刷新
  useEffect(() => {
    const running = detail?.batch.status === 'listing' || detail?.batch.status === 'detail' || detail?.batch.status === 'running'
    if (!running) return
    const t = setInterval(() => {
      loadDetail(selected!).catch(() => undefined)
      loadBatches().catch(() => undefined)
    }, 1200)
    return () => clearInterval(t)
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [detail?.batch.status, selected])

  const createBatch = async () => {
    setErr('')
    setMsg('')
    setBusy('create')
    try {
      const r = await fetch('/console/api/batches', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ filterFrom: from, filterTo: to }),
      })
      const j = (await r.json()) as { batch?: BatchSummary; reused?: boolean; error?: string }
      if (j.error) throw new Error(j.error)
      await loadBatches()
      setSelected(j.batch!.id)
      setMsg(j.reused ? '同一筛选范围的批次已存在，沿用原进度。' : `已创建批次，筛选范围内 ${j.batch!.expectedCount} 笔订单。`)
    } catch (e) {
      setErr((e as Error).message)
    } finally {
      setBusy('')
    }
  }

  const run = async (mode: 'run' | 'retry') => {
    if (!selected) return
    setErr('')
    setMsg('')
    setBusy(mode)
    try {
      const r = await fetch(`/console/api/batches/${encodeURIComponent(selected)}/${mode}`, { method: 'POST' })
      const j = (await r.json()) as { error?: string; outcome?: { status: string; reason: string | null } }
      if (j.error) throw new Error(j.error)
      const o = j.outcome!
      setMsg(
        o.status === 'completed'
          ? '采集完成，全部订单已核对。'
          : o.status === 'paused'
            ? `采集已暂停：${o.reason ?? ''}。重新登录后再次运行只会补未完成订单。`
            : `本次未完成：${o.reason ?? ''}`,
      )
      await loadBatches()
      await loadDetail(selected)
    } catch (e) {
      setErr((e as Error).message)
    } finally {
      setBusy('')
    }
  }

  const exportBatch = () => {
    if (!selected) return
    window.location.href = `/console/api/batches/${encodeURIComponent(selected)}/export/zip`
  }

  const orders = useMemo(() => {
    if (!detail) return []
    if (phaseFilter === 'all') return detail.orders
    return detail.orders.filter((o) => o.phase === phaseFilter)
  }, [detail, phaseFilter])

  return (
    <>
      <style>{CSS}</style>
      <header className="bar">
        <h1>订单采集操作台</h1>
        <div className="links">
          <a href="/site/orders" target="_blank" rel="noreferrer">打开演示站点</a>
          <a href="/site/console" target="_blank" rel="noreferrer">站点控制台</a>
        </div>
      </header>
      <main>
        {err ? <div className="warnbox" style={{ borderColor: '#fecdd3', background: '#fff1f2', color: '#b42318' }}>{err}</div> : null}
        {msg ? <div className="notice">{msg}</div> : null}
        <div className="grid2">
          <section className="card">
            <h2>批次</h2>
            <div className="body">
              {meta ? (
                <p className="meta">
                  站点数据版本 <b>{meta.dataVersion}</b>，共 {meta.allCount} 笔订单，日期 {meta.dateRange.min} ~ {meta.dateRange.max}。
                  <br />
                  演示登录账号 <b>{meta.accounts[0]?.username}</b> / <b>{meta.accounts[0]?.password}</b>。
                  <br />
                  站点开关：明细延迟 {meta.flags.detailDelayMs}ms，自动退出 {meta.flags.autoLogout ? `开启（${meta.flags.sessionExpiryMs}ms）` : '关闭'}。
                </p>
              ) : (
                <p className="meta">读取站点信息…</p>
              )}
              <label htmlFor="cfrom">开始日期</label>
              <input id="cfrom" type="date" value={from} onChange={(e) => setFrom(e.target.value)} />
              <label htmlFor="cto">结束日期</label>
              <input id="cto" type="date" value={to} onChange={(e) => setTo(e.target.value)} />
              <div className="row" style={{ marginTop: 12 }}>
                <button className="primary" onClick={createBatch} disabled={busy !== ''}>
                  {busy === 'create' ? '创建中…' : '创建采集批次'}
                </button>
                <button
                  className="ghost"
                  onClick={() => {
                    setFrom(meta?.dateRange.min ?? '')
                    setTo(meta?.dateRange.max ?? '')
                  }}
                >填全部日期</button>
              </div>
              <p className="meta" style={{ marginTop: 8 }}>同一日期范围重复创建会沿用已有批次与原进度。</p>

              <div className="list" style={{ marginTop: 14 }}>
                {batches.length === 0 ? <div className="empty">还没有批次</div> : null}
                {batches.map((b) => (
                  <div
                    key={b.id}
                    className={`batch ${selected === b.id ? 'active' : ''}`}
                    onClick={() => setSelected(b.id)}
                  >
                    <b>{b.filterFrom || '全部'} ~ {b.filterTo || '全部'}</b>
                    <span>
                      <span className={statusBadge(b.status)}>{statusText[b.status] ?? b.status}</span> · 已采 {b.orders}/{b.expectedCount} · 核对 {b.verified} · 异常 {b.exceptions}
                    </span>
                  </div>
                ))}
              </div>
            </div>
          </section>

          <section className="card">
            <h2>任务详情{detail ? ` · ${detail.batch.filterFrom || '全部'} ~ ${detail.batch.filterTo || '全部'}` : ''}</h2>
            {detail ? (
              <>
                <div className="stat">
                  <div><b>{detail.batch.expectedCount}</b><span>筛选总数</span></div>
                  <div><b>{detail.batch.orders}</b><span>已采集订单</span></div>
                  <div><b>{detail.batch.verified}</b><span>已核对</span></div>
                  <div><b>{detail.batch.failed}</b><span>核对失败</span></div>
                  <div><b>{detail.batch.exceptions}</b><span>异常 / 警告</span></div>
                  <div><b>{detail.batch.screenshots}</b><span>截图</span></div>
                </div>
                {detail.batch.progress ? (
                  <div style={{ padding: '10px 16px', borderBottom: '1px solid var(--line)' }} className="meta">
                    断点：{detail.batch.progress.phase ?? '-'} · 滚动位置 {detail.batch.progress.scrollTop ?? 0}px
                    {detail.batch.progress.currentOrderNo ? ` · 当前订单 ${detail.batch.progress.currentOrderNo}` : ''}
                    {detail.batch.progress.savedAt ? ` · 保存于 ${detail.batch.progress.savedAt}` : ''}
                  </div>
                ) : null}
                {detail.batch.lastRun?.reason ? <div className="warnbox" style={{ margin: 16 }}>{detail.batch.lastRun.reason}</div> : null}
                <div className="row" style={{ padding: '12px 16px', borderBottom: '1px solid var(--line)' }}>
                  <button className="primary" onClick={() => run('run')} disabled={busy !== ''}>
                    {busy === 'run' ? '采集中…' : detail.batch.status === 'paused' ? '重新登录并继续采集' : '开始 / 继续采集'}
                  </button>
                  <button className="ghost" onClick={() => run('retry')} disabled={busy !== ''}>
                    {busy === 'retry' ? '重试中…' : '重试失败订单'}
                  </button>
                  <button className="ghost" onClick={exportBatch} disabled={detail.batch.orders === 0}>下载订单 / 明细 / 异常（zip）</button>
                  <span className="meta">数据版本 {detail.batch.dataVersion}</span>
                </div>
                <div className="tabs">
                  <button className={tab === 'orders' ? 'on' : ''} onClick={() => setTab('orders')}>订单（{detail.orders.length}）</button>
                  <button className={tab === 'exceptions' ? 'on' : ''} onClick={() => setTab('exceptions')}>异常（{detail.exceptions.length}）</button>
                  <button className={tab === 'runs' ? 'on' : ''} onClick={() => setTab('runs')}>运行记录</button>
                  {tab === 'orders' ? (
                    <select
                      value={phaseFilter}
                      onChange={(e) => setPhaseFilter(e.target.value)}
                      style={{ marginLeft: 'auto', padding: '4px 8px', borderRadius: 6, border: '1px solid var(--line)' }}
                    >
                      <option value="all">全部状态</option>
                      <option value="verified">已核对</option>
                      <option value="failed">核对失败</option>
                      <option value="pending">待采集</option>
                    </select>
                  ) : null}
                </div>
                {tab === 'orders' ? (
                  orders.length === 0 ? <div className="empty">暂无订单</div> : (
                    <table>
                      <thead>
                        <tr><th>订单号</th><th>下单时间</th><th>买家</th><th>页面总额</th><th>状态</th><th>结果</th><th>异常</th><th>截图</th></tr>
                      </thead>
                      <tbody>
                        {orders.map((o) => (
                          <React.Fragment key={o.id}>
                          <tr>
                            <td>
                              <button
                                className="ghost"
                                style={{ padding: '1px 6px', fontSize: 12, marginRight: 6 }}
                                title="查看明细行"
                                onClick={() => setExpanded(expanded === o.id ? null : o.id)}
                              >{expanded === o.id ? '收起' : '明细'}</button>
                              <b>{o.orderNo}</b>
                            </td>
                            <td>{o.placedAt}</td>
                            <td>{o.buyer}</td>
                            <td className="num">{o.totalText}</td>
                            <td>{o.status}</td>
                            <td>
                              <span className={statusBadge(o.phase)}>{statusText[o.phase] ?? o.phase}</span>
                              {o.attemptCount > 1 ? <span className="meta"> ×{o.attemptCount}</span> : null}
                              {o.lastError ? <div className="err">{o.lastError}</div> : null}
                            </td>
                            <td>
                              {o.issues.length === 0 ? <span className="meta">无</span> : (
                                <details>
                                  <summary>{o.issues.length} 条</summary>
                                  <ul style={{ margin: '6px 0 0 16px', padding: 0 }}>
                                    {o.issues.map((i, idx) => (
                                      <li key={idx} className={i.severity === 'error' ? 'err' : 'meta'}>{i.code}: {i.message}</li>
                                    ))}
                                  </ul>
                                </details>
                              )}
                            </td>
                            <td>
                              {o.screenshotPath ? (
                                <button className="ghost" style={{ padding: '2px 8px', fontSize: 12 }} onClick={() => setViewer({ orderNo: o.orderNo, path: o.screenshotPath! })}>查看</button>
                              ) : <span className="meta">-</span>}
                            </td>
                          </tr>
                          {expanded === o.id ? (
                            <tr>
                              <td colSpan={8} style={{ background: 'var(--soft)' }}>
                                {o.lines.length === 0 ? (
                                  <div className="meta">该订单还没有明细采集结果。</div>
                                ) : (
                                  <>
                                    <div className="meta" style={{ marginBottom: 6 }}>
                                      {o.orderNo} 明细行（{o.lines.length} 行，行金额合计 = 订单总额）
                                    </div>
                                    <table>
                                      <thead><tr><th>行号</th><th>商品编码</th><th>商品名称</th><th>单价</th><th>数量</th><th>行金额</th><th>核对</th></tr></thead>
                                      <tbody>
                                        {o.lines.map((l) => (
                                          <tr key={l.lineNo}>
                                            <td>{l.lineNo}</td>
                                            <td>{l.sku}</td>
                                            <td>{l.name}</td>
                                            <td className="num">{l.unitPrice}</td>
                                            <td className="num">{l.quantity}</td>
                                            <td className="num">{l.amount}</td>
                                            <td><span className={l.ok ? 'badge ok' : 'badge bad'}>{l.ok ? '一致' : '不一致'}</span></td>
                                          </tr>
                                        ))}
                                      </tbody>
                                    </table>
                                  </>
                                )}
                              </td>
                            </tr>
                          ) : null}
                          </React.Fragment>
                        ))}
                      </tbody>
                    </table>
                  )
                ) : null}
                {tab === 'exceptions' ? (
                  detail.exceptions.length === 0 ? <div className="empty">没有异常</div> : (
                    <table>
                      <thead><tr><th>时间</th><th>订单号</th><th>代码</th><th>级别</th><th>说明</th></tr></thead>
                      <tbody>
                        {detail.exceptions.map((e) => (
                          <tr key={e.id}>
                            <td className="meta">{e.createdAt}</td>
                            <td>{e.orderNo ?? '（批次级）'}</td>
                            <td>{e.code}</td>
                            <td><span className={e.severity === 'error' ? 'badge bad' : 'badge warn'}>{e.severity === 'error' ? '错误' : '警告'}</span></td>
                            <td>{e.message}</td>
                          </tr>
                        ))}
                      </tbody>
                    </table>
                  )
                ) : null}
                {tab === 'runs' ? (
                  detail.runs.length === 0 ? <div className="empty">还没有运行记录</div> : (
                    <table>
                      <thead><tr><th>#</th><th>开始</th><th>结束</th><th>状态</th><th>订单</th><th>明细</th><th>说明</th></tr></thead>
                      <tbody>
                        {detail.runs.map((r) => (
                          <tr key={r.id}>
                            <td>{r.id}</td>
                            <td className="meta">{r.startedAt}</td>
                            <td className="meta">{r.finishedAt ?? '-'}</td>
                            <td><span className={statusBadge(r.status)}>{statusText[r.status] ?? r.status}</span></td>
                            <td className="num">{r.collectedCount}</td>
                             <td className="num">{r.detailCount}</td>
                            <td>{r.reason ?? '-'}</td>
                          </tr>
                        ))}
                      </tbody>
                    </table>
                  )
                ) : null}
                {viewer ? (
                  <div className="body">
                    <div className="row" style={{ marginBottom: 8 }}>
                      <b>订单 {viewer.orderNo} 的截图</b>
                      <button className="ghost" onClick={() => setViewer(null)} style={{ marginLeft: 'auto' }}>关闭</button>
                    </div>
                    <img className="shot" src={`/console/api/files/${encodeURIComponent(viewer.path)}`} alt={`订单 ${viewer.orderNo} 截图`} />
                  </div>
                ) : null}
              </>
            ) : (
              <div className="empty">在左侧选择一个批次</div>
            )}
          </section>
        </div>
      </main>
    </>
  )
}

createRoot(document.getElementById('root')!).render(<App />)
