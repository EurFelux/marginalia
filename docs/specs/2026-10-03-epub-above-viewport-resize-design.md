# ePub 视口上方 section 的异步高度变化 — Design

**Issue:** #115
**Date:** 2026-10-03
**Source:** #115 排查（CDP 复现，隔离书库副本）；用户决策 2026-10-03（先原型验证 D1，失败后改 D2）
**前置:** `2026-10-03-epub-reflow-reanchoring-design.md`（同一 issue 的前一项）

## 1. 背景

现象：往回滚动时偶发整体跳动。复现：「思考，快与慢」恢复到第 62 个 section 后，连续向上滚 40 步（每步 120px），第 23 步内容多移动 204px（另一次 460px）。main（ddd7fc5）同样复现。

逐 100ms 追踪出事那一步，一个新挂载的上方 section 的高度分**两个阶段**变化：

1. **挂载**：virtuoso 对没渲染过的 item 按 600px（首个探测 item 的占位高）估算，实际以估高（如 4508px）出现。virtuoso **补偿了**，scrollTop 恰好调整 3903px。
2. **约 100ms 后测得真高**（4692px，图片 / 字体就绪后的 `reportStable`）。virtuoso **没有补偿**，内容整体下移。

根因在 react-virtuoso 4.x 的 upward scrolling compensation，即它对视口上方 item 尺寸变化的补偿：

- 只在 `scrollDirection === "up"` 时补偿；**最后一次滚动事件 50ms 后方向被重置为 `none`**。section 的真高往往在滚动停下后才到，没人补偿。阅读中停着不动时，上方 section 晚到的高度（图片解码、字体、重测）也是同一机制，是「自己跳」的潜在来源。
- 方向由内部累加器计算：它自己 `scrollBy` 后 200ms 内冻结方向；**这期间任何滚动事件都会把冻结的 `up` 重新发出**（对外的 `none` 只是重置了输出值，累加器里仍是 `up`）。
- 补偿决策发生在它内部 listState 更新时，晚于 ResizeObserver，不与尺寸变化同步。

## 2. 目标与非目标

**目标**：视口上方 section 的异步高度变化不再造成可见的位移，包括往回滚时与静止阅读时。

**非目标**：

- **视口顶部那个只露出一部分的 section**：它自身的高度变化可能发生在视口线以上或以下，无法区分，维持现状。
- **触摸滚动**：看不出方向，见 §5 局限。
- **不替换 virtuoso**。

## 3. 方案（D2）：上方 section 的新高度先暂存，等 virtuoso 会补偿时再写

不和 virtuoso 抢补偿，而是只在它**一定会补偿**的时刻改变上方内容的高度：用户往上滚的时候。

### 3.1 所有 iframe 高度写入都经 `VirtualDocs.writeHeight`

`SectionFrame` 不再直接写 `iframe.style.height`，三处写入（`onLoad` 的估高占位、`reportStable` 的稳定高度、`measure()` 的重测）都改调 `writeHeight(index, iframe, px)`：

- section 整段位于视口线以上（外层元素 `bottom <= scroller.top + 1`）：**暂存**到 `pendingHeights`，不写 DOM。
- 否则立即写入，并清掉该 section 的暂存项。

`onMeasured` 照常立即回报，测高缓存与「栏宽变化是否真的重排」的判定不受影响。

### 3.2 何时写入暂存的高度

- **用户往上滚的输入**（滚轮 `deltaY < 0`、↑ / PageUp / Home / Shift+空格，复用 `isUpwardScrollIntent`）：在输入事件里同步写入，此时浏览器尚未滚动。随后的上滚事件让 virtuoso 把这批尺寸变化当作上滚期间的变化补偿掉。
- **section 不再位于视口上方**（跳转、重排等使其进入视口）：在 `recomputeTop`（滚动节流与 IntersectionObserver 都会触发）里检查并立即写入。
- **section 已卸载**：直接丢弃暂存项。真高已在测高缓存中，重挂时以它为初始高度。

上方内容不可见，暂用旧高度没有影响。

### 3.3 堵住两条绕过暂存的写入路径

- **iframe 的 React `style.height` 只取首次渲染的估高**（`useRef(estimatedHeight).current`）。原先它随 prop 变化：测得真高写入缓存后，下一次 virtuoso 重渲由 React 直接写 DOM，在任意时刻造成无补偿的位移。原型阶段连续快滚测试时常差 204px，根源就在这里。
- **未测量 section 的估高在首次算出时冻结**（`frozenEstimates`）。`calibratedEstimate` 随已测样本漂移，占位高度若在挂载后改变，同样是无补偿的位移。测得真高后以缓存为准；`styleCss` 变化时与缓存一起清空。

## 4. 备选方案（已否决）

- **D1：写入时自己补偿滚动**。原型试了两版，都失败：
  1. 经 virtuoso 句柄 `scrollBy` 补偿：其滚动事件把 virtuoso 冻结的 `up` 重新发出，它再补一次（实测多补 204～460px）。
  2. 在 rAF 里直接写 scrollTop 补偿：rAF 在本帧滚动事件派发之后、布局之前，本以为能让 virtuoso 看不到方向变化。但它的补偿决策晚于 ResizeObserver，且它自身补偿后 200ms 内任何滚动都会复活 `up`，仍会重复补偿。

  结论：抢补偿只能依赖 virtuoso 内部时序的巧合，不可靠。

- **D3：事后检测「无用户滚动、内容却移动了」再纠正**。会有一帧可见的闪动，且要区分用户滚动与两种补偿滚动，判定复杂。
- **`heightEstimates` prop**：virtuoso 只在尺寸树为空时（初始化）应用一次，对随后校准变化的估高无效。

## 5. 局限

- **触摸滚动**看不出方向，不触发暂存写入；暂存项要等 section 进入视口才写，那一刻可能有位移（桌面端触控板产生的是滚轮事件，不受影响）。
- **依赖 virtuoso 在用户上滚时的补偿**。挂载阶段的补偿在所有追踪中都精确，原型也已验证暂存写入后的补偿是精确的（§6）。若日后升级 virtuoso，需重跑 §6 的回路。

## 6. 验收

无现成的组件 / 端到端测试接缝：这条路径依赖真实布局、ResizeObserver 与 virtuoso 内部时序，headless 单测无法复现。回归由 #115 的 CDP 探针覆盖，隔离书库副本，两本书：「钢铁是怎样炼成的」（超长 section）、「思考，快与慢」（常规 section）。

| 回路                                                    | 操作                                                    | 通过标准                     | 修复前             |
| ------------------------------------------------------- | ------------------------------------------------------- | ---------------------------- | ------------------ |
| `wheel --dir up`                                        | 恢复后向上滚 40 步 × 120px，逐步量                      | 每步内容恰好移动 120px（±3） | 第 23 步多移 204px |
| `burst`                                                 | 向上连滚 30 × 100px，间隔 400 / 30 / 10ms，停 1.5s 后量 | 总位移 = 3000px              | 误差 204～460px    |
| `burst --then`                                          | 连滚停下后再上滚 40px（触发暂存写入）                   | 恰好移动 40px                | —                  |
| `firstwheel` / `wheel --dir down` / 重排矩阵 / `inject` | 前几项修复的回路                                        | 保持 PASS（回归）            | —                  |
