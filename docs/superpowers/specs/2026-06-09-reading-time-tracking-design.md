# 阅读时长记录与统计页 — 设计

- 日期：2026-06-09
- Issue：[#73](https://github.com/EurFelux/marginalia/issues/73) Track reading time per book
- 类型：enhancement · area:reader · area:library · area:ui

## 目标

记录用户的实际阅读时长，并提供一个**独立的统计页**展示：总览数字（总时长 / 今日 / 近 7 天）、每日时长柱状图、连续阅读天数（streak）、各书时长排行。

为承载统计页，引入一次**顶层导航重构**：模仿 Apple Books，在 reader 之外用顶部 **pill 式标签条**在「书库 / 统计」间切换；进入 reader 则整条标签隐藏、全屏沉浸阅读。

## 非目标（YAGNI）

- **不**记录会话级（intra-day）明细：不建 `reading_sessions(start, end)` 表。v1 全部部件（总览 / 柱图 / streak / 排行）都能由「按天聚合桶」满足；明细将来需要时再加。
- **不**做空闲超时暂停：用户明确要求保守——只在窗口失焦 / 系统休眠锁屏时暂停。沉思、慢读照常计入。
- **不**做目标设定、提醒推送、streak 通知。
- **不**做时区漂移修正（单用户、跨时区旅行属边缘，忽略）。
- **不**做阅读时长的手动编辑 / 导出。
- **不**引入图表库：柱状图手绘 `div` + Tailwind。
- **不**支持多窗口（应用单窗口）。
- **不**做按章计时。

## 一、顶层导航重构

### 现状

- `navigation-store`：`view: "library" | "reader"`。
- `App.tsx`：`view === "reader" ? <ReaderView/> : <LibraryView/>`。
- `LibraryView` 自带 `<header>`（左标题、右「导入」+「设置」按钮）。

### 目标结构

- `navigation-store` 的 `view` 改为 `"library" | "stats" | "reader"`，新增 `showLibrary()` / `showStats()` action；`openBook` 仍切到 `reader`，`backToLibrary` 仍回 `library`（从书库开书、读完返回书库符合直觉）。
- `App.tsx`：`view === "reader" ? <ReaderView/> : <AppShell/>`。
- 新 **`AppShell`**（`src/renderer/shell/AppShell.tsx`）：渲染顶栏 `ShellHeader` + 当前 tab 内容（`view === "stats" ? <StatsView/> : <LibraryView/>`）。
- 新 **`ShellHeader`**：
  - 左：品牌字 `Marginalia`（`font-serif`，复用原 `library.title`）。
  - 中：pill 分段控件 `( 书库 | 统计 )`，激活态白底浮起；点击 → `showLibrary()` / `showStats()`，激活态由 `view` 派生。
  - 右：**全局** `⚙设置` 图标（`openSettings(true)`）。
- **`LibraryView` 改造**：删除自带 `<header>`；**导入按钮移入内容区顶部工具条**（右对齐，左侧可放「共 N 本」计数）；设置按钮移除（已上移到 `ShellHeader`）。拖拽导入逻辑不变。
- **reader** 全屏接管，不渲染 `AppShell` / 标签条（现有 reader 顶栏不变）。

> pill 用既有 shadcn(Base UI) 体系实现（见 [[shadcn-base-ui-setup]]）；激活态切换是命令式无需特殊处理，纯按 `view` 渲染。

## 二、数据模型

新增 `reading_daily` 表（按 书 × 本地日期 累计秒数）：

```ts
export const readingDaily = sqliteTable(
  "reading_daily",
  {
    id: pkUuid(),
    // 删书保留时长历史：FK set null（而非 cascade）。bookId 置空后该行仍计入
    // 总时长 / 每日柱图 / streak，仅「各书排行」不再列它。
    bookId: text("book_id").references(() => books.id, { onDelete: "set null" }),
    day: text("day").notNull(), // 本地日期 'YYYY-MM-DD'
    seconds: integer("seconds").notNull().default(0),
  },
  (t) => [
    unique("reading_daily_book_day_unique").on(t.bookId, t.day),
    index("reading_daily_day_idx").on(t.day),
    index("reading_daily_book_id_idx").on(t.bookId),
  ],
);
```

设计要点：

- **代理 `id` 主键 + `UNIQUE(bookId, day)`**：因 `bookId` 可空（删书 set null），不用复合主键。SQLite 中 UNIQUE 视多个 NULL 为相异 → 删多本书后同一天可有多行 `bookId=null`，求和不受影响。
- 累计只发生在「当前打开的书」（必存在），故 upsert 永远以非空 `bookId` 命中 `(bookId, day)`；`null` 仅由删书 set null 产生。
- `day` 用**本地日期**字符串（flush 时按当时系统本地日推导）。
- 迁移：`pnpm db:generate` 生成，预期为新建表 + 索引（additive，无表重建）。

## 三、主进程「阅读时钟」服务

### 3.1 纯状态机 `src/main/stats/clock.ts`（可注入时钟，无 Electron 依赖）

状态：

- `currentBookId: string | null` —— 渲染层上报（进 / 出 reader）。
- `isFocused: boolean` —— 窗口聚焦。
- `isAwake: boolean` —— 系统未休眠 / 未锁屏。
- `activeSince: number | null` —— 当前活跃段起点（ms）。

派生：`active = currentBookId != null && isFocused && isAwake`。

接口（全部接受注入的 `now: number` 与持久化 sink `addSeconds(bookId, day, seconds)`）：

- `setReadingBook(bookId | null)` / `setFocused(bool)` / `setAwake(bool)`：更新状态，并在 `active` 翻转时结算。
- `tick()`：周期 flush——若仍 active，结算 `now - activeSince` 并把 `activeSince` 重置为 `now`。
- 结算逻辑：把 `floor((now - activeSince)/1000)` 秒加到 `(currentBookId, localDayKey(now))` 桶；跨午夜由「每次按 `now` 重算 dayKey」自然切分（周期 tick 保证误差 ≤ 一个 tick 间隔）。

常量：`FLUSH_INTERVAL_MS = 60_000`。

`localDayKey(ms): string` —— 纯函数，由本地时间拼 `YYYY-MM-DD`（单测注入固定时间戳验证）。

### 3.2 胶水层（接触 Electron）`src/main/stats/clock-wiring.ts`

- 监听 `mainWindow.on("focus"/"blur")` → `setFocused`。
- 监听 `powerMonitor` 的 `suspend`/`resume`、`lock-screen`/`unlock-screen` → `setAwake`（`lock-screen` 仅 macOS/Windows，缺失时 `suspend` 兜底；记为平台差异）。
- `setInterval(tick, FLUSH_INTERVAL_MS)`。
- `app.on("before-quit")` 与窗口关闭：`tick()` 收尾 flush。
- 窗口 reload（`did-finish-load`）：`setReadingBook(null)` 复位，防陈旧（渲染层重挂后会重新上报）。
- sink = 写 `reading_daily`（见 3.3）。

### 3.3 仓储 `src/main/stats/reading-daily.ts`（接触 DB / `:memory:` 单测）

- `addSeconds(db, bookId, day, seconds)`：`(bookId, day)` upsert 累加。
- `dailyTotals(db) → { day, seconds }[]`：`Σ seconds GROUP BY day`（**含 `bookId=null` 行**，跨全历史全部书），喂给 `aggregate.ts`。
- `perBookTotals(db) → { bookId, title, author, seconds }[]`：`Σ seconds GROUP BY bookId` `JOIN books`，**仅现存书**（`bookId IS NOT NULL` 且 join 命中），按 `seconds` 降序——直接即 DTO 的 `perBook`，不经纯函数（因含 join）。

### 3.4 聚合纯函数 `src/main/stats/aggregate.ts`（纯数组单测，无 DB）

输入 = **全历史** `{ day, seconds }[]`（来自 `dailyTotals`，已按天对全部书求和）+ `dailyDays` + 注入的 `today: string`（参考日，便于单测）。产出 `ReadingStatsDto` 中除 `perBook` 外的全部字段：

- `totalSeconds` = Σ（全历史）。
- `todaySeconds` = `today` 当天合计。
- `weekSeconds` = **滚动近 7 天**（`today` 及前 6 天）之和。
- `daily` = 近 `dailyDays`（默认 30）天，**升序、零填充**缺失日（仅此字段受窗口约束；上面三项均算全历史）。
- `currentStreak` / `longestStreak`：以「当天合计 ≥ `STREAK_MIN_SECONDS`（=60）」为「读过书的一天」。
  - `currentStreak`：锚点 = `today`（若达标）否则昨天；锚点不达标则 0；否则自锚点向前数连续达标天数（昨天达标即视为「streak 仍存活」，宽限今日未读）。
  - `longestStreak`：历史所有达标日的最长连续段。
- `readingDays` = 达标日总数（展示「累计阅读天数」）。

`statsGet` 处理器组装：`dailyTotals` → `aggregate(rows, dailyDays, localDayKey(now))` ⊕ `perBookTotals` → `ReadingStatsDto`。

## 四、IPC 契约（`src/shared/stats.ts` + 注册进 `ipc.ts`）

```ts
// 渲染层 → 主进程：进 / 出 reader（含「设置弹窗遮挡 reader」时上报 null）
export const statsReadingStateInput = z.object({ bookId: z.string().min(1).nullable() });
// 统计页一次性取数
export const statsGetInput = z.object({
  dailyDays: z.number().int().positive().max(366).optional(),
});

export interface ReadingStatsDto {
  totalSeconds: number;
  todaySeconds: number;
  weekSeconds: number; // 滚动近 7 天
  currentStreak: number;
  longestStreak: number;
  readingDays: number;
  daily: { day: string; seconds: number }[]; // 升序、零填充
  perBook: { bookId: string; title: string | null; author: string | null; seconds: number }[];
}
```

- `statsReadingState`：`invoke` 返回 `void`（与 `progress:save` 同款；本地亚毫秒，无需 event 单向）。
- `statsGet`：`invoke` 返回 `ReadingStatsDto`。
- 在 `C`（契约单一源）注册两条；`preload.ts` 暴露 `window.api.stats.{ readingState, get }`。

## 五、渲染层

### 5.1 阅读时钟上报 `src/renderer/reader/use-reading-clock.ts`

- ReaderView 内调用 `useReadingClock(bookId)`。
- 上报值 = `(bookId 存在 && 设置弹窗未打开) ? bookId : null`（设置弹窗遮挡 reader 时暂停——它属同窗口、主进程焦点判定无法区分，故由渲染层显式上报 null）。
- mount / 依赖变化即 `window.api.stats.readingState({ bookId | null })`；unmount 上报 `null`。失败仅 `log.warn`（吞错留痕，见日志规范）。
- 焦点 / 电源由主进程观测，渲染层不掺和。

### 5.2 统计页 `src/renderer/stats/StatsView.tsx`（纯展示）

- React Query `qk.stats(dailyDays)` → `window.api.stats.get(...)`；**`staleTime: 0` + `refetchOnMount`**（看统计页时不在 reader、不再累计，无需轮询；切到该 tab / 重挂时取最新即可。对照 [[rq-stale-infinity-derived-state]]：此处恰是「查看时已停止后台推进」，故不需 interval）。
- 子组件：`StatOverview`（3 数字）/ `DailyBarChart`（手绘 div bars，零值灰条）/ `StreakCard`（🔥 当前 / 历史最长 / 累计阅读天数）/ `BookRanking`（序号 + 书名作者 + 时长，降序）。
- 空状态：无任何记录时显示引导文案（「开始阅读后这里会出现你的统计」）。

### 5.3 时长格式化 `src/renderer/stats/format-duration.ts`（纯函数 + 单测）

- `formatDuration(seconds) → "12h 34m" | "47m" | "0m"`；单位经 i18n。

## 六、i18n

- 新增键：tab 名（`shell.tabLibrary` / `shell.tabStats`）、统计页各标签（总时长 / 今日 / 近 7 天 / 当前连续 / 历史最长 / 累计阅读天数 / 每日时长 / 各书时长排行 / 空状态）、时长单位（h / m）、导入按钮（沿用既有 `library.import`）。
- 跑 `pnpm i18n:extract` 同步主语言后补 en 翻译（注意 [[i18n-operational-gotchas]]：extract 先于 typecheck、键改结构先清 en、`i18n:lint` 漏报用 grep 复核）。

## 七、测试

- `clock.ts`：状态翻转结算、focus/power 门控、周期 tick、跨午夜按 dayKey 切分、收尾 flush（注入时钟 + 假 sink）。
- `aggregate.ts`（纯数组）：total/today/week、streak（今日达标 / 仅昨日达标宽限 / 断档 / 阈值边界 59 vs 60s）、daily 零填充与升序、daily 窗口不影响 total/streak。
- `reading-daily.ts`（`:memory:`）：`addSeconds` upsert 累加；`dailyTotals` 含 `bookId=null` 行；`perBookTotals` 降序排序、删书后 `bookId` set null 且 seconds 保留并仍计入 `dailyTotals`、`perBookTotals` 排除已删书。
- `localDayKey` / `formatDuration`：边界值。
- 主进程纯函数为主，沿用 `:memory:` SQLite。

## 八、迁移与验证

- `pnpm db:generate` 生成 `reading_daily` 迁移（additive）。
- `pnpm typecheck && pnpm test && pnpm lint`。
- dev 冒烟（`pnpm start`，按 [[dev-prod-data-isolation]] 用 dev userData）：开书读一会 → 切「统计」tab 见今日时长增长、柱图当天有值；切到别的 app 再回来验证失焦不计；reader 内确认无标签条；导入按钮在书库内容区可用；删一本书后统计页 total/streak 不变、排行不再列它。

## 九、范围与拆分

单一计划即可实现，建议分阶段：① DB 表 + 迁移 → ② 主进程 clock/aggregate/repository + IPC → ③ shared 契约 + preload → ④ 导航重构（AppShell/ShellHeader/navigation-store/LibraryView 改造）→ ⑤ StatsView UI → ⑥ i18n → ⑦ 测试贯穿。
