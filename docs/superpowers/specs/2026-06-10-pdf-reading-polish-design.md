# PDF 阅读打磨设计（精确恢复 · 笔记标记 · 滚轮缩放）

日期：2026-06-10
状态：已与用户对齐，待实现
关联：#43（PDF reading polish）三个子项；延续 PDF 轨（2026-06-06 设计 §11 的 deferred 项）

## 1. 背景与范围

PDF 轨 P1–P3 交付了完整阅读闭环，留下一批打磨项（#43/#45）。经代码核对（2026-06-10），本轮圈定三个高价值子项，均落在 `PdfReader.tsx` 的「滚动位置 / overlay」面，互有协同：

1. **③ 页内精确恢复**：进度恢复当前只到页级（`saveAt` 写死 `scrollRatio: 0`），重开书落页顶。
2. **④ 带笔记标注的视觉标记**：`hasNote` 已透传到 `HighlightRect` 但 overlay 渲染忽略它；ePub 已有点状下划线记号，PDF 缺 parity。
3. **① Ctrl+滚轮/触控板捏合缩放**：当前仅 PdfPrefs 档位按钮；spec §11 backlog 项。

**不在本轮**：按书关暗色反转（需 per-book 偏好持久化，工作量大，留下轮）、跨页 locatorRange、OCR、re-anchoring、AI 草稿切书隔离（#45 余项）。

## 2. 决策摘要

| 决策点           | 结论                                                                                                                                                               |
| ---------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| 缩放策略         | **光标锚点 + rAF 节流重渲**：每帧最多提交一次缩放、页面以新分辨率重渲（始终锐利）；不做手势中 CSS transform 预览（复杂度不值）                                     |
| 缩放触发         | 滚动容器 `wheel` 监听（`passive: false`），仅 `ctrlKey` 时生效——同一条件覆盖 Ctrl+滚轮与 macOS 触控板捏合（捏合事件 `ctrlKey=true`）                               |
| 缩放手感         | 乘性缩放 `target *= exp(-deltaY × SENSITIVITY)`；精确目标存 ref（不过 1% 取整，防慢速捏合被取整卡死）；提交时才 `clampPdfZoom`                                     |
| 竖向锚点         | 复用 ③ 的页内比例换算（页号 + 页内比例 → scrollTop），不受固定 16px 页缝影响                                                                                       |
| 横向锚点         | 尽力近似：缩放到点公式 `newScrollLeft = (oldScrollLeft + 光标X) × ratio − 光标X`；页居中↔溢出切换处略有偏差，可接受                                                |
| 精确恢复         | 存：`rangeChanged` 内从 `scrollTop` 算页内比例；恢复：`initialTopMostItemIndex` 换 `initialScrollTop`（全书同尺寸前提已被现有代码依赖，直接算精确、无挂载后跳动）  |
| 笔记标记语义     | 与 ePub 对齐：**有笔记 → 底边线变点状**；填充色照旧；`underline` 样式有笔记时实线底边换点状                                                                        |
| 笔记标记复用边界 | **policy 共享、mechanism 跟介质走**：`hasNote(note)` 谓词抽到 `highlight.ts` 供 ePub/PDF 共同消费；视觉实现保持两份（iframe 裸 CSS vs 主文档 Tailwind 类）并排互注 |
| 测试             | 核心算法抽纯函数走 headless 单测；DOM/Virtuoso 接线走 CDP 冒烟（含截图目视断言，PDF 轨惯例）                                                                       |

## 3. ③ 页内精确恢复（scrollRatio）

存储/解析早已支持（`PdfProgressLocator.scrollRatio`），只缺运行时接线。

**坐标模型**（全书同尺寸，Virtuoso 每项高 `pageH + 16`，`py-2` 上缝 8px）：

- 第 `page` 页内容顶 = `(page−1) × (pageH+16) + 8`
- `scrollRatio = clamp((scrollTop − 页内容顶) / pageH, 0, 1)`（页缝区间 clamp 到边界）
- 反向：`scrollTop = (page−1) × (pageH+16) + 8 + ratio × pageH`

**存（save）**：`rangeChanged` 已从 `scrollTop` 推视口顶部页号；同处再算 `scrollRatio` 传给 `saveAt` → `makePdfLocator({ page, scrollRatio })`。删掉写死的 `scrollRatio: 0`。

**恢复（restore）**：`initialTopMostItemIndex` 换成 `initialScrollTop`（上面反向公式）。页号越界 clamp 逻辑保留。

**纯函数**：新建 `src/renderer/reader/pdf-scroll.ts`——`intraPageRatio(scrollTop, page, pageH)` 与 `scrollTopFor(page, ratio, pageH)`，页缝常量集中于此；`PdfReader.tsx` 的 `rangeChanged` 顶页推算同步迁移消费（消除散落的 `pageH + 16` 魔法式）。单测覆盖往返一致性与边界（首页、末页、页缝、ratio 0/1）。

## 4. ④ 带笔记标注的视觉标记

**现状**：PDF overlay 渲染 `OVERLAY_FILL[h.style]`，忽略已透传的 `hasNote`；ePub 在 `apply-annotations.ts` 拼 `anno-noted` 类（点状 text-decoration）。判定谓词 `note.trim().length > 0` 两侧重复。

**改动**（全部在 `highlight.ts` + 两个消费点）：

