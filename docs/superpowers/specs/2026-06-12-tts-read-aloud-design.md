# Read-Aloud (TTS) — Design

**Issue:** #61
**Date:** 2026-06-12
**Source:** brainstorming 会话 2026-06-12；可行性 spike 2026-06-08（Web Speech API 在 Electron renderer 可用，macOS 返回 180 个 voice）

## 1. 目标与非目标

**目标**：在 ePub 阅读器中加入朗读功能——从当前阅读位置起逐句朗读、读完一章自动续下一章；当前句高亮并自动跟随滚动；语速与 per-language voice 可在设置中自选并持久化。技术上使用 **Web Speech API**（`window.speechSynthesis`），不引入任何云 TTS 依赖。

**非目标**：

- **不支持 PDF**（本版仅 ePub）。PDF 文本层断句质量差（断行/连字符），且 PDF 阅读体验本身有 #43 一批打磨项未做；后续单独跟进。
- **不做词级高亮**。`onboundary` 事件对 CJK / 部分 voice 不可靠，中文书体验没保证；句级高亮是本版的承诺。
- **不做选区朗读**（选中一段从选区工具条触发）。与整书听书是两个需求，作为后续补充。
- **不在 DB 持久化书籍语言**（不加 `books.language` 列、不动迁移）。语种判定走逐句启发式检测（见 §4），同时天然处理中英混排。
- **不做后台/锁屏播放、系统媒体键集成**。

## 2. 背景与关键约束（spike 结论）

- Web Speech API 在 Electron renderer 完全可用：`speechSynthesis` 存在、`speak()` 正常触发 `onstart`/`onend`、`getVoices()` 返回 macOS 全量 voice。
- **`utter.voice` 必须显式设置**：不设时 utterance 继承 `<html lang>`（本应用为 UI 语言），引擎会用中文 voice（Tingting）读英文，发音诡异。voice 永远按**内容语言**选，不跟 UI 语言。
- macOS voice 列表包含 novelty voices（Albert、Bad News、Bells…），「取第一个匹配 lang 的 voice」这种朴素选择会踩中；需显式过滤 + 平台精选推荐表。
- `getVoices()` 首次调用可能返回空数组，需监听 `voiceschanged` 事件等就绪。
- issue 提到的诊断探针（`AdvancedSettings.tsx` 的 Web Speech 按钮）已不在代码中，无需清理。

## 3. 关键架构事实（实现据此）

- **ePub 渲染 = 每 section 一个 iframe**（`EpubReader.tsx`，virtuoso 虚拟化、`data-section-index` 定位）。朗读文本直接取自 iframe DOM——文本与高亮天然同源，不存在「主进程纯文本 ↔ DOM 偏移」映射问题（已否决的方案 B；pdfjs textLayer 手写裁剪错位是前车之鉴）。
- **现有标注高亮是 `<mark>` wrap**（`apply-annotations.ts` 直接改 DOM）。TTS 当前句高亮**不得**再走 wrap 路线（频繁改 DOM、与标注 mark 嵌套冲突、触发 virtuoso 重测量），改用 **CSS Custom Highlight API**（`CSS.highlights` + `::highlight()`，Chromium 105+，Electron 41 可用）——零 DOM 修改，换句只是替换 Range。
- **preferences 单一源注册制**（`src/shared/preferences.ts`）：新增 key = `PREFERENCE_SCHEMAS` 注册 + `setPreferenceInput` 补 discriminated-union arm + 主进程 handler switch case（缺 case 会静默不落盘，`never` 守卫已在）+ schema 同步测试。
- **主厚渲薄边界**：TTS 是浏览器 API，引擎/切句/选声全部留在渲染层不违反规则——主进程侧只有 preferences 持久化。切句、选声做成**纯函数**以保 vitest 可测。

## 4. 朗读引擎（`src/renderer/reader/tts/`）

新建模块目录，四个单元：

### 4.1 `segment-sentences.ts`（纯函数）

输入 iframe 的 `Document`（或子树根节点），输出有序句子数组：

```ts
type Sentence = {
  text: string;
  // Range 端点（不持有 live Range——构建队列时惰性创建）
  startNode: Node;
  startOffset: number;
  endNode: Node;
  endOffset: number;
};
```

