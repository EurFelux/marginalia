# Reader Auto-Scroll — Design

**Issue:** #114
**Date:** 2026-10-03
**Source:** 用户需求 2026-10-03（「阅读器里匀速滚动，以及滚动到底自动停止」）
**前置:** #115 的定位修复（`2026-10-03-epub-reflow-reanchoring-design.md`、`2026-10-03-epub-above-viewport-resize-design.md`，及「首次滚动跳屏」修复 53123b5）。用户决策 2026-10-03：先修 #115 再做本功能；本文按修复后的定位机制修订（§2 末三条、§3.3 重排一行、§5、§11）。

## 1. 目标与非目标

**目标**：阅读器正文按用户可调的恒定速度自动向下滚动（提词器式），解放双手连续阅读；滚到书末自动停止。ePub 与 PDF 都支持。速度持久化，重启沿用。

**非目标**：

- **不做「按页定时翻页」**。两种格式都是连续纵向滚动，没有分页模式；匀速连续滚动是唯一形态。
- **不按排版折算速度**。1.0× 对应固定的像素速度，不随字号 / 行距 / PDF 缩放变化；用户改了排版就凭体感重新调档。按排版把「阅读速度」折算成像素速度会引入一层用户看不见的换算，收益小。
- **不与朗读（TTS）联动**（如「滚动速度跟随朗读进度」）。TTS 已自带段级跟随滚动，两者互斥（§3.4）。
- **本版不加快捷键**（§9 Q3）。

## 2. 关键架构事实（实现据此）

- **两种格式都是 react-virtuoso 连续纵向滚动**，滚动容器都是 Virtuoso 的 scroller div：
  - ePub：`@marginalia/virtual-docs` 包裹 Virtuoso，每个 spine section 是一个 `scrolling="no"` 的 iframe，高度撑满内容；iframe **不内滚**，只滚外层 scroller。经 `VirtualDocsHandle.getScrollerElement()` 取。section 随滚动自动挂载/加载（2400px overscan），跨 section 直接改 `scrollTop` 即可，无需手动「下一章」。
  - PDF：`PdfReader` 内 Virtuoso 每页一项，`scrollerRef` 本地持有。
- **ePub 定位收敛会与逐帧滚动拉扯**：`viewport-machine` 的 `aligning` 阶段（进度恢复、跳章、标注/搜索跳转）每 100ms 检查目标元素与视口顶的偏差，>4px 就重发 `scrollToIndex` 拽回，至少持续 6 秒、最长 30 秒；**只有 `USER_INPUT` 能取消它**。程序化改 `scrollTop` 不产生 `USER_INPUT`。→ 自动滚动开始/继续时必须先「宣告用户接管视口」（§4.2），跳转发生时必须暂停（§3.3）。
- **ePub 进度只在 reading-position 状态机的 `following` 态落盘**；`USER_NAVIGATED` 会把 `restoring` 推进到 `following`。宣告接管时顺带触发它，自动滚动产生的位置才会存盘。
- **顶部预挂载只在「向上」输入后解锁**（#115，53123b5）：深处开书后视口机禁用顶部 overscan，直到 `USER_INPUT { upward: true }` 或用户级跳转。提前解锁会挂载上方 section，其迟到测高在 virtuoso 不补偿时推走正文（「首次滚动跳屏」的根因）。→ 宣告接管必须是 `upward: false`（§5）。
- **重排会发起一次对齐收敛**（#115）：栏宽变化且确实重排、或排版偏好（字号 / 行距 / 栏宽 / 字体）变化时，`VirtualDocs.onReflow` → reading-position 的 `REFLOWED` → `restoring` + `restoreToCfi`，即一轮 `owner: "restore"` 的 `aligning`。它与跳转后的收敛一样会和逐帧滚动拉扯。→ 重排时暂停（§3.3）。
- **视口上方 section 的高度变化暂存到用户上滚时再写**（#115，de9e3f0）：自动滚动只往下，滚出视口的 section 测得新高度时不写 DOM，不会造成无补偿的位移；用户手动上滚时由 virtuoso 补偿掉。自动滚动无需为此做任何事。
- **两个阅读器都在「任意滚动」时关闭选区工具条 / 样式栏 / 笔记悬浮卡**（document 捕获阶段的 scroll 监听）。自动滚动持续产生 scroll 事件 → 滚动中无法保住选区。→ 用户在正文按下鼠标时暂停（§3.3）。
- **VirtualDocs 已有用户输入探测**：scroller 与每个 iframe 文档上的 `wheel` / `touchstart` / `keydown` / `pointerdown` 都会回调 `onUserNavigation`（iframe 内事件不冒泡到父文档，这是唯一能观测到正文内输入的出口）。程序化滚动不触发它。
- **阅读器滚动条是隐藏的**（`no-scrollbar`），没有可拖动的 thumb，「手动滚动」只来自上述输入。
- **TTS 范式可直接复用**：模块单例控制器（命令式方法）+ zustand store 发布运行态（`tts-controller.ts` + `tts-store.ts`），浮动控制条 `TtsControlBar` 挂在 `ReaderView` 的 `<main>` 内底部居中。
- **偏好单一源注册制**（`src/shared/preferences.ts`）：新 key = `PREFERENCE_SCHEMAS` + `setPreferenceInput` arm + 主进程 handler case + 渲染层 store / hydrate + schema 同步测试。
- 渲染层纯 UI 行为，无主进程业务逻辑；主进程侧只有偏好持久化。

