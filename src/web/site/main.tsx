// 演示站点前端：登录、日期筛选、固定排序、虚拟滚动列表、延迟加载明细、控制台开关。
import React from 'react'
import { createRoot } from 'react-dom/client'
import { useEffect, useMemo, useRef, useState } from 'react'
import {
  LIST_OVERSCAN,
  LIST_ROW_HEIGHT,
  LIST_VIEWPORT_HEIGHT,
  SITE_SORT_LABEL,
  type BootFlags,
  type BootOrderLine,
  type BootOrderRow,
  type SiteBoot,
} from '../../shared/contract.ts'
import { formatCount } from '../../shared/money.ts'

const boot = window.__SITE_BOOT__ ?? null

const CSS = `
:root{--line:#e3e8ee;--muted:#667085;--ink:#101828;--accent:#155eef;--soft:#f6f8fb;--warn:#b42318}
*{box-sizing:border-box}
body{margin:0;font:14px/1.5 "DejaVu Sans","WenQuanYi Zen Hei",system-ui,sans-serif;color:var(--ink);background:#fff}
header.site{display:flex;align-items:center;justify-content:space-between;gap:16px;padding:12px 24px;border-bottom:1px solid var(--line);background:var(--soft)}
header.site h1{font-size:16px;margin:0;letter-spacing:.3px}
header.site .who{color:var(--muted);font-size:13px;display:flex;align-items:center;gap:10px}
header.site .who b{color:var(--ink)}
main.site{max-width:1180px;margin:0 auto;padding:24px}
.card{border:1px solid var(--line);border-radius:10px;background:#fff}
.login-wrap{max-width:430px;margin:10vh auto;padding:28px}
.login-wrap h1{font-size:20px;margin:0 0 4px}
.login-wrap p.hint{color:var(--muted);margin:0 0 20px}
label{display:block;font-size:13px;color:#344054;margin:12px 0 6px}
input[type=text],input[type=password],input[type=date],input[type=number]{width:100%;padding:9px 11px;border:1px solid #cfd6e0;border-radius:8px;font:inherit;background:#fff}
input[type=checkbox]{width:16px;height:16px}
button{padding:8px 16px;border-radius:8px;border:1px solid #cfd6e0;background:#fff;font:inherit;cursor:pointer}
button.primary{background:var(--accent);border-color:var(--accent);color:#fff}
button.ghost{color:var(--accent);border-color:#c7d7fe;background:#f5f8ff}
.toolbar{display:flex;flex-wrap:wrap;align-items:end;gap:14px;padding:14px 16px;border-bottom:1px solid var(--line)}
.toolbar .field{min-width:150px}
.toolbar .spacer{flex:1}
.summary{color:var(--muted);font-size:13px;margin:0}
.summary b{color:var(--ink)}
.notice{margin:0 0 16px;padding:10px 14px;border-radius:8px;border:1px solid #fecdd3;background:#fff1f2;color:var(--warn)}
.notice.info{border-color:#c7d7fe;background:#eff4ff;color:#175cd3}
.error{padding:10px 14px;border-radius:8px;border:1px solid #fecdd3;background:#fff1f2;color:var(--warn);margin:14px 0}
table.grid{width:100%;border-collapse:collapse}
table.grid th,table.grid td{padding:11px 14px;border-bottom:1px solid var(--line);text-align:left;vertical-align:middle;white-space:nowrap}
table.grid th{font-size:12px;letter-spacing:.4px;text-transform:uppercase;color:var(--muted);background:var(--soft);font-weight:600}
table.grid tr:last-child td{border-bottom:0}
table.grid td.num,table.grid th.num{text-align:right;font-variant-numeric:tabular-nums}
.link{color:var(--accent);text-decoration:none}
.link:hover{text-decoration:underline}
.badge{display:inline-block;padding:2px 8px;border-radius:999px;font-size:12px;background:#eef2f6;color:#344054}
.badge.ok{background:#e8f5ee;color:#067647}
.badge.warn{background:#fff4e8;color:#b54708}
.pager{display:flex;align-items:center;gap:14px;padding:12px 16px;border-top:1px solid var(--line)}
.empty{padding:48px 20px;text-align:center;color:var(--muted)}
.detail-head{display:flex;justify-content:space-between;align-items:flex-start;gap:20px;padding:18px 20px;border-bottom:1px solid var(--line)}
.detail-head h2{margin:0 0 4px;font-size:19px}
.kv{display:grid;grid-template-columns:repeat(2,minmax(220px,1fr));gap:10px 26px;padding:16px 20px;border-bottom:1px solid var(--line);background:var(--soft);margin:0}
.kv div{display:flex;gap:10px}
.kv dt{color:var(--muted);min-width:74px;margin:0}
.kv dd{margin:0;font-weight:600}
.detail-total{display:flex;justify-content:flex-end;gap:16px;padding:14px 20px;font-size:15px}
.detail-total .sum{font-weight:700}
.loading{padding:40px 20px;text-align:center;color:var(--muted)}
.footnote{padding:14px 20px;color:var(--muted);font-size:12px;border-top:1px solid var(--line)}
.expired{max-width:470px;margin:12vh auto;padding:28px;text-align:center}
.list-scroll{height:${LIST_VIEWPORT_HEIGHT}px;overflow:auto;position:relative;overscroll-behavior:contain}
.list-inner{position:relative}
.row-abs{position:absolute;left:0;right:0;height:${LIST_ROW_HEIGHT}px;display:flex;align-items:center;border-bottom:1px solid var(--line);padding:0 14px;gap:14px}
.row-abs:hover{background:var(--soft)}
.col-no{width:200px;flex:none;position:relative}
.col-time{width:180px;flex:none;color:#344054}
.col-buyer{width:110px;flex:none}
.col-status{width:100px;flex:none}
.col-count{width:100px;flex:none;text-align:right;color:#344054}
.col-total{flex:1;text-align:right;font-variant-numeric:tabular-nums;font-weight:600}
.head-row{display:flex;align-items:center;gap:14px;padding:11px 14px;background:var(--soft);border-bottom:1px solid var(--line);font-size:12px;letter-spacing:.4px;text-transform:uppercase;color:var(--muted);font-weight:600}
.controls{max-width:660px;margin:0 auto;padding:24px}
.toggle{display:flex;align-items:center;gap:10px;margin:14px 0}
.toggle label{margin:0}
.kbd{font-family:"DejaVu Sans Mono",monospace;background:#f2f4f7;border:1px solid var(--line);border-radius:4px;padding:1px 6px;font-size:12px}
.quick{display:flex;gap:6px;flex-wrap:wrap}
.quick button{padding:4px 10px;font-size:12px}
.sr-only{position:absolute;width:1px;height:1px;overflow:hidden;clip:rect(0 0 0 0);white-space:nowrap}
`