实现：TreeWalker 遍历文本节点（跳过 `script`/`style`/不可见元素），按**块级边界**分段拼接文本并记录每段的 (node, offset) 映射，段内用 `Intl.Segmenter(undefined, { granularity: "sentence" })` 切句（Chromium 内建，中文句号/英文缩写均处理），切出的句子偏移经映射换回 DOM 端点。空白句、纯标点句跳过。

### 4.2 `detect-lang.ts` + `pick-voice.ts`（纯函数）

- `detectSentenceLang(text): "zh" | "en" | "ja" | ...`——轻量启发式：CJK 统一表意文字占比 → zh，假名存在 → ja，否则 en。粗分语种即可（选 voice 只需语种级），天然支持混排（中文书里的英文段落用英文 voice 读）。
- `pickVoice(lang, voices, prefs): SpeechSynthesisVoice | null`——优先级：
  1. 用户偏好 `prefs.voiceByLang[lang]`（按 `voice.name` 匹配；失配则降级继续）；
  2. **平台推荐表**（见 §5）；
  3. 通用兜底：`voice.lang` 前缀匹配语种 + 过滤 novelty 黑名单 + `localService` 优先 + `default` 优先；
  4. 全失败返回 `null`（该句仍朗读，交给引擎默认行为，并 `log.warn`）。

### 4.3 `tts-engine.ts`（状态机 + speechSynthesis 适配）

```
idle → playing ⇄ paused → idle
```

- 持有句队列与当前索引；每句一个 `SpeechSynthesisUtterance`（显式设 `voice` + `rate`），`onend` 推进下一句，`onerror` 记 warn 后跳下一句（单句失败不中断整体）。
- `speechSynthesis` 经构造注入（接口收窄），状态机逻辑可在 vitest 中用 mock 测试。
- 暂停/继续用 `pause()`/`resume()`；停止用 `cancel()` + 状态复位。
- **rate 变更即时生效**：`cancel()` 当前句 → 以新 rate 从当前句重新 `speak()`。
- 队列读尽触发 `onChapterEnd` 回调——引擎不懂章节，跨章编排归 reader 集成层（§6）。
- 事件出口：`onSentenceChange(index)`（驱动高亮与滚动）、`onStateChange(state)`（驱动控制条 UI）。

### 4.4 `voices.ts`（getVoices 就绪封装）

`getVoicesReady(): Promise<SpeechSynthesisVoice[]>`——首次为空时等 `voiceschanged`，带超时兜底（超时返回当前列表 + warn）。

## 5. 平台分层的 voice 推荐表

**用户决策：提前考虑跨平台，macOS 单独一套精选表。**

```ts
// platform 取自 navigator（renderer 侧），结构上为未来 Windows/Linux 留位
const RECOMMENDED_VOICES: Record<Platform, Record<Lang, string[]>> = {
  macos: {
    en: ["Samantha", "Alex", ...],   // 名单在实现期实测筛定
    zh: ["Tingting", ...],
    ...
  },
  windows: {},  // 留空：走 §4.2 第 3 级通用兜底（lang 匹配 + localService/default 优先）
  linux: {},
};
const NOVELTY_BLOCKLIST: string[] = ["Albert", "Bad News", "Bahh", ...]; // 仅 macOS 命中
```

推荐表是**有序候选名单**（系统未装精选 voice 时顺位降级），不是单值。Windows（自带 Microsoft voices）/ Linux（speechd，质量参差）当前不投入实测，靠通用兜底保证「能用且不踩 novelty 坑」——novelty 黑名单本身就是 macOS 专属。

## 6. Reader 集成（跨章续播、高亮、滚动）