## 3. 交互设计

### 3.1 入口与控制条

- **顶栏开关按钮**：放在朗读按钮旁，lucide `ChevronsDown` 图标，ePub/PDF 都显示。空闲时点击 = 开始；运行/暂停中点击 = 停止，图标高亮（`text-primary`），同朗读按钮。
- **浮动控制条**（`AutoScrollControlBar`）：非空闲时显示，样式与位置照搬 `TtsControlBar`（正文区底部居中胶囊）。内容：暂停/继续、速度 `−` / 当前值 / `+`、停止。两者互斥，不会同时出现、不重叠。

### 3.2 速度

- **倍率档位 0.1×–2.0×，步长 0.1，默认 1.0×**（用户决策 2026-10-03）。控制条显示 `1.0×` 形式（同朗读语速的 `×` 后缀），`−` / `+` 各挪一档，两端夹住。
- **1.0× = 10 px/s，每档 1 px/s**。估算：默认排版（字号 100%、行距 1.9、栏宽 640）一行约 34px，中文 ~400 字/分 ≈ 6.5 px/s，英文 ~250 词/分 ≈ 12 px/s，故 1.0× 落在两者之间；0.1×–2.0× 覆盖 1–20 px/s。
- **全程整数，不用浮点**（用户决策 2026-10-03：浮点的微妙误差讨厌）。速度以**档位整数** 1–20 表示（10 = 1.0×），落盘、调档、换算都是整数运算；显示由整数拼出（`10` → `1.0×`），不经浮点除法。读出时夹到 [1, 20]。
- 运行中调速即时生效（逐帧读取当前档位）。

### 3.3 暂停 / 停止条件

| 事件                                                            | 行为                   | 理由                                                                                             |
| --------------------------------------------------------------- | ---------------------- | ------------------------------------------------------------------------------------------------ |
| 滚到书末                                                        | **停止**（控制条消失） | 需求本身                                                                                         |
| 开始时已在书末（或内容不足一屏）                                | 不启动                 | 无处可滚                                                                                         |
| 用户直接操作正文：滚轮 / 触控板 / 触摸 / 按键 / 按下鼠标        | **暂停**               | 用户接手了视口；按下鼠标多半是要选字，而滚动会不停关掉选区工具条                                 |
| 用户主动跳转（目录跳章、标注列表、搜索结果、PDF 页内链接）      | **暂停**               | ePub 的定位收敛会与逐帧滚动拉扯（§2）；PDF 同样暂停，两种格式行为保持一致                        |
| ePub 正文重排（缩放窗口、改排版偏好、窄窗口开关侧栏 / AI 面板） | **暂停**               | 重排对齐也是一轮收敛（§2）。触发者几乎都是用户自己的操作，与跳转同理；主题切换已不重排，不受影响 |
| 离开阅读器 / 换书                                               | 停止                   | 控制器随阅读器卸载 detach                                                                        |
| 开始朗读                                                        | 停止自动滚动           | 互斥（§3.4）                                                                                     |