1. 抽共享谓词 `hasNote(note: string): boolean`，ePub `apply-annotations.ts` 与 PDF `pdf-annotations.ts` 改为消费它。
2. 新增纯函数 `overlayClass(style, hasNote)`：无笔记 = `OVERLAY_FILL[style]` 原值；有笔记 = 填充色 + `border-b-2 border-dotted border-foreground/70`（`underline` 样式则把实线底边换成点状）。明暗模式下 `border-foreground` 自适应。
3. `PdfPage` overlay map 改用 `overlayClass(h.style, h.hasNote)`。
4. `ANNO_IFRAME_CSS` 与 `overlayClass` 并排放置、注释互引（「有笔记 = 点状下划线」约定改一侧必改另一侧）。

**单测**：`overlayClass` 覆盖 6 样式 × {有/无笔记}；`hasNote` 覆盖空串/空白串/正常。

## 5. ① 光标锚点滚轮缩放

**触发与监听**：`PdfReader` 在 Virtuoso 滚动容器（`scrollerRef`）上挂原生 `wheel` 监听（`{ passive: false }`，React 合成事件挂不了 non-passive）。`e.ctrlKey` 为真时 `preventDefault()`（拦浏览器整页缩放）并进入缩放路径；否则不拦（正常滚动）。

**目标值与节流**：

- 精确目标 `targetRef` 存 ref；手势开始（或外部 pref 变化，如 PdfPrefs 按钮）时从当前 pref 重新 seed。
- 每个 wheel 事件：`target = clamp(target × exp(−deltaY × SENSITIVITY), MIN, MAX)`（端点用 `PDF_ZOOM_MIN/MAX` 裸值，不取整）。
- rAF 回调里每帧最多一次 `setPdfZoom(clampPdfZoom(target))` → 触发 Virtuoso `computeItemKey` 重挂 + canvas 新分辨率重渲（沿用现有机制，始终锐利）。
- SENSITIVITY 调到一个鼠标滚轮档（deltaY ≈ 100）≈ 10% 缩放，与按钮步进感受对齐。

**光标锚点复位**（缩放提交后 `useLayoutEffect`，页盒高度走内联 style、commit 即同步生效，不会闪）：

- 缩放前记录：光标视口坐标 → 容器相对坐标 → 竖向用 `intraPageRatio` 得（页号, 页内比例），横向记 `oldScrollLeft + 光标X`。
- 缩放后：竖向 `scrollTopFor(页号, 比例, 新pageH)` 反算；横向 `(oldScrollLeft + 光标X) × ratio − 光标X`。

**纯函数**：`nextZoom(current, deltaY)`（含 SENSITIVITY 与端点 clamp）进 `pdf-zoom.ts` 单测；锚点换算复用 `pdf-scroll.ts`。

**与既有缩放 UI 的关系**：PdfPrefs 按钮/输入框照旧（同写 `prefs-store.pdfZoom`）；wheel 路径只是第三个写入口。外部写入时 `targetRef` 重新 seed，不打架。

## 6. 错误处理与边界

- wheel 缩放中书未加载完（`book == null`）→ 监听不挂（effect 依赖 book）。
- 恢复时 locator 的 `scrollRatio` 越界/缺失 → `parsePdfLocator` 已兜底为 0（页顶），行为同现状。
- 旧进度数据（`scrollRatio: 0`）→ 自然落页顶，无迁移。
- 缩放换档重挂期间 wheel 连发 → rAF 节流天然合并；`targetRef` 不丢精度。

## 7. 测试与验收

**headless 单测**：

- `pdf-scroll.test.ts`：ratio↔scrollTop 往返、边界（首/末页、页缝、ratio 0/1）。
- `pdf-zoom.test.ts`（扩展）：`nextZoom` 方向、端点 clamp、灵敏度标定。
- `highlight.test.ts`：`overlayClass` 6×2 矩阵、`hasNote` 谓词。

**CDP 冒烟**（截图目视断言）：

1. 滚到某页中部 → 重开书 → 落回页内原位（非页顶）。
2. 建一条带笔记标注 + 一条无笔记标注 → 带笔记者显点状底边线，无笔记者不显；明暗两模式各验一次。
3. Ctrl+滚轮放大/缩小 → 光标下内容不漂移；触控板捏合同验；PdfPrefs 按钮与输入框仍工作。

**i18n**：无新增用户文案。**changeset**：一条用户向英文条目（patch）。

## 8. 改动文件清单

| 文件                                       | 改动                                                          |
| ------------------------------------------ | ------------------------------------------------------------- |
| `src/renderer/reader/pdf-scroll.ts`（新）  | `intraPageRatio` / `scrollTopFor` 纯函数 + 页缝常量           |
| `src/renderer/reader/PdfReader.tsx`        | save/restore 接线、wheel 监听 + 锚点复位、`overlayClass` 消费 |
| `src/renderer/reader/pdf-zoom.ts`          | `nextZoom` 纯函数                                             |
| `src/renderer/reader/highlight.ts`         | `hasNote` 谓词、`overlayClass` 纯函数、注释互引               |
| `src/renderer/reader/apply-annotations.ts` | 消费共享 `hasNote`                                            |
| `src/renderer/reader/pdf-annotations.ts`   | 消费共享 `hasNote`                                            |
| 对应 `*.test.ts`                           | 见 §7                                                         |
