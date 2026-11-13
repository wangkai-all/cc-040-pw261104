import { defineConfig } from 'vite'
import react from '@vitejs/plugin-react'
import { resolve } from 'node:path'

// 站点与操作台各自打包：站点页面由 Express 直接返回，操作台走同一份 React 源码。
export default defineConfig({
  plugins: [react()],
  root: 'src/web',
  publicDir: false,
  build: {
    outDir: resolve(import.meta.dirname, 'dist/web'),
    emptyOutDir: true,
    rollupOptions: {
      input: {
        site: resolve(import.meta.dirname, 'src/web/site/index.html'),
        console: resolve(import.meta.dirname, 'src/web/console/index.html'),
      },
      output: {
        entryFileNames: 'assets/[name].js',
        chunkFileNames: 'assets/[name]-[hash].js',
        assetFileNames: 'assets/[name][extname]',
      },
    },
  },
  server: { port: 5199 },
})