暂停后点「继续」：重新宣告接管视口（会取消跳转后仍在进行的 ePub 定位收敛），从当前位置接着滚。

### 3.4 与朗读互斥

开始自动滚动时停止朗读，开始朗读时停止自动滚动。在 `ReaderView` 两个开关按钮的点击处理里各自先停掉对方，控制器之间不互相 import。

## 4. 滚动引擎（`src/renderer/reader/auto-scroll/`）

### 4.1 `auto-scroll.ts`（纯函数，vitest 覆盖）

- `advanceCursor(cursor, actual, pxPerSec, dtMs)`：逐帧位移常常不足 1px（10 px/s × 16ms = 0.16px）。**只写整数像素**，不足 1px 的部分以整数「像素·毫秒」余量 `carry` 结转（攒满 1000 进 1px），全部是整数加减与取余。
  - 自管整数位置 `position`，不基于回读值累加：回读值可能被取整或吸附到物理像素，基于它累加会把小数位移整段丢掉、低速时原地不动。
  - 回读值与 `position` 偏差 ≥1px 视为外部改动（虚拟列表测高修正、PDF 缩放复位、浏览器在书末夹住），以取整后的回读值为新基准、余量清零。不足 1px 的偏差（物理像素吸附）忽略。
  - 帧时长取整数毫秒：控制器先把 rAF 时间戳取整再相减，各帧的取整误差首尾抵消，不累积成速度偏差。
- `dtMs` 夹到 ≤100ms：窗口隐藏后 rAF 恢复的首帧间隔可达数秒，不夹住会一步跳出一大段。
- `isAtScrollEnd({ scrollTop, scrollHeight, clientHeight })`：容差 1px。Virtuoso 的 `scrollHeight` 是全列表（含估高）总高，只有真正的书末才会触底；末尾 section 在进入视口前 2400px 已挂载测高。
- `clampSpeedLevel` / `stepSpeedLevel`：档位夹到 [1, 20]；±1 档。
- `formatSpeedLevel(level)`：`10` → `1.0×`，整数商与余数拼接。
- `speedPxPerSec(level)`：档位 × 1 px/s。

### 4.2 `auto-scroll-controller.ts`（模块单例）

```ts
interface AutoScrollContext {
  getScroller: () => HTMLElement | null;
  /** 此刻能否接管视口；false 时先不滚动、逐帧重查（§5.1）。PDF 不需要。 */
  canClaimViewport?: () => boolean;
  /** 宣告用户接管视口；开始/继续后、首次滚动前调用。ePub 借此取消进行中的定位收敛。PDF 不需要。 */
  claimViewport?: () => void;
}
```

