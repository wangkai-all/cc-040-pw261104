// 演示站点：登录、日期筛选、固定排序（下单时间倒序）、虚拟滚动列表、延迟加载明细、自动退出登录。
// 页面由 React 渲染；Express 只产出页面外壳与每次请求的 boot 数据。
// 采集端不会读取 boot 或 /api，只读页面上渲染出来的内容。
import express, { type Express, type Request, type Response } from 'express'
import { randomUUID } from 'node:crypto'
import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'
import type { DatabaseSync } from 'node:sqlite'
import type { DemoOrder } from '../shared/types.js'
import { SITE_SORT, SITE_SORT_LABEL, type BootOrderLine, type BootOrderRow, type SiteBoot } from '../shared/contract.js'
import { formatCount, money } from '../shared/money.js'
import type { DemoFlags } from './flags.js'
import { nowIso } from './db.js'

export interface SiteSession {
  sid: string
  username: string
  issuedAt: number
  expiresAt: number
}

export interface SiteState {
  orders: DemoOrder[]
  dataVersion: string
  snapshotAt: string
  revision: number
  sessions: Map<string, SiteSession>
  flags: DemoFlags
}

export const DEMO_ACCOUNTS = [
  { username: 'demo', password: 'demo1234', displayName: '演示运营账号' },
  { username: 'buyer', password: 'buyer1234', displayName: '买家视角账号' },
] as const

export interface SiteOptions {
  /** 前端产物目录，用于读取 index.html 里的资源名 */
  webDist: string
  db: DatabaseSync
}

function parseCookies(header: string | undefined): Record<string, string> {
  const out: Record<string, string> = {}
  if (!header) return out
  for (const part of header.split(';')) {
    const idx = part.indexOf('=')
    if (idx === -1) continue
    const k = part.slice(0, idx).trim()
    const v = part.slice(idx + 1).trim()
    if (k) out[k] = decodeURIComponent(v)
  }
  return out
}

function shellHtml(bootToken: string): string {
  return `<!DOCTYPE html>
<html lang="zh-CN">
<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width, initial-scale=1">
  <meta http-equiv="cache-control" content="no-store">
  <title>商户订单工作台</title>
  <script src="/site-boot.js?t=${encodeURIComponent(bootToken)}"></script>
  <link rel="stylesheet" href="/assets/site.css">
</head>
<body>
  <div id="root"></div>
  <script type="module" src="/assets/site.js"></script>
</body>
</html>`
}

function accountList() {
  return DEMO_ACCOUNTS.map((a) => ({ username: a.username, password: a.password, displayName: a.displayName }))
}

function toBootRow(o: DemoOrder): BootOrderRow {
  return {
    orderNo: o.orderNo,
    placedAt: o.placedAt,
    placedAtMs: o.placedAtMs,
    buyer: o.buyer,
    status: o.status,
    itemCountText: `${o.itemCount} 项`,
    totalText: money(o.totalAmount),
  }
}

function toBootLines(o: DemoOrder): BootOrderLine[] {
  return o.lines.map((l) => ({
    lineNo: l.lineNo,
    sku: l.sku,
    name: l.name,
    unitPriceText: money(l.unitPrice),
    quantityText: String(l.quantity),
    amountText: money(l.amount),
  }))
}

interface ListQuery {
  from: string
  to: string
}

function readListQuery(req: Request): ListQuery {
  const q = req.query
  return {
    from: typeof q.from === 'string' ? q.from.trim() : '',
    to: typeof q.to === 'string' ? q.to.trim() : '',
  }
}

export function filterOrders(orders: DemoOrder[], from: string, to: string): DemoOrder[] {
  return orders.filter((o) => (!from || o.orderDate >= from) && (!to || o.orderDate <= to))
}

function listUrl(from: string, to: string): string {
  const p = new URLSearchParams()
  if (from) p.set('from', from)
  if (to) p.set('to', to)
  const s = p.toString()
  return `/site/orders${s ? `?${s}` : ''}`
}