function injectCss() {
  if (document.getElementById('site-css')) return
  const s = document.createElement('style')
  s.id = 'site-css'
  s.textContent = CSS
  document.head.appendChild(s)
}

function escapeAttr(s: string): string {
  return s.replace(/"/g, '&quot;').replace(/</g, '&lt;')
}

function Header({ username }: { username: string }) {
  return (
    <header className="site">
      <h1>商户订单工作台</h1>
      <div className="who">
        <span>当前登录：<b data-session-user>{username}</b></span>
        <a className="link" href="/site/console" data-console-link>演示控制台</a>
        <form method="post" action="/site/logout" style={{ margin: 0 }}>
          <button type="submit" className="ghost">退出登录</button>
        </form>
      </div>
    </header>
  )
}

function LoginPage({ boot: b }: { boot: Extract<SiteBoot, { kind: 'login' }> }) {
  return (
    <main className="site">
      <div className="card login-wrap">
        <h1>商户订单工作台</h1>
        <p className="hint">请登录后查看订单列表与明细</p>
        {b.error ? <div className="error" data-login-error>{b.error}</div> : null}
        <form method="post" action="/site/login" id="login-form">
          <input type="hidden" name="next" value={b.next} />
          <label htmlFor="username">账号</label>
          <input id="username" name="username" type="text" autoComplete="username" defaultValue="" />
          <label htmlFor="password">密码</label>
          <input id="password" name="password" type="password" autoComplete="current-password" defaultValue="" />
          <p style={{ margin: '18px 0 0' }}>
            <button className="primary" type="submit" style={{ width: '100%' }} id="login-submit">登录</button>
          </p>
        </form>
        <div className="footnote" style={{ padding: '16px 0 0', border: 0 }}>
          演示账号：
          <ul style={{ margin: '6px 0 0 18px', padding: 0 }}>
            {b.accounts.map((a) => (
              <li key={a.username}>
                <code>{a.username}</code> / <code>{a.password}</code> — {a.displayName}
              </li>
            ))}
          </ul>
        </div>
      </div>
    </main>
  )
}

function ExpiredPage({ boot: b }: { boot: Extract<SiteBoot, { kind: 'expired' }> }) {
  const href = `/site/login?next=${encodeURIComponent(b.next)}&relogin=1`
  return (
    <main className="site">
      <div className="card expired" id="expired-card">
        <h1 style={{ fontSize: 19, margin: '0 0 8px' }}>登录已过期</h1>
        <p style={{ color: 'var(--muted)', margin: '0 0 18px' }}>
          为保护账户安全，当前会话已自动退出。请重新登录后继续查看订单。
        </p>
        <a className="link" href={href} id="relogin-link" style={{ display: 'inline-block', marginBottom: 14 }}>重新登录</a>
      </div>
    </main>
  )
}

function Badge({ status }: { status: string }) {
  const cls = status === '已完成' ? 'ok' : status === '待付款' ? 'warn' : ''
  return <span className={`badge ${cls}`} data-status>{status}</span>
}

function shiftDate(base: string, days: number): string {
  const d = new Date(`${base}T12:00:00`)
  d.setDate(d.getDate() + days)
  return d.toISOString().slice(0, 10)
}

function OrdersPage({ boot: b }: { boot: Extract<SiteBoot, { kind: 'orders' }> }) {
  const [from, setFrom] = useState(b.from)
  const [to, setTo] = useState(b.to)
  const scrollRef = useRef<HTMLDivElement | null>(null)
  const [scrollTop, setScrollTop] = useState(0)
  const restoredRef = useRef(false)
  const [restoredScrollTop, setRestoredScrollTop] = useState<number | null>(null)

  const rows = b.orders
  const total = rows.length
  const anchor = b.dateRangeText === '全部日期' ? new Date().toISOString().slice(0, 10) : b.to || b.from
  // 是否已到底由滚动位置直接推导：即使列表不足一屏（未触发滚动事件）也应视为到底。
  const maxScroll = Math.max(0, total * LIST_ROW_HEIGHT - LIST_VIEWPORT_HEIGHT)
  const atEnd = total > 0 && scrollTop >= maxScroll - 1

  // 返回列表时恢复此前保存的滚动位置（触发明细前记录下来的）。
  // 页面恢复完成后才写 data-restored-scroll-top，采集端据此核对「返回后仍在原位」。
  useEffect(() => {
    if (restoredRef.current) return
    restoredRef.current = true
    const raw = sessionStorage.getItem('site:listScrollTop')
    const v = raw === null ? 0 : Math.max(0, Number(raw))
    requestAnimationFrame(() => {
      if (!scrollRef.current) return
      if (Number.isFinite(v) && v > 0) scrollRef.current.scrollTop = v
      setScrollTop(scrollRef.current.scrollTop)
      setRestoredScrollTop(scrollRef.current.scrollTop)
    })
  }, [])

  const visible = useMemo(() => {
    const first = Math.floor(scrollTop / LIST_ROW_HEIGHT)
    const start = Math.max(0, first - LIST_OVERSCAN)
    const count = Math.ceil(LIST_VIEWPORT_HEIGHT / LIST_ROW_HEIGHT) + LIST_OVERSCAN * 2
    const end = Math.min(total, start + count)
    const out: { row: BootOrderRow; index: number }[] = []
    for (let i = start; i < end; i++) out.push({ row: rows[i]!, index: i })
    return out
  }, [scrollTop, rows, total])

  const navigate = (nextFrom: string, nextTo: string) => {
    sessionStorage.removeItem('site:listScrollTop')
    const p = new URLSearchParams()
    if (nextFrom) p.set('from', nextFrom)
    if (nextTo) p.set('to', nextTo)
    const qs = p.toString()
    window.location.href = `/site/orders${qs ? `?${qs}` : ''}`
  }

  const detailHref = (orderNo: string) => {
    const p = new URLSearchParams()
    if (b.from) p.set('from', b.from)
    if (b.to) p.set('to', b.to)
    const qs = p.toString()
    return `/site/orders/${encodeURIComponent(orderNo)}${qs ? `?${qs}` : ''}`
  }

  return (
    <>
      <Header username={b.username} />
      <main className="site">
        {b.sessionNote ? <div className="notice info" id="session-note">{b.sessionNote}</div> : null}
        <div className="card">
          <form
            className="toolbar"
            method="get"
            action="/site/orders"
            id="filter-form"
            onSubmit={(e) => {
              e.preventDefault()
              navigate(from, to)
            }}
          >
            <div className="field">
              <label htmlFor="from">开始日期</label>
              <input id="from" name="from" type="date" value={from} onChange={(e) => setFrom(e.target.value)} />
            </div>
            <div className="field">
              <label htmlFor="to">结束日期</label>
              <input id="to" name="to" type="date" value={to} onChange={(e) => setTo(e.target.value)} />
            </div>
            <button className="primary" type="submit" id="apply-filter">筛选</button>
            <button className="ghost" type="button" id="reset-filter" onClick={() => navigate('', '')}>重置</button>
            <div className="spacer" />
            <p
              className="summary"
              id="list-summary"
              data-total-count={total}
              data-date-range={b.dateRangeText}
              data-sort={b.sort.field + '_' + b.sort.direction}
            >
              筛选范围内共 <b data-total-count-text>{formatCount(total)}</b> 笔订单 · 排序：<b data-sort-label>{SITE_SORT_LABEL}</b>（固定）
            </p>
          </form>
          <div style={{ display: 'flex', gap: 6, padding: '10px 16px', borderBottom: '1px solid var(--line)', flexWrap: 'wrap', alignItems: 'center' }}>
            <span className="quick">
              {[
                { label: '全部', f: '', t: '' },
                { label: '最近 7 天', f: shiftDate(anchor, -7), t: anchor },
                { label: '最近 14 天', f: shiftDate(anchor, -14), t: anchor },
                { label: '最近 30 天', f: shiftDate(anchor, -30), t: anchor },
              ].map((r) => (
                <button
                  key={r.label}
                  type="button"
                  className={r.label === '全部' && !b.from && !b.to ? 'primary' : 'ghost'}
                  data-quick-range={r.label}
                  onClick={() => navigate(r.f, r.t)}
                >{r.label}</button>
              ))}
            </span>
            <span style={{ marginLeft: 'auto', color: 'var(--muted)', fontSize: 12 }}>
              数据版本：<span data-data-version>{b.dataVersion}</span> · 仅渲染本屏可见行
            </span>
          </div>
          <div style={{ padding: '6px 16px', borderBottom: '1px solid var(--line)', color: 'var(--muted)', fontSize: 12 }}>
            筛选范围：<b data-filter-summary>{b.dateRangeText}</b> · 固定排序键：<span data-sort-field>{b.sort.field}</span> <span data-sort-direction>{b.sort.direction}</span>
            <span data-from-value={from} data-to-value={to} style={{ display: 'none' }}>{from}|{to}</span>
          </div>
          {total === 0 ? (
            <div className="empty" data-empty>当前日期范围内没有订单</div>
          ) : (
            <>
              <div className="head-row">
                <span className="col-no">订单号</span>
                <span className="col-time">下单时间</span>
                <span className="col-buyer">买家</span>
                <span className="col-status">状态</span>
                <span className="col-count">明细项数</span>
                <span className="col-total">订单总额</span>
              </div>
              <div
                ref={scrollRef}
                className="list-scroll"
                id="order-scroll"
                data-row-count={total}
                data-row-height={LIST_ROW_HEIGHT}
                data-viewport-height={LIST_VIEWPORT_HEIGHT}
                data-scroll-top={scrollTop}
                data-at-end={atEnd ? 'true' : 'false'}
                data-restored-scroll-top={restoredScrollTop ?? ''}
                onScroll={(e) => {
                  const el = e.currentTarget
                  const st = el.scrollTop
                  setScrollTop(st)
                  sessionStorage.setItem('site:listScrollTop', String(st))
                }}
              >
                <div className="list-inner" style={{ height: total * LIST_ROW_HEIGHT }} data-virtual-total-height={total * LIST_ROW_HEIGHT}>
                  {visible.map(({ row, index }) => (
                    <div
                      key={row.orderNo}
                      className="row-abs"
                      data-order-row
                      data-order-no={row.orderNo}
                      data-row-index={index}
                      data-placed-at-ms={row.placedAtMs}
                      style={{ top: index * LIST_ROW_HEIGHT }}
                    >
                      <span className="col-no">
                        <a className="link" data-order-link href={detailHref(row.orderNo)}>{row.orderNo}</a>
                        <span className="sr-only" data-sort-key>{row.placedAt}</span>
                      </span>
                      <span className="col-time" data-placed-at>{row.placedAt}</span>
                      <span className="col-buyer" data-buyer>{row.buyer}</span>
                      <span className="col-status"><Badge status={row.status} /></span>
                      <span className="col-count" data-item-count>{row.itemCountText}</span>
                      <span className="col-total" data-total>{row.totalText}</span>
                    </div>
                  ))}
                </div>
              </div>
              <div className="pager" id="list-pager">
                {atEnd ? (
                  <span className="summary" data-reached-end>
                    <b>已滚动到底部，没有更多订单行</b> · 已渲染 {formatCount(visible.length)} 行
                  </span>
                ) : (
                  <span className="summary">已渲染 <b data-rendered-count>{visible.length}</b> / {formatCount(total)} 行 · 继续向下滚动</span>
                )}
              </div>
            </>
          )}
        </div>
      </main>
    </>
  )
}

function DetailPage({ boot: b }: { boot: Extract<SiteBoot, { kind: 'detail' }> }) {
  const [ready, setReady] = useState(b.detailDelayMs <= 0)
  const [elapsed, setElapsed] = useState(0)

  // 进入明细前记录列表的滚动位置：返回列表后页面据此恢复并继续采集
  useEffect(() => {
    const raw = sessionStorage.getItem('site:listScrollTop')
    if (!raw) return
    const key = `site:detailScroll:${b.order.orderNo}`
    if (!sessionStorage.getItem(key)) sessionStorage.setItem(key, raw)
  }, [b.order.orderNo])

  useEffect(() => {
    if (b.detailDelayMs <= 0) return
    const start = performance.now()
    const tick = setInterval(() => setElapsed((performance.now() - start) / 1000), 100)
    const done = setTimeout(() => {
      clearInterval(tick)
      setElapsed(b.detailDelayMs / 1000)
      setReady(true)
    }, b.detailDelayMs)
    return () => {
      clearInterval(tick)
      clearTimeout(done)
    }
  }, [b.detailDelayMs])

  const lines: BootOrderLine[] = b.order.lines

  return (
    <>
      <Header username={b.username} />
      <main className="site">
        {b.sessionNote ? <div className="notice info" id="session-note">{b.sessionNote}</div> : null}
        <div style={{ marginBottom: 12, display: 'flex', gap: 14, alignItems: 'center' }}>
          <a className="link" href={b.backUrl} id="back-to-list">← 返回订单列表</a>
          <span style={{ color: 'var(--muted)', fontSize: 12 }} data-back-url={escapeAttr(b.backUrl)}>返回后将恢复列表滚动位置</span>
        </div>
        <div
          className="card"
          id="detail-card"
          data-detail-for={b.order.orderNo}
          data-detail-ready={ready ? 'ready' : 'pending'}
          data-detail-delay-ms={b.detailDelayMs}
        >
          <div className="detail-head">
            <div>
              <h2 data-detail-order-no>{b.order.orderNo}</h2>
              <div style={{ color: 'var(--muted)' }}>订单明细 · 固定数据快照</div>
            </div>
            <Badge status={b.order.status} />
          </div>
          <dl className="kv">
            <div><dt>下单时间</dt><dd data-detail-placed-at>{b.order.placedAt}</dd></div>
            <div><dt>买家</dt><dd data-detail-buyer>{b.order.buyer}</dd></div>
            <div><dt>明细项数</dt><dd data-detail-count>{b.order.itemCountText}</dd></div>
            <div><dt>订单总额</dt><dd data-detail-total>{b.order.totalText}</dd></div>
          </dl>
          {!ready ? (
            <div id="detail-loading" className="loading" data-loading data-delay-ms={b.detailDelayMs} data-loading-elapsed={elapsed.toFixed(1)}>
              正在加载订单明细… <span>{elapsed.toFixed(1)}</span>s
            </div>
          ) : null}
          {ready ? (
            <table className="grid" id="detail-lines" data-detail-lines data-line-count={lines.length}>
              <thead>
                <tr><th>行号</th><th>商品编码</th><th>商品名称</th><th className="num">单价</th><th className="num">数量</th><th className="num">行金额</th></tr>
              </thead>
              <tbody>
                {lines.map((l) => (
                  <tr key={l.lineNo} data-detail-line data-line-no={l.lineNo}>
                    <td>{l.lineNo}</td>
                    <td data-sku>{l.sku}</td>
                    <td data-product>{l.name}</td>
                    <td className="num" data-unit-price>{l.unitPriceText}</td>
                    <td className="num" data-quantity>{l.quantityText}</td>
                    <td className="num" data-line-amount>{l.amountText}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          ) : null}
          <div className="detail-total">合计 <span className="sum" data-detail-sum data-detail-sum-text={b.order.totalText}>{b.order.totalText}</span></div>
          <div className="footnote">单价 × 数量应等于行金额；行金额合计应等于订单总额。</div>
        </div>
      </main>
    </>
  )
}

function ConsolePage({ boot: b }: { boot: Extract<SiteBoot, { kind: 'console' }> }) {
  const [delay, setDelay] = useState(String(b.flags.detailDelayMs))
  const [expiry, setExpiry] = useState(String(b.flags.sessionExpiryMs))
  const [auto, setAuto] = useState(b.flags.autoLogout)
  const [msg, setMsg] = useState('')
  const [flags, setFlags] = useState<BootFlags>(b.flags)
  // 新建演示订单后数据版本与订单数会前进；这里只做展示刷新，已有批次仍固定原快照。
  const [version, setVersion] = useState(b.dataVersion)
  const [orderCount, setOrderCount] = useState(b.orderCount)
  useEffect(() => { injectCss() }, [])
  return (
    <>
      <Header username={b.username} />
      <main className="site">
        <div className="card controls">
          <h2 style={{ margin: '0 0 4px', fontSize: 18 }}>演示控制台</h2>
          <p className="summary">调整站点行为，采集端下一次开始时读取。仅影响后续请求。</p>
          {msg ? <div className="notice info" style={{ marginTop: 14 }} data-console-msg>{msg}</div> : null}
          <label htmlFor="delay">明细加载延迟（毫秒）</label>
          <input id="delay" type="number" min="0" step="50" value={delay} onChange={(e) => setDelay(e.target.value)} />
          <label htmlFor="expiry">自动退出登录：会话有效期（毫秒）</label>
          <input id="expiry" type="number" min="1000" step="1000" value={expiry} onChange={(e) => setExpiry(e.target.value)} />
          <div className="toggle">
            <input id="auto" type="checkbox" checked={auto} onChange={(e) => setAuto(e.target.checked)} />
            <label htmlFor="auto">启用自动退出登录</label>
          </div>
          <p style={{ marginTop: 16 }}>
            <button
              className="primary"
              id="save-flags"
              onClick={async () => {
                const r = await fetch('/api/site/flags', {
                  method: 'POST',
                  headers: { 'content-type': 'application/json' },
                  body: JSON.stringify({ detailDelayMs: Number(delay), sessionExpiryMs: Number(expiry), autoLogout: auto }),
                })
                const j = (await r.json()) as { flags: BootFlags }
                setFlags(j.flags)
                setMsg(`已保存：明细延迟 ${j.flags.detailDelayMs}ms，自动退出 ${j.flags.autoLogout ? `开启（${j.flags.sessionExpiryMs}ms）` : '关闭'}`)
              }}
            >保存设置</button>
          </p>
          <p style={{ marginTop: 16 }}>
            <button
              className="ghost"
              id="create-demo-order"
              onClick={async () => {
                const r = await fetch('/api/site/new-order', { method: 'POST' })
                const j = (await r.json()) as { orderNo: string; dataVersion: string; count: number }
                setVersion(j.dataVersion)
                setOrderCount(j.count)
                setMsg(`已新建演示订单 ${j.orderNo}，数据版本前进到 ${j.dataVersion}；已建立的批次不会纳入它。`)
              }}
            >新建一笔演示订单</button>
          </p>
          <div className="footnote" style={{ padding: '14px 0 0', border: 0 }}>
            <p>数据版本 <span className="kbd" data-console-version>{version}</span>，快照时间 <span className="kbd">{b.snapshotAt}</span>，订单 <span className="kbd" data-console-count>{orderCount}</span> 笔。</p>
            <p style={{ marginTop: 8 }}>当前生效：明细延迟 <span className="kbd" data-console-delay>{flags.detailDelayMs}</span>ms，自动退出 <span className="kbd" data-console-auto>{flags.autoLogout ? '开启' : '关闭'}</span>。</p>
            <p style={{ marginTop: 8 }}>
              会话有效期只在开启自动退出后生效；已过期的页面会显示「登录已过期」。
            </p>
          </div>
        </div>
      </main>
    </>
  )
}

function App() {
  if (!boot) return <div style={{ padding: 24 }}>页面数据缺失，请刷新重试。</div>
  switch (boot.kind) {
    case 'login':
      return <LoginPage boot={boot} />
    case 'expired':
      return <ExpiredPage boot={boot} />
    case 'orders':
      return <OrdersPage boot={boot} />
    case 'detail':
      return <DetailPage boot={boot} />
    case 'console':
      return <ConsolePage boot={boot} />
    default:
      return <div style={{ padding: 24 }}>未知页面</div>
  }
}

injectCss()
const root = document.getElementById('root')
if (root) createRoot(root).render(<App />)
