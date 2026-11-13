// 登录与重登：采集端只通过页面上的表单与「重新登录」链接操作。
import type { Page } from 'playwright'
import { isLoginPage, S } from './dom.js'

export interface Credentials {
  username: string
  password: string
}

export const DEMO_CREDENTIALS: Credentials = { username: 'demo', password: 'demo1234' }

export class LoginExpiredError extends Error {
  constructor(message = '登录已过期，采集已暂停') {
    super(message)
    this.name = 'LoginExpiredError'
  }
}

/** 在登录页填表并提交。 */
export async function fillLogin(page: Page, creds: Credentials): Promise<{ ok: boolean; error?: string }> {
  await page.waitForSelector(S.loginForm, { timeout: 15_000 })
  await page.fill(S.username, creds.username)
  await page.fill(S.password, creds.password)
  await page.click(S.loginSubmit)
  await page.waitForURL((u) => !u.pathname.endsWith('/site/login'), { timeout: 15_000 }).catch(() => null)
  if (await isLoginPage(page)) {
    const err = ((await page.locator(S.loginError).textContent().catch(() => '')) ?? '').trim()
    return { ok: false, error: err || '登录失败' }
  }
  return { ok: true }
}

/** 当前页面是登录页则直接登录；是过期页则点「重新登录」再登录。 */
export async function loginFromCurrentPage(page: Page, creds: Credentials): Promise<{ ok: boolean; error?: string }> {
  if (!(await isLoginPage(page))) {
    const relogin = page.locator(S.relogin)
    if ((await relogin.count()) === 0) return { ok: false, error: '当前页面既不是登录页也不是过期页' }
    await Promise.all([
      page.waitForURL((u) => u.pathname.endsWith('/site/login'), { timeout: 15_000 }),
      relogin.first().click(),
    ])
  }
  return fillLogin(page, creds)
}