function sanitizeNext(next: string): string {
  if (!next.startsWith('/site/') || next.startsWith('//')) return '/site/orders'
  return next
}

export function registerSite(app: Express, state: SiteState, opts: SiteOptions) {
  const { db, webDist } = opts
  const boots = new Map<string, { boot: SiteBoot; at: number }>()
  const BOOT_TTL_MS = 60_000

  const stashBoot = (boot: SiteBoot): string => {
    const token = randomUUID()
    boots.set(token, { boot, at: Date.now() })
    if (boots.size > 200) {
      for (const [k, v] of boots) if (Date.now() - v.at > BOOT_TTL_MS) boots.delete(k)
    }
    return token
  }

  const sendPage = (res: Response, boot: SiteBoot) => {
    res.setHeader('Cache-Control', 'no-store, max-age=0')
    res.type('html').send(shellHtml(stashBoot(boot)))
  }

  const currentSession = (req: Request): { session: SiteSession | null; expired: boolean } => {
    const sid = parseCookies(req.headers.cookie)['site_sid']
    if (!sid) return { session: null, expired: false }
    const s = state.sessions.get(sid)
    if (!s) return { session: null, expired: false }
    if (s.expiresAt > 0 && Date.now() >= s.expiresAt) {
      state.sessions.delete(sid)
      return { session: null, expired: true }
    }
    return { session: s, expired: false }
  }

  const setSessionCookie = (res: Response, sid: string) => {
    res.appendHeader('Set-Cookie', `site_sid=${encodeURIComponent(sid)}; Path=/; HttpOnly; SameSite=Lax`)
  }
  const clearSessionCookie = (res: Response) => {
    res.appendHeader('Set-Cookie', 'site_sid=; Path=/; Max-Age=0; HttpOnly; SameSite=Lax')
  }

  const requireSession = (req: Request, res: Response, next: string): SiteSession | null => {
    const { session, expired } = currentSession(req)
    if (session) return session
    if (expired) {
      db.prepare('INSERT INTO site_expiries (path, at) VALUES (?, ?)').run(req.path, nowIso())
      sendExpired(res, next, state.flags)
      return null
    }
    res.redirect(302, `/site/login?next=${encodeURIComponent(next)}`)
    return null
  }

  const sendExpired = (res: Response, next: string, flags: DemoFlags) => {
    res.status(401)
    sendPage(res, {
      kind: 'expired',
      next,
      sessionNote: flags.autoLogout ? '自动退出登录已开启' : '会话已失效',
    })
  }

  // ---------- 页面 ----------

  app.get('/site/login', (req, res) => {
    const next = typeof req.query.next === 'string' ? sanitizeNext(req.query.next) : '/site/orders'
    sendPage(res, { kind: 'login', next, accounts: accountList() })
  })

  app.post('/site/login', express.urlencoded({ extended: false }), (req, res) => {
    const body = req.body ?? {}
    const username = String(body.username ?? '')
    const password = String(body.password ?? '')
    const next = sanitizeNext(String(body.next ?? '/site/orders'))
    const account = DEMO_ACCOUNTS.find((a) => a.username === username && a.password === password)
    if (!account) {
      sendLoginError(res, next, '账号或密码不正确，请重试。')
      return
    }
    const issuedAt = Date.now()
    const sid = randomUUID()
    state.sessions.set(sid, {
      sid,
      username: account.username,
      issuedAt,
      expiresAt: state.flags.autoLogout ? issuedAt + state.flags.sessionExpiryMs : 0,
    })
    db.prepare('INSERT INTO site_login_events (username, at) VALUES (?, ?)').run(account.username, nowIso())
    setSessionCookie(res, sid)
    res.redirect(302, next)
  })

  function sendLoginError(res: Response, next: string, message: string) {
    res.status(401)
    sendPage(res, { kind: 'login', next, accounts: accountList(), error: message } as SiteBoot)
  }

  app.post('/site/logout', (req, res) => {
    const sid = parseCookies(req.headers.cookie)['site_sid']
    if (sid) state.sessions.delete(sid)
    clearSessionCookie(res)
    res.redirect(302, '/site/login')
  })

  app.get('/site/orders', (req, res) => {
    const q = readListQuery(req)
    const session = requireSession(req, res, listUrl(q.from, q.to))
    if (!session) return
    const filtered = filterOrders(state.orders, q.from, q.to)
    const dateRangeText = q.from || q.to ? `${q.from || '不限'} 至 ${q.to || '不限'}` : '全部日期'
    const boot: SiteBoot = {
      kind: 'orders',
      username: session.username,
      from: q.from,
      to: q.to,
      sort: { field: SITE_SORT.field, direction: SITE_SORT.direction, label: SITE_SORT_LABEL },
      dataVersion: state.dataVersion,
      totalCount: filtered.length,
      dateRangeText,
      sessionNote: typeof req.query.relogin === 'string' ? '已重新登录，继续未完成的采集' : '',
      orders: filtered.map(toBootRow),
    }
    sendPage(res, boot)
  })

  app.get('/site/orders/:orderNo', (req, res) => {
    const orderNo = String(req.params.orderNo)
    const q = readListQuery(req)
    const session = requireSession(req, res, `/site/orders/${orderNo}${listUrl(q.from, q.to).split('?')[1] ? `?${listUrl(q.from, q.to).split('?')[1]}` : ''}`)
    if (!session) return
    const order = state.orders.find((o) => o.orderNo === orderNo)
    if (!order) {
      res.status(404).type('html').send(`<!DOCTYPE html><html lang="zh-CN"><body><p>未找到订单 ${escapeHtml(orderNo)}</p></body></html>`)
      return
    }
    const boot: SiteBoot = {
      kind: 'detail',
      username: session.username,
      order: {
        orderNo: order.orderNo,
        placedAt: order.placedAt,
        buyer: order.buyer,
        status: order.status,
        totalText: money(order.totalAmount),
        itemCountText: `${order.lines.length} 项`,
        lines: toBootLines(order),
      },
      detailDelayMs: state.flags.detailDelayMs,
      from: q.from,
      to: q.to,
      backUrl: listUrl(q.from, q.to),
      sessionNote: '',
    }
    sendPage(res, boot)
  })

  app.get('/site/console', (req, res) => {
    const session = requireSession(req, res, '/site/console')
    if (!session) return
    const boot = {
      kind: 'console',
      username: session.username,
      flags: state.flags,
      dataVersion: state.dataVersion,
      snapshotAt: state.snapshotAt,
      orderCount: state.orders.length,
    } satisfies SiteBoot
    sendPage(res, boot)
  })

  // ---------- 站点内部接口（页面自身/操作台使用，采集端被网络守卫禁止调用） ----------

  app.get('/site-boot.js', (req, res) => {
    const token = typeof req.query.t === 'string' ? req.query.t : ''
    const entry = boots.get(token)
    boots.delete(token)
    if (!entry) {
      res.status(404).type('js').send('window.__SITE_BOOT__ = null;')
      return
    }
    res.setHeader('Cache-Control', 'no-store, max-age=0')
    res.type('js').send(`window.__SITE_BOOT__ = ${JSON.stringify(entry.boot).replace(/</g, '\\u003c')};`)
  })

  app.get('/api/site/meta', (req, res) => {
    const from = typeof req.query.from === 'string' ? req.query.from : ''
    const to = typeof req.query.to === 'string' ? req.query.to : ''
    const filtered = filterOrders(state.orders, from, to)
    const dateRange = state.orders.reduce(
      (acc, o) => ({ min: acc.min && acc.min < o.orderDate ? acc.min : o.orderDate, max: acc.max && acc.max > o.orderDate ? acc.max : o.orderDate }),
      { min: state.orders[0]?.orderDate ?? '', max: state.orders[0]?.orderDate ?? '' },
    )
    res.json({
      dataVersion: state.dataVersion,
      snapshotAt: state.snapshotAt,
      count: filtered.length,
      allCount: state.orders.length,
      dateRange,
      from,
      to,
      flags: state.flags,
      accounts: DEMO_ACCOUNTS.map((a) => ({ username: a.username, password: a.password, displayName: a.displayName })),
    })
  })

  app.post('/api/site/flags', express.json(), (req, res) => {
    const body = req.body ?? {}
    const next: DemoFlags = {
      detailDelayMs: Number.isFinite(Number(body.detailDelayMs)) ? Math.max(0, Math.round(Number(body.detailDelayMs))) : state.flags.detailDelayMs,
      sessionExpiryMs: Number.isFinite(Number(body.sessionExpiryMs)) ? Math.max(1000, Math.round(Number(body.sessionExpiryMs))) : state.flags.sessionExpiryMs,
      autoLogout: typeof body.autoLogout === 'boolean' ? body.autoLogout : state.flags.autoLogout,
    }
    state.flags = next
    db.prepare(
      'INSERT INTO settings (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value',
    ).run('demo_flags', JSON.stringify(next))
    res.json({ flags: next })
  })

  // 演示：批次运行期间新建订单会让站点数据版本前进；这一批会排除它并记一条警告。
  app.post('/api/site/new-order', (_req, res) => {
    const now = new Date()
    const orderNo = `SO2026${String(state.revision + 1).padStart(5, '0')}${String(90000 + state.orders.length).padStart(4, '0')}`
    const line = state.orders[0]?.lines[0]
    const unitPrice = line?.unitPrice ?? 199
    const qty = 2
    const order: DemoOrder = {
      orderNo,
      orderDate: `${now.getFullYear()}-${String(now.getMonth() + 1).padStart(2, '0')}-${String(now.getDate()).padStart(2, '0')}`,
      placedAt: `${now.getFullYear()}-${String(now.getMonth() + 1).padStart(2, '0')}-${String(now.getDate()).padStart(2, '0')} ${String(now.getHours()).padStart(2, '0')}:${String(now.getMinutes()).padStart(2, '0')}:${String(now.getSeconds()).padStart(2, '0')}`,
      placedAtMs: now.getTime(),
      buyer: '新下单买家',
      status: '待付款',
      totalAmount: unitPrice * qty,
      itemCount: 1,
      lines: [{ lineNo: 1, sku: 'SKU-2001', name: '演示新订单商品', unitPrice, quantity: qty, amount: unitPrice * qty }],
    }
    state.orders.unshift(order)
    state.revision += 1
    state.dataVersion = `site-v1+rev${state.revision}`
    res.json({ orderNo, dataVersion: state.dataVersion, count: state.orders.length })
  })

  app.get('/api/site/stats', (_req, res) => {
    const logins = db.prepare('SELECT COUNT(*) AS n FROM site_login_events').get() as { n: number }
    const expiries = db.prepare('SELECT COUNT(*) AS n FROM site_expiries').get() as { n: number }
    res.json({ loginEvents: Number(logins.n), expiryEvents: Number(expiries.n), flags: state.flags, dataVersion: state.dataVersion })
  })

  // 静态资源：Vite 产物。先把 assets 映射到 dist/web/assets，再兜底映射到 dist/web。
  app.use('/assets', express.static(resolve(webDist, 'assets'), { fallthrough: true, index: false, maxAge: 0 }))
  app.use('/assets', express.static(webDist, { fallthrough: true, index: false, maxAge: 0 }))
  app.get('/assets/site.css', (_req, res) => {
    const p = resolve(webDist, 'assets/site.css')
    try {
      readFileSync(p)
      res.sendFile(p)
    } catch {
      res.status(404).type('text/css').send('/* no site stylesheet bundled */')
    }
  })
}

function escapeHtml(s: string): string {
  return s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;')
}