- `attach(ctx)` / `detach()`：阅读器挂载/卸载时调用（detach 内部 stop）。
- `start()` / `pause()` / `resume()` / `stop()`，`notifyUserNavigation()`（跳转 → 暂停）。
- 运行态 `idle | running | paused` 发布到 `useAutoScrollStore`（非持久化）。
- **rAF 循环**：每帧检查书末 → 尚未接管时查 `canClaimViewport`，可以则 `claimViewport` 后开始滚动，否则本帧不动 → 计算 `advanceCursor` → 写 `scroller.scrollTop`（整数）。档位每帧从 `usePrefsStore` 读。等待接管期间状态已是 `running`，输入监听已挂上，用户操作照常暂停。
- **用户输入暂停**：运行时在 scroller 上挂 `wheel` / `touchstart` / `keydown` / `pointerdown` 监听（与 VirtualDocs 的输入探测同一组），暂停/停止时摘掉。这覆盖 PDF 页面与 ePub 的 iframe 外区域；ePub iframe 内的输入不冒泡到父文档，由 `EpubReader` 的 `onUserNavigation` 转调 `pause()`。按键不区分是否滚动键（与 VirtualDocs 一致）：焦点在正文内时按键几乎只有滚动、复制、⌘F 三类，后两者暂停也合理。控制条在 scroller 之外，点它不会触发暂停。
- 暂停判定只看输入事件，**不**用「回读 scrollTop 与自管位置的偏差」：虚拟列表测高修正、图片迟到加载也会改 scrollTop，按偏差判定会误暂停。偏差只用来重定基准（§4.1）。

## 5. ePub 集成

- `VirtualDocsHandle` 新增 `claimViewport()`：raise `USER_INPUT { scrollIntent: true, upward: false }`，取消收敛、转 `userOwned`，效果同一次向下的真实滚动输入。
  - **`upward: false`**：自动滚动只往下，不需要上方预挂载；解锁会重现「首次滚动跳屏」（§2）。
  - **不 flush 暂存高度**：那是上滚专用（§2）。
  - **不回调 `onUserNavigation`**：后者在 `EpubReader` 里会暂停自动滚动，而 `claimViewport` 恰在开始/继续时调用；调用方自己知道这次接管，自行补上需要的副作用。
- `EpubReader`：book 就绪时 `attach({ getScroller, claimViewport })`，卸载时 detach（同 TTS 的 effect）。其中 `claimViewport = () => { vRef.current?.claimViewport(); raise({ type: "USER_NAVIGATED" }) }`，后者把 reading-position 推进到 `following`，使自动滚动的位置落盘。
- `EpubReader` 的 `onUserNavigation` 追加 `autoScrollController.pause()`（覆盖 iframe 内的四类输入）。
- `EpubReader` 的 `onReflow` 先 `autoScrollController.pause()` 再 raise `REFLOWED`。不经状态机 effect：重排对齐不算用户导航，不该打断朗读（见重排 spec §4），而 `notifyUserNavigation` 会停掉 TTS。暂停后点继续：`claimViewport` 取消尚未结束的对齐（`RESTORE_FINISHED(cancelled)` → `following`），从当前位置接着滚。
- reading-position 状态机的 effect `notifyTtsUserNavigation` 改名为 `notifyUserNavigation`，执行器里同时通知 TTS（停止）与自动滚动（暂停）。事件与迁移不变，只是改名。

以下两条来自端到端验证（§10），原稿未预见。

### 5.1 开始 / 继续时，等进行中的对齐先落位

**现象**：开书后立即开始自动滚动，恢复收敛被取消在目标落位之前，视口停在 section 开头，随后这个位置被落盘。实测「钢铁」从 `/4/1586` 退回 `/4/2`（section 首），阅读位置丢失。

**原因**：开书恢复先 `scrollToIndex` 到 section 顶，等 iframe 载入、能解析目标元素后才逐 tick 对齐。`claimViewport` 若发生在首次对齐之前，取消的是整个恢复，而不只是 6 秒收敛窗口的尾巴。

**方案**：`VirtualDocsHandle` 新增 `canClaimViewport()`：没有进行中的对齐，或其目标已对齐（`aligning` 且最近一次 tick 已对齐，即 `streak ≥ 1`）时为 true。判定写成 `viewport-machine` 的纯函数，可单测。控制器开始 / 继续后逐帧查它，true 时才 `claimViewport` 并开始滚动。

