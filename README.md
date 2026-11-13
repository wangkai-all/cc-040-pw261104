# 订单采集工作台（本地演示站点 + Playwright 操作台）

一个可本地运行的示例项目：站点用 React + Express 渲染订单列表（**虚拟滚动**、固定排序、日期筛选、登录、延迟加载明细、自动退出登录），
采集端用 Playwright **像人一样操作页面**——登录、填日期、滚动列表、点进明细、返回列表——把筛选范围内的订单与明细采全，
全过程只读取页面上看得见的内容，**不调用任何内部业务接口**。数据落在 SQLite，操作台展示每张订单的结果、异常与截图，并可导出 zip。

## 快速开始

```bash
npm install
npx playwright install chromium   # 首次
npm start                         # http://localhost:4310
```

- 演示站点：<http://localhost:4310/site/login>，账号 `demo` / `demo1234`（另有 `buyer` / `buyer1234`）
- 采集操作台：<http://localhost:4310/console>
- 演示控制台（开关页面）：登录站点后点右上角「演示控制台」，可调明细加载延迟、自动退出登录、新建演示订单

操作台用法：填开始/结束日期（留空为全部）→ 创建采集批次 → 开始采集。跑完后在批次详情看每张订单的核对结果、异常和截图，点「下载订单 / 明细 / 异常（zip）」。

环境变量：`PORT`（默认 4310）、`DB_PATH`（默认 `data/app.db`）、`EXPORT_DIR`、`SCREENSHOT_DIR`、`DEMO_SEED`、`DEMO_ORDER_COUNT`（默认 300）、`DEMO_START_DATE`、`DEMO_DAYS`。

## 满足的采集约束

| 要求 | 实现 |
| --- | --- |
| 列表只渲染可见行 | `src/web/site/main.tsx` 虚拟滚动：固定行高 56px、视口 560px，只有视口内的行（+2 行 overscan）挂在 DOM 上 |
| 采全筛选范围 | `src/scraper/list.ts` 把滚动位置从头扫到底再回绕，每个位置只读 `getBoundingClientRect` 与视口相交的行 |
| DOM 复用 → 去重 | 一律按订单号去重（`rows: Map<orderNo, row>`），重复读到只计数不覆盖 |
| 到底 + 数量一致才算完成 | 页面滚到底渲染「已滚动到底部」提示（`[data-reached-end]`），且已收集数 == 页面「筛选范围内共 N 笔」才算列表完成，否则以 incomplete 终止 |
| 进明细前保存现场 | 每单进入前把筛选条件、排序口径、滚动位置、当前订单号写入 `batches.progress_json` |
| 返回列表继续 | 列表页把进入明细前的滚动位置记到 `sessionStorage`，返回后恢复并回写 `data-restored-scroll-top`；采集端核对恢复值后从原位继续 |
| 明细加载完成再读 | 等 `#detail-card[data-detail-ready="ready"]` 出现（延迟开关生效时页面显示「正在加载…」），再读字段 |
| 明细核对 | 订单号一致；明细行数 == 页面标注项数 == 列表行标注项数；每行单价×数量==行金额；行合计==明细总额==列表总额。买家/下单时间不一致记 warning |
| 快照固定 | 建批次时冻结 `snapshotMaxPlacedAtMs` + `dataVersion`；运行时 `placedAtMs` 晚于快照的订单被排除并记 `NEW_ORDERS_EXCLUDED`；页面版本前进另记 `DATA_VERSION_CHANGED` / `DATA_VERSION_DRIFT` |
| 只读可见内容 | 不读 `__SITE_BOOT__`、不调 `/api`；采集器还注册了 `page.route('**/api/**')` 拦截，任何页面侧 API 请求会被 abort 并记 `API_ACCESS_BLOCKED` |
| 登录过期暂停后补采 | 列表滚动中或明细等待中一旦出现过期页立刻暂停并落盘；重跑自动经页面登录表单登录，只处理 `pending/failed` 订单 |
| 重复执行沿用进度 | 批次 id = `sha256(站点地址|开始日期|结束日期)`；同范围重复建批会复用原批次与原进度；已核对订单不会再采 |
| 截图 | 每张订单明细核对后截一张 `#detail-card`；失败再截 `-failed.png`；路径相对截图根目录入库 |
| 导出 | CSV（UTF-8 BOM）+ `summary.json` + 截图打包成 `<batchId>.zip` |

## 架构

```
src/
  shared/       页面契约（data-* 约定、排序口径、行高）、确定性演示数据、金额/明细核对、订单排序
  server/       Express：站点页面 + boot 一次性脚本、操作台 API、批次/进度/异常 SQLite 持久层、导出
  scraper/      Playwright：浏览器启动、页面读取（dom.ts）、列表滚动采集（list.ts）、批次运行器（runner.ts）
  web/          React：site（登录/列表/明细/演示控制台）与 console（采集操作台）
test/
  unit.test.ts  数据确定性、金额解析、明细核对各条规则、排序、批次标识
  e2e.test.ts   真起站点+操作台，真开 Chromium：全量采集、去重、截图、导出、快照排除新订单、过期暂停与补采、进度复用
```

## 测试

```bash
npm run typecheck
npm test           # 单元 + e2e
npm run test:unit
npm run test:e2e
```

e2e 使用临时 SQLite 与临时截图/导出目录，监听随机端口，结束后清理；不需要预先启动服务。

## 容器内运行 Chromium

在缺少图形库的精简容器里，Chromium 可能报 `libglib-2.0.so.0: cannot open shared object file`。
`src/scraper/browser.ts` 会在 `LD_LIBRARY_PATH` 里附加仓库内的 `.runtime/browser-deps`，并在存在 `.runtime/fonts.conf` 时用该字体目录（含中文字体），
因此无需 root 安装系统包。若你的环境已有完整依赖，这些路径会被自动忽略；`.runtime/` 属于本机运行产物，不入库。

## 已知边界

- 演示数据由固定 seed 生成，站点重启即回到初始快照；生产场景应把数据版本与快照落到真实数据源。
- 「到底提示」是页面明确的契约，采集端不会仅凭滚动条位置判断完成。
- 采集端只读页面文本，金额一律按「分」整数核对；页面出现无法解析的金额会判失败而不是静默跳过。
