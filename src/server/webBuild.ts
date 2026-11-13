import { build, type Logger } from 'vite'
import { fileURLToPath } from 'node:url'
import { dirname, resolve } from 'node:path'

export const ROOT_DIR = resolve(dirname(fileURLToPath(import.meta.url)), '../..')

const quietLogger: Logger = {
  info() {},
  warn() {},
  warnOnce() {},
  error(msg) {
    console.error(msg)
  },
  hasErrorLogged: () => false,
  hasWarned: false,
  clearScreen() {},
}

/** 运行期若发现前端产物缺失，按需打包一次（正常情况下 npm start 的 prestart 已完成）。 */
export async function ensureWebBuild(): Promise<string> {
  const outDir = resolve(ROOT_DIR, 'dist/web')
  try {
    const { access } = await import('node:fs/promises')
    await access(resolve(outDir, 'site/index.html'))
    await access(resolve(outDir, 'console/index.html'))
    return outDir
  } catch {
    await build({
      configFile: resolve(ROOT_DIR, 'vite.config.ts'),
      logLevel: 'silent',
      customLogger: quietLogger,
    })
    return outDir
  }
}
