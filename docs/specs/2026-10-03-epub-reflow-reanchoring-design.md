# ePub 重排后重新对齐阅读位置 — Design

**Issue:** #115
**Date:** 2026-10-03
**Source:** #115 排查（CDP 复现，隔离书库副本）；用户决策 2026-10-03（「原则上不用特别精确，但不能差太多」）
**前置:** `2026-08-05-reader-position-state-machine-design.md`（本文在其两台状态机上加事件，不改结构）

## 1. 背景

#115 的排查结论：**存盘的是内容位置（CFI），但阅读中的真相源是像素 scrollTop**。每次滚动后，`onTopSectionChange` 由「视口顶部像素处的段落」反推出 CFI 并存盘。排版一变，scrollTop 不动、底下的内容却换了，反推出的 CFI 就忠实记下了错误内容；下次开书「准确地」恢复到错误位置。

已修：明暗主题切换（a0e67d5，主题改走不重载的 `paintCss` 通道，不再触发重排）。

仍未修（本文范围），复现命令见 §7：

- **栏宽变化**：缩放窗口；窗口较窄时开关侧栏 / AI 面板。实测 1440→1100 宽后，目标段落被推到视口顶下方约 31000px。
- **排版偏好变化**：字号、行距、栏宽偏好、正文字体。这些进 `styleCss`，会让全部 iframe 重载、高度缓存清空，机制与主题 bug 相同。

PDF 无此问题：页高变化时 `PdfReader.tsx:370-412` 已按「页码 + 页内比例」重算 scrollTop。

## 2. 目标与非目标

**目标**：上述两类排版变化之后，视口回到变化前阅读的那一段；重新对齐期间不把中间位置存盘。

**精度**：段落级。对齐到「变化前视口顶部那一段」的段首，误差 = 变化前视口顶已读过的那部分段落，通常几行，最多一段。

**非目标**：

- **不做字符 / 行级锚定**。用户明确不要求特别精确。
- **不做持续的滚动锚定**（自己实现浏览器的 scroll anchoring，每次布局变化当帧补偿）。它能覆盖更多触发源，但要和 virtuoso 自己的高度补偿（它把原生 `overflow-anchor` 关掉了）精细配合，复杂度与收益不匹配。若日后观察到「当前 section 内图片晚加载导致跳动」，再单独评估。
- **不改 `styleCss` 走重载的机制**。排版偏好变化本来就要重排，iframe 重载后由恢复收敛对齐即可。
- **不缩短 6 秒收敛窗口**。留给 #115 后续项。

## 3. 方案：把重排当作一次「恢复到当前位置」

复用开书恢复的全套机制：`restoring` 态（不存盘）+ `restoreToCfi`（`scrollToSectionElement` 按元素收敛对齐）。新增的只是「何时发起」与「对齐到哪」。

### 3.1 VirtualDocs：上报重排

新增 prop：

```ts
/** 正文重排时回调：styleCss 变化，或滚动容器宽度变化且确实引起了重排。消费方据此重新对齐阅读位置。 */
onReflow?: (reason: "style" | "width") => void;
```

- `style`：在现有的 `styleCss` effect（清空 `heightCache` 的那个）里一并回调。effect 执行时新 srcDoc 尚未载入完成、各 iframe 仍保持原高度，视口内容还没变，消费方手里的位置仍是变化前的。
- `width`：scroller 上挂 `ResizeObserver`，**只比较宽度**，首次观测不算；高度变化（如收起顶栏）不重排正文。宽度变化后开一个 1 秒的窗口，窗口内**有已挂载 section 重测出不同高度**才上报（每个窗口至多一次）。理由：宽窗口下开关 AI 面板时，滚动容器变窄了，但正文栏被 `maxWidth` 卡住、文字并未重排。此时若照样对齐，会把视口无谓地拽回段首，而「选字问 AI」会自动打开面板，这是高频操作。
- 「重测出不同高度」的信号来自 `SectionFrame` 的 `measure()`（就绪后 `ResizeObserver` 触发的重测路径）：高度确有变化时经 `onMeasured` 回报。顺带修掉 #115 的另一项：此前 `measure()` 只改 DOM、不回写 `heightCache`，section 重挂时会先按旧高度占位再跳到真高。

`virtual-docs` 仍不认识 CFI / 进度，包边界不变。

### 3.2 阅读位置机：`REFLOWED` 事件

`following` 态改为携带最近一次位置：

```ts
| { kind: "following"; last: { cfi: string; index: number } | null }
```

| 事件                                                   | 迁移                                                                                                  |
| ------------------------------------------------------ | ----------------------------------------------------------------------------------------------------- |
| `TOP_SECTION_CHANGED`（`following` 下）                | 照旧 report + persist，并把 `last` 更新为该位置（`cfi` 为 null 时保留旧值）                           |
| `REFLOWED`（`following` 且 `last` 非空）               | → `restoring { targetIndex: last.index, locator: last.cfi }` + `restoreToCfi`                         |
| `REFLOWED`（`restoring`）                              | 忽略：进行中的收敛每 100ms 按目标元素的**当前**位置重测、重发定位，本身就能适应重排（含 iframe 重载） |
| `RESTORE_FINISHED`（`restoring`）                      | → `following`，`last` 设为恢复目标（原为不带数据的 `following`）                                      |
| `REFLOWED`（`loading`，或 `following` 但 `last` 为空） | 忽略                                                                                                  |

其余迁移不变。要点：