- **起读位置**：点击播放时，取视口内第一个可见 section iframe，对其切句后从**视口内第一个可见句**开始（句首 Range 的 `getBoundingClientRect` 落在视口内）。视口无可见句（如图片页）则从该 section 第一句起。
- **跨章续播**：`onChapterEnd` → 复用现有「下一 section」导航逻辑滚到下一 section，等其 iframe 就绪（已有 VirtualDocs 就绪机制）→ 重建句队列 → 续播。书末自然停止。
- **当前句高亮**：在 iframe 的 `CSS.highlights` 注册 `"tts-current"` Highlight，换句时仅替换其中的 Range。样式经 `highlight.ts` 既有 iframe 样式注入通道加一条 `::highlight(tts-current)` 规则（亮/暗两态各一色，与标注五色区分）。
- **跟随滚动**：句变更时若当前句不在视口内，`scrollIntoView({ block: "center" })`。**用户手动滚动（wheel/touch/拖滚动条）后挂起自动跟随**，直到用户下一次按播放/继续才恢复——不抢滚动条。
- **打断即停**：用户手动跳章/跳 TOC、切书、关阅读器 → `cancel()` 停止并复位（位置已变，强行续播会跳跃）。组件卸载清理挂在 `useEffect` cleanup。

## 7. UI 与偏好

### 7.1 控件

- **顶栏**新增朗读按钮（喇叭图标）。点击 = 从当前位置开始播放，并浮出控制条。
- **底部浮动胶囊控制条**：暂停/继续、停止、语速选择（0.5×–2× 档位下拉）。停止后控制条收起。正文容器内绝对定位居中，不遮 AI 面板。
- 顶栏可收起（`headerOpen=false`）时控制条仍独立可见——播放中始终有控制入口。

### 7.2 偏好（`ttsPrefs`）

`src/shared/preferences.ts` 注册：

```ts
export const ttsPrefsSchema = z.object({
  rate: z.number().min(0.5).max(2).default(1),
  voiceByLang: z.record(z.string(), z.string()).default({}), // 语种 → voice.name
});
```

voice 存 `voice.name` 字符串；启动/换机后按名匹配，失配走 §4.2 降级链（不报错、不重置偏好）。

### 7.3 设置页

`ReadingSettings.tsx` 新增「朗读」区：

- **语速**滑杆/档位（与控制条联动同一偏好）。
- **per-language voice 下拉**（zh / en 起步；列表来自 `getVoicesReady()` 按语种过滤，novelty 黑名单项不展示），每行带**试听**按钮（用该 voice 读一句示例文案）。
- i18n 照常 `t()` + `pnpm i18n:extract`。

## 8. 测试与边界

**纯函数 vitest**（jsdom 提供 DOM；`Intl.Segmenter` Node 自带）：

- `segment-sentences`：中英混排、缩写句号（"Mr. Smith"）、跨多文本节点的句子、空白章、块级边界不连句。
- `detect-lang` / `pick-voice`：CJK/假名/拉丁判定；偏好命中、偏好失配降级、推荐表顺位、novelty 过滤、全失败返 null。
- `tts-engine`：注入 mock synthesis 测状态机迁移、onend 推进、onerror 跳句、rate 变更重读当前句、cancel 复位。

**手动冒烟**（CDP，参照既有 Playwright 冒烟惯例）：中文书 + 英文书各播一段，验证 voice 正确（不被 UI lang 带偏）、高亮跟随、跨章续播、暂停/继续/停止、设置页换 voice 后生效。

**已知边界**：

- `getVoices()` 异步就绪 → §4.4 封装。
- 长句（引擎对超长 utterance 可能截断/卡死）→ 切句后对超长句（>~300 字符）按逗号/分号二次切分。
- `speechSynthesis.paused` 状态在部分平台行为怪异（pause 后 cancel 不干净）→ 停止路径统一「先 resume 再 cancel」防御。
- 朗读中用户翻页/手滚 → §6 打断与跟随挂起规则。

## 9. 已否决的替代方案

- **方案 B：主进程 `readChapterText` 提文本 + 渲染层映射回 DOM 高亮**——纯文本与 DOM `textContent` 规范化不一致，偏移映射脆弱必错位；ePub-only 范围下「双格式统一」的唯一优势不存在。
- **词级高亮（onboundary）**——CJK 不可靠，见非目标。
- **`books.language` 列（导入提取 dc:language）**——需迁移 + 旧书回填，且 dc:language 错填常见、处理不了混排；逐句检测零迁移且更鲁棒。
