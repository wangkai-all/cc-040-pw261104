// Playwright 启动：在缺少系统图形库的容器里，用仓库内 .runtime/browser-deps 与字体目录兜底。
// 有完整系统依赖的环境会自动忽略这些路径。
import { chromium, type Browser, type BrowserContext, type LaunchOptions } from 'playwright'
import { existsSync } from 'node:fs'
import { resolve } from 'node:path'

const RUNTIME_DIR = resolve(import.meta.dirname, '../..', '.runtime')
const DEPS_DIR = resolve(RUNTIME_DIR, 'browser-deps')
const FONTS_CONF = resolve(RUNTIME_DIR)

function libPath(): string {
  const parts: string[] = []
  if (existsSync(DEPS_DIR)) parts.push(DEPS_DIR)
  const sys = ['/usr/lib/x86_64-linux-gnu', '/lib/x86_64-linux-gnu', '/usr/lib/x86_64-linux-gnu']
  parts.push(...sys)
  return parts.join(':')
}

export function launchEnv(): Record<string, string> {
  const env: Record<string, string> = {}
  for (const [k, v] of Object.entries(process.env)) if (typeof v === 'string') env[k] = v
  if (env.LD_LIBRARY_PATH) {
    env.LD_LIBRARY_PATH = `${libPath()}:${env.LD_LIBRARY_PATH}`
  } else {
    env.LD_LIBRARY_PATH = libPath()
  }
  if (existsSync(resolve(FONTS_CONF, 'fonts.conf'))) {
    env.FONTCONFIG_PATH = FONTS_CONF
    env.FONTCONFIG_FILE = resolve(FONTS_CONF, 'fonts.conf')
  }
  return env
}

export interface LaunchResult {
  browser: Browser
  context: BrowserContext
}

export async function launchBrowser(opts: LaunchOptions = {}): Promise<LaunchResult> {
  const browser = await chromium.launch({
    headless: true,
    args: ['--no-sandbox', '--disable-dev-shm-usage', '--font-render-hinting=none'],
    env: launchEnv(),
    ...opts,
  })
  const context = await browser.newContext({
    viewport: { width: 1280, height: 900 },
    locale: 'zh-CN',
    timezoneId: 'Asia/Shanghai',
  })
  // tsx/esbuild 的 keepNames 会给序列化到浏览器的函数注入 __name 调用；
  // 用字符串形式的 init script 注入一个全局实现，让采集端只读脚本能正常执行。
  await context.addInitScript({
    content: `globalThis.__name = globalThis.__name || function (fn, name) { try { if (typeof fn === "function") { Object.defineProperty(fn, "name", { value: name, configurable: true }); } } catch (e) {} return fn; };`,
  })
  return { browser, context }
}