- **「已对齐」须目标未被 iframe 裁掉**（`measureAlignment` 增加 `offset < frame 高度`）：section 尚未撑到真高时，目标元素几何上可能已在视口顶，屏幕上显示的却是下一个 section。原判定会把它算作对齐，收敛靠后续 tick 自愈无妨，但接管判定不能信它。
- **等待接管期间不判书末**，接管那一刻再判：恢复半途列表总高仍是估算，视口可能被夹在底部，会被误判为书末而停止（端到端实测出现过）。
- 首次对齐之后再接管是安全的：#115 之后深处开书的顶部预挂载锁定、视口上方 section 的高度变化暂存，目标对齐后不会再被上方推走。剩下的 6 秒收敛尾巴取消掉无妨。
- 正常情况下等待在 1 秒内（目标 section 载入并对齐一次）。最坏情况由收敛上限兜底：30 秒后 `timeout`，`canClaimViewport` 变为 true。
- 跳转后、重排后的「继续」走同一判定。用户通常在看到结果后才点继续，此时早已对齐，不会感到等待。

### 5.2 栏宽变化窗口内，不上报视口顶位置（补 #115）

**现象**：自动滚动中缩放窗口，重排对齐落在错误的段落（「思考」偏 238px，「钢铁」偏约 2000px）。

**原因**：栏宽变化后，iframe 内的文字立即重排，但 section 高度要等重测（`ResizeObserver` → `measure()`），「确实重排了」的判定（`onReflow("width")`）也随之晚到，实测约 100ms，最长 1 秒。这段时间里只要有滚动（自动滚动每帧都在滚），`onTopSectionChange` 就会把重排后的视口顶段落上报，阅读位置机记成 `last`，随后 `REFLOWED` 对齐到这个已经错了的锚点。日志：缩放后 +30ms 出现一次 `TOP_SECTION_CHANGED`，+123ms 才 `REFLOWED`。

没有自动滚动时，这个窗口里通常没有滚动事件，#115 的 `resize` 回路因此通过。用户边拖窗口边滚动也会触发，但很少见。

**方案**（`VirtualDocs`）：宽度变化布防的窗口内（`widthReflowDeadline` 未到期），`recomputeTop` 不调 `onTopSectionChange`。

- 窗口内判定为重排：`onReflow` 照旧，阅读位置机按变化前的 `last` 对齐。
- 窗口到期而未重排（宽窗口下正文栏被 `maxWidth` 卡住）：到期时补一次 `recomputeTop(true)`，把当前位置补报上去。
- 拖动窗口时会连续布防，上报随之顺延，停手 1 秒后恢复。期间顶栏进度与当前章不更新，可接受。
- 重排 spec 已冻结，此项作为本文的补充，不回改旧 spec。

## 6. PDF 集成

- `PdfReader`：挂载时 `attach({ getScroller: () => scrollerRef.current })`，无 `claimViewport`（PDF 跳转是一次性 `scrollToIndex`，没有收敛重试）。
- 跳章、标注列表跳转、搜索跳转、页内链接四处调 `autoScrollController.notifyUserNavigation()`。
- Ctrl+滚轮 / 捏合缩放本身是滚轮输入 → 暂停。用顶栏 `PdfPrefs` 缩放不暂停：缩放复位改写 `scrollTop` → 偏差 ≥1px → 自动以新位置为基准，无需特判。

## 7. 偏好持久化

新增顶层 key `autoScrollSpeed: z.number().int().positive()`（档位整数，10 = 1.0×），出厂值 `DEFAULT_AUTO_SCROLL_SPEED = 10`（`@shared/preferences`）。schema 只校验正整数，上下限归渲染层夹住（同 `pdfZoom` 与 `clampPdfZoom` 的分工）。不并入 `readerPrefs`：后者只服务 ePub 排版并喂给 `prefsToCss`，而速度是两种格式共用的。

## 8. i18n

新增 `reader.autoScroll.*`：`start`（自动滚动）、`stop`（停止自动滚动）、`pause`、`resume`、`speed`（滚动速度）、`slower`、`faster`。`zh-CN` 为主语言，跑 `pnpm i18n:extract` 同步后补 `en`。