- **锚点取变化前的位置**：`restoring` 期间既不更新目标也不响应 `REFLOWED`，所以拖动窗口时连发的重排始终对齐到拖动开始前的那一段，不会被中间帧带偏。
- **不存盘**：复用「只有 `following` 才持久化」这一既有不变量，重排的中间位置不会写库。debounce 到期时重读状态的保护照旧生效。
- **用户可随时抢占**：收敛中用户滚动 → `USER_INPUT` 取消收敛 → `RESTORE_FINISHED(cancelled)` → `following`，与开书恢复一致。
- **恢复结束即有锚点**：收敛 settled 时视口里的 `TOP_SECTION_CHANGED` 发生在 `restoring` 内（不记录），若 `following` 从 `last: null` 起步，「刚开书、还没滚动就开关面板」会因无锚点而被忽略。故 `RESTORE_FINISHED`（三种结果）与 `USER_NAVIGATED`（从 `restoring` 来）都把恢复目标作为 `last`；用户随后的滚动会立即覆盖它。
- 其余进入 `following` 的路径（`SESSION_READY` 无进度、目录 / 标注 / 搜索跳转）带 `last: null`：跳转后视口去了别处，沿用跳转前的锚点会把跳转撤销；下一次 `TOP_SECTION_CHANGED` 填上。

### 3.3 EpubReader

`<VirtualDocs onReflow={() => raise({ type: "REFLOWED" })} />`。reason 只用于日志（`log.debug`），不影响迁移。

## 4. 与现有行为的交互

- **TTS**：重排对齐不算用户导航，不打断朗读。TTS 自己的跟随滚动会因 scroll 事件挂起跟随，与现状相同。
- **跳转中重排**（跳章收敛中缩放窗口）：跳转已把状态推到 `following`；重排以最近一次 `TOP_SECTION_CHANGED` 为锚，新一轮 `ALIGN_REQUESTED` 取消跳转那一轮。极端情况下锚点会落在跳转途中的位置，可接受（「不能差太多」：仍在目标附近）。
- **视口机**：`restoreToCfi` 用 `owner: "restore"`，不置 `everUserNavigated`，与开书恢复一致。

## 5. 备选方案（已否决）

- **持续滚动锚定**：见 §2 非目标。
- **字符级锚点**（`caretRangeFromPoint` 记住视口顶那一行）：需要给 `scrollToSectionElement` 扩展 Range 目标、在 iframe 重载后按文本偏移重建 Range。用户不要求这个精度。
- **在 EpubReader 里自己 diff `styleCss` / 自挂 ResizeObserver**：可行，但「正文重排了」是 VirtualDocs 的通用事实，它本就在 `styleCss` 变化时清缓存，放在包里只需一处。
- **宽度一变就上报**：会在文字没有重排时（正文栏被 `maxWidth` 卡住）把视口拽回段首，见 §3.1。
- **恢复中重排时对同一目标重发 `restoreToCfi`**：新一轮 `ALIGN_REQUESTED` 会以 `cancelled` 兑现上一轮的 Promise，迟到的 `RESTORE_FINISHED(cancelled)` 会把 `restoring` 提前推回 `following`、提前恢复存盘。进行中的收敛本就逐 tick 重测，无需重发。

## 6. 文件落点

| 动作 | 文件                                                                                                                     |
| ---- | ------------------------------------------------------------------------------------------------------------------------ |
| 改   | `packages/virtual-docs/src/VirtualDocs.tsx`：`onReflow` prop、宽度 `ResizeObserver` + 重测窗口、`styleCss` effect 内回调 |
| 改   | `packages/virtual-docs/src/SectionFrame.tsx`：`measure()` 高度变化时经 `onMeasured` 回报                                 |
| 改   | `src/renderer/reader/reading-position-machine.ts` + `.test.ts`：`following.last`、`REFLOWED`                             |
| 改   | `src/renderer/reader/EpubReader.tsx`：接线                                                                               |

## 7. 验收

**单测**（`reading-position-machine.test.ts`）：

- `following` + `TOP_SECTION_CHANGED` 记录 `last`；`cfi` 为 null 时保留旧值。
- `following`（有 `last`）+ `REFLOWED` → `restoring`，产出指向 `last` 的 `restoreToCfi`，且不产出 `persistProgress`。
- `restoring` + `REFLOWED` 无效果；`restoring` 期间的 `TOP_SECTION_CHANGED` 不改变目标。
- `RESTORE_FINISHED`（三种结果）/ `USER_NAVIGATED`（自 `restoring`）→ `following`，`last` 为恢复目标；跳转进入的 `following` 为 `last: null`。
- `loading` / `following(last: null)` + `REFLOWED` 无效果。

**端到端**（#115 的 CDP 探针，隔离书库副本；两本书：「钢铁是怎样炼成的」超长 section、「思考，快与慢」常规 section）：

| 回路           | 操作                                                                | 通过标准                                                                   |
| -------------- | ------------------------------------------------------------------- | -------------------------------------------------------------------------- |
| `resize`       | 稳定阅读后视口 1440→1100 宽                                         | 收敛后：顶部 section 不变，变化前那一段的段首距视口顶 ≤ 8px；进度 CFI 不变 |
| `font`（新增） | 稳定阅读后字号 +20%                                                 | 同上                                                                       |
| `panel`        | 1440 宽下先滚到段落中间，再开关 AI 面板（正文栏被 `maxWidth` 卡住） | 视口不动：变化前那一段的偏移不变（±2px），不被拽回段首                     |
| `theme`        | 切换明暗                                                            | 保持 PASS（回归）                                                          |
| `inject`       | 冷启动恢复                                                          | 保持 PASS（回归）                                                          |

修复前 `resize` 已确认失败；`font` 回路先在修复前跑一次，确认会失败。