## 9. 已决议（用户 2026-10-03）

- **Q1 跳转后**：暂停（不继续、不停止）。继续的话 ePub 要等定位收敛结束（≥6 秒）才真正动起来，这段时间显示运行中但画面不动。
- **Q2 正文按下鼠标**：暂停。不暂停的话滚动中选字基本不可用。
- **补充（用户 2026-10-03）**：手动滚动（滚轮 / 触控板 / 触摸 / 按键）也暂停，与按下鼠标合并为「用户直接操作正文即暂停」。
- **Q3 快捷键**：本版不加。空格、方向键、PageUp/PageDown 目前都是原生滚动，占用会改变现有手感；以后单独加。
- **Q4 速度显示**：倍率档位 0.1×–2.0×，默认 1.0×（§3.2）。
- **全程整数**：速度档位与滚动位置都不用浮点（§3.2、§4.1）。
- **Q5 ePub 正文重排**：暂停（§3.3），不在对齐结束后自动继续。重排只由用户操作（改排版偏好、改变正文区宽度）引起，与跳转同理。

## 10. 测试

- **纯函数**（vitest）：`advanceCursor` 首帧取回读值、余量结转后低速也匀速前进、只产出整数、外部改动重定基准、亚像素吸附不误判、长帧夹住；`isAtScrollEnd` 触底 / 未触底 / 内容不足一屏；档位夹住、±1 档、显示格式。
- **控制器**（vitest，假 rAF + 假滚动容器）：匀速、调速即时生效、开始 / 继续时接管视口、不能接管时等待且不滚动、四类输入暂停、书末停止、无处可滚不启动、detach 停止并摘监听。
- **视口机**：`canClaimViewport` 在 `systemOwned` / `userOwned` / `aligning(streak ≥ 1)` 为 true，`aligning(streak = 0)` 为 false。
- **状态机**：`reading-position-machine.test.ts` 跟随 effect 改名。
- **偏好**：`preferences.test.ts` key 列表补 `autoScrollSpeed`。
- **端到端**（#115 的 CDP 探针，隔离书库副本，ePub 两本书）：
  - 匀速：1.0× 下运行 10 秒，位移 100px（±10%）；期间顶部 section 推进时不出现跳变（逐 100ms 采样，单步位移不超过 3px）。
  - 跨 section：把 section 末尾放在视口顶下方 150px，2.0× 运行 15 秒，顶部 section 推进且无跳变。
  - 刚开书（恢复收敛未结束）立即开始：从恢复目标起滚（开始滚动时目标段落距视口顶 ≤ 8px），不被拽回，落盘的位置在恢复目标之后（§5.1）。
  - 窗口 1440→1000 缩放（1100 时正文栏仍被 `maxWidth` 卡住、不重排）：自动滚动暂停，重排对齐到变化前那一段（段首距视口顶 ≤ 8px，同重排 spec 的 `resize` 回路，§5.2）。
  - 输入暂停：正文内滚轮 / 点击 / 按键、页边空白点击均暂停；点控制条不暂停。
  - 书末自动停止；在书末点开始不启动。
  - 顶栏开关与控制条（开始、调速显示、暂停 / 继续、停止）。
  - PDF：匀速，滚轮暂停。
- **手动验证**（`pnpm dev`）：ePub / PDF 各开一本 → 开始、调速、暂停/继续、滚轮 / 按键 / 正文点击均暂停（ePub 分别在 iframe 内与页边空白处试）、点控制条不暂停、跳章暂停后继续不被拽回、滚到书末自动停止、开朗读时自动滚动停止。

## 11. 局限

- **视口顶部那个只露出一部分的 section 自身高度变化**（图片晚到等）仍会让正文位移，#115 未处理（见上方 section 高度 spec §2 非目标）。自动滚动中表现为偶发的一次小跳，之后照常匀速。
