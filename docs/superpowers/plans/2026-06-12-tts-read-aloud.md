# Read-Aloud (TTS) Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** ePub 阅读器朗读功能（issue #61）——从当前位置逐段朗读、自动连章、当前段高亮跟随、语速与 per-language voice 设置持久化。

**Architecture:** 渲染层 DOM 驱动（spec `docs/superpowers/specs/2026-06-12-tts-read-aloud-design.md`）。段落从 iframe DOM 按块级元素切分；引擎是注入式 `SpeechPort` 上的段队列状态机（超长段内部切多 utterance）；高亮走 CSS Custom Highlight API（零 DOM 修改）；集成经模块单例 `tts-controller` + zustand 状态发布。主进程只加 `ttsPrefs` preference。

**Tech Stack:** Web Speech API（`speechSynthesis`）、`Intl.Segmenter`（长段切分）、CSS Custom Highlight API、zustand、Zod preference 注册链。

**约定**：所有命令在 repo 根跑。`pnpm test <file>` 跑单文件。提交遵循 Conventional Commits。**渲染层启用 React Compiler——不要手写 `useCallback`/`useMemo`**。

---

## 文件结构

```
src/shared/preferences.ts                      修改  注册 ttsPrefs schema + union arm
src/shared/preferences.test.ts                 修改  schema/union 同步测试
src/main/ipc/preferences-handlers.ts           修改  switch 补 ttsPrefs case
src/renderer/store/prefs-store.ts              修改  ttsPrefs 状态 + updateTtsPrefs
src/renderer/store/hydrate-preferences.ts      修改  hydrate ttsPrefs
src/renderer/store/tts-store.ts                新建  TTS 运行态发布（status）
src/renderer/reader/tts/detect-lang.ts         新建  段文本 → 语种（纯函数）
src/renderer/reader/tts/pick-voice.ts          新建  语种 → voice（推荐表/黑名单/降级链，纯函数）
src/renderer/reader/tts/segment-paragraphs.ts  新建  Document → 段数组（纯函数，happy-dom 可测）
src/renderer/reader/tts/split-for-utterance.ts 新建  长段 → utterance 块（纯函数）
src/renderer/reader/tts/tts-engine.ts          新建  段队列状态机（SpeechPort 注入）
src/renderer/reader/tts/voices.ts              新建  browserSpeechPort + getVoicesReady + 平台检测
src/renderer/reader/tts/tts-css.ts             新建  ::highlight(tts-current) iframe CSS
src/renderer/reader/tts/tts-controller.ts      新建  模块单例：attach/play/跨章/高亮/滚动
src/renderer/reader/EpubReader.tsx             修改  attach/detach、topSectionIndexRef、打断、CSS 拼接
src/renderer/reader/TtsControlBar.tsx          新建  底部浮动控制条
src/renderer/reader/ReaderView.tsx             修改  顶栏朗读按钮 + 控制条挂载
src/renderer/settings/ReadingSettings.tsx      修改  「朗读」区（语速 + per-language voice + 试听）
src/shared/i18n/locales/{zh-CN,en}.ts          修改  经 pnpm i18n:extract + 手补 en
```

---

### Task 0: 开分支

- [ ] **Step 1: 从 main 开 feature 分支**

```bash
git checkout -b feat/tts-read-aloud
```

---

### Task 1: `ttsPrefs` preference 注册全链

**Files:**

- Modify: `src/shared/preferences.ts`
- Modify: `src/shared/preferences.test.ts`
- Modify: `src/main/ipc/preferences-handlers.ts`
- Modify: `src/renderer/store/prefs-store.ts`
- Modify: `src/renderer/store/hydrate-preferences.ts`

- [ ] **Step 1: 写失败测试**

`src/shared/preferences.test.ts` 已有 PREFERENCE_SCHEMAS ↔ setPreferenceInput 同步测试（先读该文件确认既有结构，下面的用例并入既有 describe）。追加：

```ts
it("ttsPrefs accepts rate + voiceByLang and rejects out-of-range rate", () => {
  const schema = PREFERENCE_SCHEMAS.ttsPrefs;
  expect(schema.safeParse({ rate: 1, voiceByLang: {} }).success).toBe(true);
  expect(schema.safeParse({ rate: 1.5, voiceByLang: { zh: "Tingting" } }).success).toBe(true);
  expect(schema.safeParse({ rate: 3, voiceByLang: {} }).success).toBe(false);
  expect(schema.safeParse({ rate: 0.1, voiceByLang: {} }).success).toBe(false);
});
```

注意：若该文件存在「PREFERENCE_SCHEMAS 的每个 key 在 setPreferenceInput 都有 arm」的穷举测试，新 key 注册后它会自动覆盖——确认即可，不必重复写。

- [ ] **Step 2: 跑测试确认失败**

```bash
pnpm test src/shared/preferences.test.ts
```

预期：FAIL（`ttsPrefs` 不存在于 PREFERENCE_SCHEMAS）。

- [ ] **Step 3: 注册 schema**

`src/shared/preferences.ts`，在 `PREFERENCE_SCHEMAS` 定义之前加：

```ts
/** 朗读（TTS）偏好：语速 + 语种→voice.name 映射（失配走 pick-voice 降级链，不报错不重置）。 */
export const ttsPrefsSchema = z.object({
  rate: z.number().min(0.5).max(2),
  voiceByLang: z.record(z.string(), z.string()),
});
export type TtsPrefs = z.infer<typeof ttsPrefsSchema>;

/** ttsPrefs 出厂值：渲染层初值与重置共用单一源。 */
export const DEFAULT_TTS_PREFS: TtsPrefs = { rate: 1, voiceByLang: {} };
```

（注意：**不要**用 `.default()`——`InferIn` 取 output 类型会让字段对调用方变必填的坑，见 IPC 入参既往回归。初值由 `DEFAULT_TTS_PREFS` 在 store 层提供。）

`PREFERENCE_SCHEMAS` 加一行：

```ts
  instructions: z.string(),
  ttsPrefs: ttsPrefsSchema,
} as const;
```

`setPreferenceInput` 的 discriminatedUnion 加一条 arm：

```ts
  z.object({ key: z.literal("instructions"), value: z.string() }),
  z.object({ key: z.literal("ttsPrefs"), value: ttsPrefsSchema }),
]);
```

- [ ] **Step 4: 主进程 handler 补 case**

`src/main/ipc/preferences-handlers.ts` 的 switch，在 `case "instructions"` 之后加：

```ts
      case "ttsPrefs":
        return setPreference(getDb(), input.key, input.value);
```

（漏写会被 `never` 穷尽性守卫编译报错挡住——typecheck 是验证手段。）

- [ ] **Step 5: 渲染层 store + hydrate**

`src/renderer/store/prefs-store.ts`：

```ts
// import 区追加
import {
  DEFAULT_SOUL,
  DEFAULT_STEP_LIMIT,
  DEFAULT_TTS_PREFS,
  type ChatModel,
  type Soul,
  type SummaryModel,
  type TtsPrefs,
} from "@shared/preferences";

// PrefsState 追加
  /** 朗读（TTS）偏好：语速 + 语种→voice 名映射。 */
  ttsPrefs: TtsPrefs;

// PrefsActions 追加
  updateTtsPrefs: (patch: Partial<TtsPrefs>) => void;

// PREFS_INITIAL 追加
  ttsPrefs: DEFAULT_TTS_PREFS,

// store 实现追加（仿 updateLayout 的 patch 合并模式）
  updateTtsPrefs: (patch) =>
    set((s) => {
      const ttsPrefs = { ...s.ttsPrefs, ...patch };
      persistPreference({ key: "ttsPrefs", value: ttsPrefs });
      return { ttsPrefs };
    }),
```

`src/renderer/store/hydrate-preferences.ts` 末尾追加：

```ts
if (snap.ttsPrefs) usePrefsStore.setState({ ttsPrefs: snap.ttsPrefs });
```

- [ ] **Step 6: 跑测试 + typecheck**

```bash
pnpm test src/shared/preferences.test.ts && pnpm typecheck
```

预期：全 PASS（typecheck 同时验证 handler switch 穷尽性）。

- [ ] **Step 7: 提交**

```bash
git add -A && git commit -m "feat(tts): register ttsPrefs preference end to end"
```

---

### Task 2: `detect-lang.ts` 段语种检测

**Files:**

- Create: `src/renderer/reader/tts/detect-lang.ts`
- Test: `src/renderer/reader/tts/detect-lang.test.ts`

- [ ] **Step 1: 写失败测试**

```ts
import { describe, expect, it } from "vitest";
import { detectParagraphLang } from "./detect-lang";

describe("detectParagraphLang", () => {
  it("detects Chinese paragraphs", () => {
    expect(detectParagraphLang("这是一个完整的中文段落，讲述了一个故事。")).toBe("zh");
  });
  it("detects English paragraphs", () => {
    expect(detectParagraphLang("This is a plain English paragraph about reading.")).toBe("en");
  });
  it("detects Japanese via kana even with heavy kanji", () => {
    expect(detectParagraphLang("吾輩は猫である。名前はまだ無い。")).toBe("ja");
  });
  it("mixed Chinese with embedded English terms stays zh", () => {
    expect(detectParagraphLang("我们用 TypeScript 和 React 构建了这个阅读器应用。")).toBe("zh");
  });
  it("mostly-English with a few CJK chars stays en", () => {
    expect(
      detectParagraphLang("The word 猫 means cat in this long English sentence about languages."),
    ).toBe("en");
  });
  it("falls back to en for digits/punctuation-only text", () => {
    expect(detectParagraphLang("1234 — 5678!")).toBe("en");
  });
});
```

- [ ] **Step 2: 跑测试确认失败**

```bash
pnpm test src/renderer/reader/tts/detect-lang.test.ts
```

预期：FAIL（模块不存在）。

- [ ] **Step 3: 实现**

```ts
/** TTS 选声用的粗粒度语种（选 voice 只需语种级；spec §4.2）。 */
export type TtsLang = "zh" | "ja" | "en";

/**
 * 段级语种启发式：在字母/数字字符中统计假名与 CJK 表意占比。
 * 假名是强日文信号（日文必含假名、中文不含），低阈值即判 ja；
 * CJK 占比过 30% 判 zh（容忍中文段里嵌英文术语）；其余回退 en。
 */
export function detectParagraphLang(text: string): TtsLang {
  let cjk = 0;
  let kana = 0;
  let total = 0;
  for (const ch of text) {
    if (!/[\p{L}\p{N}]/u.test(ch)) continue;
    total++;
    const cp = ch.codePointAt(0)!;
    if (cp >= 0x3040 && cp <= 0x30ff) kana++;
    else if ((cp >= 0x4e00 && cp <= 0x9fff) || (cp >= 0x3400 && cp <= 0x4dbf)) cjk++;
  }
  if (total === 0) return "en";
  if (kana / total > 0.05) return "ja";
  if (cjk / total > 0.3) return "zh";
  return "en";
}
```

- [ ] **Step 4: 跑测试确认通过**

```bash
pnpm test src/renderer/reader/tts/detect-lang.test.ts
```

- [ ] **Step 5: 提交**

```bash
git add -A && git commit -m "feat(tts): add paragraph language detection heuristic"
```

---

### Task 3: `pick-voice.ts` 选声降级链

**Files:**

- Create: `src/renderer/reader/tts/pick-voice.ts`
- Test: `src/renderer/reader/tts/pick-voice.test.ts`

- [ ] **Step 1: 写失败测试**

```ts
import { describe, expect, it } from "vitest";
import { NOVELTY_BLOCKLIST, pickVoice } from "./pick-voice";

/** 测试用 voice 形状（SpeechSynthesisVoice 只读且无构造器，用结构兼容对象代替）。 */
function v(name: string, lang: string, opts?: { localService?: boolean; default?: boolean }) {
  return {
    name,
    lang,
    localService: opts?.localService ?? true,
    default: opts?.default ?? false,
    voiceURI: name,
  } as SpeechSynthesisVoice;
}

const MAC_VOICES = [
  v("Albert", "en-US"),
  v("Samantha", "en-US"),
  v("Alex", "en-US"),
  v("Tingting", "zh-CN"),
  v("Kyoko", "ja-JP"),
];

describe("pickVoice", () => {
  it("user preference wins over recommendations", () => {
    const got = pickVoice("en", MAC_VOICES, { voiceByLang: { en: "Alex" } }, "macos");
    expect(got?.name).toBe("Alex");
  });
  it("stale preference falls through to recommended", () => {
    const got = pickVoice("en", MAC_VOICES, { voiceByLang: { en: "Ghost" } }, "macos");
    expect(got?.name).toBe("Samantha");
  });
  it("macOS recommended order is honored", () => {
    expect(pickVoice("en", MAC_VOICES, { voiceByLang: {} }, "macos")?.name).toBe("Samantha");
    expect(pickVoice("zh", MAC_VOICES, { voiceByLang: {} }, "macos")?.name).toBe("Tingting");
  });
  it("generic fallback skips novelty voices", () => {
    const voices = [v("Albert", "en-US"), v("Whisper", "en-US"), v("Plain", "en-GB")];
    expect(pickVoice("en", voices, { voiceByLang: {} }, "macos")?.name).toBe("Plain");
  });
  it("generic fallback prefers localService + default", () => {
    const voices = [
      v("Remote", "en-US", { localService: false }),
      v("LocalDefault", "en-US", { localService: true, default: true }),
      v("LocalPlain", "en-US", { localService: true }),
    ];
    expect(pickVoice("en", voices, { voiceByLang: {} }, "windows")?.name).toBe("LocalDefault");
  });
  it("returns null when no voice matches the lang", () => {
    expect(pickVoice("ja", [v("Samantha", "en-US")], { voiceByLang: {} }, "macos")).toBeNull();
  });
  it("blocklist contains known macOS novelty voices", () => {
    expect(NOVELTY_BLOCKLIST).toContain("Albert");
    expect(NOVELTY_BLOCKLIST).toContain("Bad News");
  });
});
```

- [ ] **Step 2: 跑测试确认失败**

```bash
pnpm test src/renderer/reader/tts/pick-voice.test.ts
```

- [ ] **Step 3: 实现**

```ts
import type { TtsLang } from "./detect-lang";

export type TtsPlatform = "macos" | "windows" | "linux";

/** macOS novelty voices（音效声，朴素 lang 匹配会踩中；spike 实测）。 */
export const NOVELTY_BLOCKLIST: readonly string[] = [
  "Albert",
  "Bad News",
  "Bahh",
  "Bells",
  "Boing",
  "Bubbles",
  "Cellos",
  "Good News",
  "Jester",
  "Organ",
  "Superstar",
  "Trinoids",
  "Whisper",
  "Wobble",
  "Zarvox",
];

/**
 * 平台分层推荐表（spec §5）：有序候选名单，顺位降级。macOS 实测精选；
 * Windows/Linux 留空走通用兜底（lang 匹配 + localService/default 优先）——
 * 结构上为未来实测补名单留位。
 */
export const RECOMMENDED_VOICES: Record<TtsPlatform, Partial<Record<TtsLang, string[]>>> = {
  macos: {
    en: ["Samantha", "Alex", "Karen", "Daniel"],
    zh: ["Tingting", "Meijia", "Sinji"],
    ja: ["Kyoko"],
  },
  windows: {},
  linux: {},
};

const LANG_PREFIX: Record<TtsLang, string> = { zh: "zh", ja: "ja", en: "en" };

export interface VoicePrefsLike {
  voiceByLang: Record<string, string>;
}

/**
 * 选声降级链（spec §4.2）：用户偏好 → 平台推荐表顺位 → 通用兜底
 * （novelty 过滤 + localService 优先 + default 优先）→ null（引擎默认行为）。
 */
export function pickVoice(
  lang: TtsLang,
  voices: SpeechSynthesisVoice[],
  prefs: VoicePrefsLike,
  platform: TtsPlatform,
): SpeechSynthesisVoice | null {
  const matches = voices.filter((v) => v.lang.toLowerCase().startsWith(LANG_PREFIX[lang]));
  const wanted = prefs.voiceByLang[lang];
  if (wanted) {
    const hit = matches.find((v) => v.name === wanted) ?? voices.find((v) => v.name === wanted);
    if (hit) return hit;
  }
  for (const name of RECOMMENDED_VOICES[platform][lang] ?? []) {
    const hit = matches.find((v) => v.name === name);
    if (hit) return hit;
  }
  const usable = matches.filter((v) => !NOVELTY_BLOCKLIST.includes(v.name));
  return (
    usable.find((v) => v.localService && v.default) ??
    usable.find((v) => v.localService) ??
    usable.find((v) => v.default) ??
    usable[0] ??
    null
  );
}
```

- [ ] **Step 4: 跑测试确认通过**

```bash
pnpm test src/renderer/reader/tts/pick-voice.test.ts
```

- [ ] **Step 5: 提交**

```bash
git add -A && git commit -m "feat(tts): add voice picking with platform recommendations and novelty blocklist"
```

---

### Task 4: `segment-paragraphs.ts` 段切分

**Files:**

- Create: `src/renderer/reader/tts/segment-paragraphs.ts`
- Test: `src/renderer/reader/tts/segment-paragraphs.test.ts`（happy-dom）

- [ ] **Step 1: 写失败测试**

文件首行必须是环境注解（vitest 默认 node 无 DOM；项目先例 `pdf-selection.test.ts`）：

```ts
// @vitest-environment happy-dom
import { describe, expect, it } from "vitest";
import { segmentParagraphs } from "./segment-paragraphs";

function docFrom(html: string): Document {
  const doc = document.implementation.createHTMLDocument("t");
  doc.body.innerHTML = html;
  return doc;
}

describe("segmentParagraphs", () => {
  it("extracts simple paragraphs in order", () => {
    const doc = docFrom("<p>First.</p><p>Second.</p>");
    const paras = segmentParagraphs(doc.body);
    expect(paras.map((p) => p.text)).toEqual(["First.", "Second."]);
    expect(paras[0]!.element.tagName).toBe("P");
  });
  it("takes innermost block for nested blocks (no duplication)", () => {
    const doc = docFrom("<blockquote><p>Quoted text.</p></blockquote><li><p>Item.</p></li>");
    expect(segmentParagraphs(doc.body).map((p) => p.text)).toEqual(["Quoted text.", "Item."]);
  });
  it("normalizes whitespace across inline elements", () => {
    const doc = docFrom("<p>Hello\n  <em>brave</em>\n  world</p>");
    expect(segmentParagraphs(doc.body)[0]!.text).toBe("Hello brave world");
  });
  it("skips empty and punctuation-only blocks", () => {
    const doc = docFrom("<p>   </p><p>***</p><p>Real.</p>");
    expect(segmentParagraphs(doc.body).map((p) => p.text)).toEqual(["Real."]);
  });
  it("skips hidden subtrees", () => {
    const doc = docFrom("<div hidden><p>Invisible.</p></div><p>Visible.</p>");
    expect(segmentParagraphs(doc.body).map((p) => p.text)).toEqual(["Visible."]);
  });
  it("headings and figcaptions are paragraphs", () => {
    const doc = docFrom("<h1>Title</h1><figure><img/><figcaption>Caption.</figcaption></figure>");
    expect(segmentParagraphs(doc.body).map((p) => p.text)).toEqual(["Title", "Caption."]);
  });
  it("leaf div with bare text is a paragraph", () => {
    const doc = docFrom("<div><div>Bare div text.</div><p>Para.</p></div>");
    expect(segmentParagraphs(doc.body).map((p) => p.text)).toEqual(["Bare div text.", "Para."]);
  });
});
```

- [ ] **Step 2: 跑测试确认失败**

```bash
pnpm test src/renderer/reader/tts/segment-paragraphs.test.ts
```

- [ ] **Step 3: 实现**

```ts
/**
 * 朗读段（spec §4.1）：text 是规范化空白后的朗读文本；element 是高亮/滚动锚点。
 * 持 Element 而非 Range 端点——高亮时惰性 `range.selectNodeContents(element)`，
 * 等价满足 spec「不持有 live Range」的意图且更不易失效。
 */
export interface TtsParagraph {
  text: string;
  element: Element;
}

/** 块级段选择器：与 EpubReader.topElementCfi 的块清单同族，外加 div 叶兜底（裸 div 段落的 ePub）。 */
const BLOCK_SELECTOR = "p,h1,h2,h3,h4,h5,h6,li,blockquote,figcaption,dt,dd,pre,div";

const SKIP_CLOSEST = "script,style,template,noscript,[hidden],[aria-hidden='true']";

/**
 * 把 section 文档切成有序朗读段（spec §4.1）：取**最内层**块级元素（含块级后代的容器
 * 被滤掉，防嵌套重复），规范化空白，跳过空段/纯标点段/隐藏子树。
 */
export function segmentParagraphs(root: ParentNode): TtsParagraph[] {
  const out: TtsParagraph[] = [];
  for (const el of root.querySelectorAll(BLOCK_SELECTOR)) {
    if (el.querySelector(BLOCK_SELECTOR)) continue;
    if (el.closest(SKIP_CLOSEST)) continue;
    const text = (el.textContent ?? "").replace(/\s+/g, " ").trim();
    if (!text || !/[\p{L}\p{N}]/u.test(text)) continue;
    out.push({ text, element: el });
  }
  return out;
}
```

- [ ] **Step 4: 跑测试确认通过**

```bash
pnpm test src/renderer/reader/tts/segment-paragraphs.test.ts
```

- [ ] **Step 5: 提交**

```bash
git add -A && git commit -m "feat(tts): add DOM paragraph segmentation"
```

---

### Task 5: `split-for-utterance.ts` 长段切分

**Files:**

- Create: `src/renderer/reader/tts/split-for-utterance.ts`
- Test: `src/renderer/reader/tts/split-for-utterance.test.ts`

- [ ] **Step 1: 写失败测试**

```ts
import { describe, expect, it } from "vitest";
import { splitForUtterance } from "./split-for-utterance";

describe("splitForUtterance", () => {
  it("returns short text as a single chunk", () => {
    expect(splitForUtterance("短句。", 300)).toEqual(["短句。"]);
  });
  it("splits long text at sentence boundaries within the limit", () => {
    const s1 = "天地玄黄宇宙洪荒。".repeat(5); // 45 chars
    const text = (s1 + s1 + s1).slice(0, 135);
    const chunks = splitForUtterance(s1 + s1 + s1, 100);
    expect(chunks.length).toBeGreaterThan(1);
    for (const c of chunks) expect(c.length).toBeLessThanOrEqual(100);
    expect(chunks.join("")).toBe(s1 + s1 + s1);
    void text;
  });
  it("falls back to comma splits for a single overlong sentence", () => {
    const long = "一二三四五六七八九十，".repeat(12).slice(0, -1) + "。"; // 单句 >100
    const chunks = splitForUtterance(long, 100);
    expect(chunks.length).toBeGreaterThan(1);
    for (const c of chunks) expect(c.length).toBeLessThanOrEqual(100);
  });
  it("never returns empty chunks", () => {
    for (const c of splitForUtterance("a。".repeat(500), 50)) expect(c.trim()).not.toBe("");
  });
});
```

- [ ] **Step 2: 跑测试确认失败**

```bash
pnpm test src/renderer/reader/tts/split-for-utterance.test.ts
```

- [ ] **Step 3: 实现**

```ts
/** 单 utterance 字符上限：超长 utterance 在部分引擎截断/卡死（spec §4.3/§8 防御）。 */
export const MAX_UTTERANCE_CHARS = 300;

/**
 * 把超长段切成 ≤max 的 utterance 块：句边界（Intl.Segmenter）贪心聚合；
 * 单句仍超长再按逗号/分号/顿号细切（保留分隔符在前块尾，朗读停顿自然）。
 * 拼接结果与原文一致（不丢字），对用户透明（spec §4.3：同段共享 voice 与高亮）。
 */
export function splitForUtterance(text: string, max = MAX_UTTERANCE_CHARS): string[] {
  if (text.length <= max) return [text];
  const seg = new Intl.Segmenter(undefined, { granularity: "sentence" });
  const sentences = [...seg.segment(text)].map((s) => s.segment);
  const out: string[] = [];
  let buf = "";
  const flush = () => {
    if (buf.trim()) out.push(buf);
    buf = "";
  };
  for (const s of sentences) {
    if (s.length > max) {
      flush();
      for (const piece of s.split(/(?<=[,;，；、])/)) {
        if (buf.length + piece.length > max) flush();
        buf += piece;
      }
      flush();
      continue;
    }
    if (buf.length + s.length > max) flush();
    buf += s;
  }
  flush();
  return out.length ? out : [text];
}
```

- [ ] **Step 4: 跑测试确认通过**

```bash
pnpm test src/renderer/reader/tts/split-for-utterance.test.ts
```

- [ ] **Step 5: 提交**

```bash
git add -A && git commit -m "feat(tts): add overlong-paragraph utterance splitting"
```

---

### Task 6: `tts-engine.ts` 段队列状态机

**Files:**

- Create: `src/renderer/reader/tts/tts-engine.ts`
- Test: `src/renderer/reader/tts/tts-engine.test.ts`

- [ ] **Step 1: 写失败测试**

mock SpeechPort：`speak()` 收集 utterance，测试手动触发 `onend`/`onerror` 模拟引擎回调。

```ts
import { beforeEach, describe, expect, it, vi } from "vitest";
import { createTtsEngine, type SpeechPort, type UtteranceLike } from "./tts-engine";

function mockPort() {
  const spoken: UtteranceLike[] = [];
  const port: SpeechPort = {
    createUtterance: (text) => ({ text, voice: null, rate: 1, onend: null, onerror: null }),
    speak: (u) => void spoken.push(u),
    cancel: vi.fn(),
    pause: vi.fn(),
    resume: vi.fn(),
  };
  return { port, spoken, last: () => spoken[spoken.length - 1]! };
}

function makeEvents() {
  return {
    onParagraphChange: vi.fn(),
    onStateChange: vi.fn(),
    onQueueEnd: vi.fn(),
    onUtteranceError: vi.fn(),
  };
}

const OPTS = { rate: 1.25, pickVoiceFor: () => null };

describe("tts-engine", () => {
  let m: ReturnType<typeof mockPort>;
  let ev: ReturnType<typeof makeEvents>;
  beforeEach(() => {
    m = mockPort();
    ev = makeEvents();
  });

  it("plays paragraphs sequentially via onend", () => {
    const e = createTtsEngine(m.port, ev);
    e.play(["One.", "Two."], 0, OPTS);
    expect(e.state()).toBe("playing");
    expect(ev.onParagraphChange).toHaveBeenLastCalledWith(0);
    expect(m.last().text).toBe("One.");
    expect(m.last().rate).toBe(1.25);
    m.last().onend?.();
    expect(ev.onParagraphChange).toHaveBeenLastCalledWith(1);
    expect(m.last().text).toBe("Two.");
    m.last().onend?.();
    expect(ev.onQueueEnd).toHaveBeenCalledOnce();
    expect(e.state()).toBe("idle");
  });

  it("splits an overlong paragraph into chunks but reports one paragraph index", () => {
    const e = createTtsEngine(m.port, ev);
    const long = "字".repeat(200) + "。" + "句".repeat(200) + "。";
    e.play([long], 0, OPTS);
    m.last().onend?.();
    expect(m.spoken.length).toBe(2); // 两个 chunk
    expect(ev.onParagraphChange).toHaveBeenCalledTimes(1); // 段索引只发一次
    m.last().onend?.();
    expect(ev.onQueueEnd).toHaveBeenCalledOnce();
  });

  it("onerror skips to next utterance and reports", () => {
    const e = createTtsEngine(m.port, ev);
    e.play(["Bad.", "Good."], 0, OPTS);
    m.last().onerror?.(new Error("boom"));
    expect(ev.onUtteranceError).toHaveBeenCalledOnce();
    expect(m.last().text).toBe("Good.");
    void e;
  });

  it("stop cancels (resume-then-cancel) and ignores stale onend", () => {
    const e = createTtsEngine(m.port, ev);
    e.play(["One.", "Two."], 0, OPTS);
    const u = m.last();
    e.stop();
    expect(m.port.resume).toHaveBeenCalled(); // spec §8：先 resume 再 cancel
    expect(m.port.cancel).toHaveBeenCalled();
    expect(e.state()).toBe("idle");
    u.onend?.(); // cancel 在部分平台触发挂起 utterance 的 onend——不得推进
    expect(m.spoken.length).toBe(1);
  });

  it("pause/resume toggles state without re-speaking", () => {
    const e = createTtsEngine(m.port, ev);
    e.play(["One."], 0, OPTS);
    e.pause();
    expect(e.state()).toBe("paused");
    e.resume();
    expect(e.state()).toBe("playing");
    expect(m.spoken.length).toBe(1);
  });

  it("setRate while playing restarts current paragraph at new rate", () => {
    const e = createTtsEngine(m.port, ev);
    e.play(["One.", "Two."], 0, OPTS);
    m.last().onend?.(); // 进入段 1
    e.setRate(2);
    expect(m.last().text).toBe("Two."); // 从当前段头重读
    expect(m.last().rate).toBe(2);
  });

  it("play starting mid-queue honors startIndex", () => {
    const e = createTtsEngine(m.port, ev);
    e.play(["A.", "B.", "C."], 1, OPTS);
    expect(m.last().text).toBe("B.");
  });
});
```

- [ ] **Step 2: 跑测试确认失败**

```bash
pnpm test src/renderer/reader/tts/tts-engine.test.ts
```

- [ ] **Step 3: 实现**

```ts
import { splitForUtterance } from "./split-for-utterance";

export type TtsState = "idle" | "playing" | "paused";

/** SpeechSynthesisUtterance 的可 mock 收窄面。 */
export interface UtteranceLike {
  text: string;
  voice: SpeechSynthesisVoice | null;
  rate: number;
  onend: (() => void) | null;
  onerror: ((err?: unknown) => void) | null;
}

/** speechSynthesis 的可 mock 收窄面（真实现见 voices.ts 的 browserSpeechPort）。 */
export interface SpeechPort {
  createUtterance(text: string): UtteranceLike;
  speak(u: UtteranceLike): void;
  cancel(): void;
  pause(): void;
  resume(): void;
}

export interface TtsEngineEvents {
  /** 段开始朗读（驱动高亮与滚动）。 */
  onParagraphChange: (index: number) => void;
  onStateChange: (state: TtsState) => void;
  /** 队列读尽（spec 的 onChapterEnd——引擎不懂章节，集成层接「下一章」）。 */
  onQueueEnd: () => void;
  /** 单 utterance 失败（已跳过继续）；日志归集成层。 */
  onUtteranceError: (text: string, err: unknown) => void;
}

export interface PlayOptions {
  rate: number;
  /** 每个 utterance 文本 → voice（detect+pick 组合由集成层注入，引擎保持纯排队逻辑）。 */
  pickVoiceFor: (text: string) => SpeechSynthesisVoice | null;
}

/**
 * 段队列状态机（spec §4.3）：idle → playing ⇄ paused → idle。
 * generation 计数器使 cancel 后迟到的 onend/onerror 失效（部分平台 cancel
 * 会对挂起 utterance 触发 onend，不防会幽灵推进）。
 */
export function createTtsEngine(port: SpeechPort, events: TtsEngineEvents) {
  let state: TtsState = "idle";
  let gen = 0;
  let texts: string[] = [];
  let current = 0;
  let opts: PlayOptions = { rate: 1, pickVoiceFor: () => null };

  const setState = (s: TtsState) => {
    if (s === state) return;
    state = s;
    events.onStateChange(s);
  };

  /** spec §8 防御：pause 后直接 cancel 在部分平台不干净，统一先 resume。 */
  const hardCancel = () => {
    port.resume();
    port.cancel();
  };

  const speakChunks = (chunks: string[], ci: number, myGen: number) => {
    if (myGen !== gen) return;
    if (ci >= chunks.length) {
      playParagraph(current + 1, myGen);
      return;
    }
    const text = chunks[ci]!;
    const u = port.createUtterance(text);
    u.voice = opts.pickVoiceFor(text);
    u.rate = opts.rate;
    u.onend = () => speakChunks(chunks, ci + 1, myGen);
    u.onerror = (err) => {
      if (myGen !== gen) return;
      events.onUtteranceError(text, err);
      speakChunks(chunks, ci + 1, myGen);
    };
    port.speak(u);
  };

  const playParagraph = (i: number, myGen: number) => {
    if (myGen !== gen) return;
    if (i >= texts.length) {
      setState("idle");
      events.onQueueEnd();
      return;
    }
    current = i;
    events.onParagraphChange(i);
    speakChunks(splitForUtterance(texts[i]!), 0, myGen);
  };

  return {
    play(newTexts: string[], startIndex: number, o: PlayOptions) {
      gen++;
      hardCancel();
      texts = newTexts;
      opts = o;
      setState("playing");
      playParagraph(startIndex, gen);
    },
    pause() {
      if (state !== "playing") return;
      port.pause();
      setState("paused");
    },
    resume() {
      if (state !== "paused") return;
      port.resume();
      setState("playing");
    },
    stop() {
      if (state === "idle") return;
      gen++;
      hardCancel();
      setState("idle");
    },
    setRate(rate: number) {
      opts = { ...opts, rate };
      if (state === "idle") return;
      // 从当前段头以新 rate 重读（spec §4.3）
      gen++;
      hardCancel();
      setState("playing");
      playParagraph(current, gen);
    },
    state: () => state,
    currentIndex: () => current,
  };
}

export type TtsEngine = ReturnType<typeof createTtsEngine>;
```

- [ ] **Step 4: 跑测试确认通过**

```bash
pnpm test src/renderer/reader/tts/tts-engine.test.ts
```

- [ ] **Step 5: 提交**

```bash
git add -A && git commit -m "feat(tts): add paragraph-queue speech engine with generation guard"
```

---

### Task 7: `voices.ts`、`tts-css.ts`、`tts-store.ts`（薄胶水）

**Files:**

- Create: `src/renderer/reader/tts/voices.ts`
- Create: `src/renderer/reader/tts/tts-css.ts`
- Create: `src/renderer/store/tts-store.ts`

无单测（浏览器 API 薄封装 + 常量 + 两字段 store；逻辑已在前序任务覆盖）。

- [ ] **Step 1: `voices.ts`**

```ts
import { createLogger } from "@renderer/logger";
import type { SpeechPort } from "./tts-engine";
import type { TtsPlatform } from "./pick-voice";

const log = createLogger("tts");

/** 真 speechSynthesis 适配（接口见 tts-engine 的 SpeechPort）。 */
export function browserSpeechPort(): SpeechPort {
  const synth = window.speechSynthesis;
  return {
    createUtterance: (text) => new SpeechSynthesisUtterance(text),
    speak: (u) => synth.speak(u as SpeechSynthesisUtterance),
    cancel: () => synth.cancel(),
    pause: () => synth.pause(),
    resume: () => synth.resume(),
  };
}

let voicesCache: SpeechSynthesisVoice[] | null = null;

/**
 * getVoices() 首次调用可能返回空数组（spec §4.4）：等 voiceschanged，
 * 超时兜底返回当前列表（可能仍空——pickVoice 对空列表返回 null，引擎默认行为朗读）。
 */
export function getVoicesReady(timeoutMs = 2000): Promise<SpeechSynthesisVoice[]> {
  if (voicesCache?.length) return Promise.resolve(voicesCache);
  const synth = window.speechSynthesis;
  const now = synth.getVoices();
  if (now.length > 0) {
    voicesCache = now;
    return Promise.resolve(now);
  }
  return new Promise((resolve) => {
    const finish = (list: SpeechSynthesisVoice[]) => {
      voicesCache = list;
      resolve(list);
    };
    const timer = setTimeout(() => {
      log.warn("voiceschanged timed out, proceeding with current voice list");
      finish(synth.getVoices());
    }, timeoutMs);
    synth.addEventListener(
      "voiceschanged",
      () => {
        clearTimeout(timer);
        finish(synth.getVoices());
      },
      { once: true },
    );
  });
}

export function currentPlatform(): TtsPlatform {
  const p = navigator.platform.toLowerCase();
  if (p.includes("mac")) return "macos";
  if (p.includes("win")) return "windows";
  return "linux";
}
```

- [ ] **Step 2: `tts-css.ts`**

```ts
/**
 * 注入 section iframe 的 TTS 当前段高亮样式（CSS Custom Highlight API；spec §6）。
 * 半透明暖橙：亮/暗两态均可读（同 PDF overlay 的透明度哲学），与标注五色（黄绿蓝粉紫）区分。
 */
export const TTS_IFRAME_CSS = `::highlight(tts-current) { background-color: rgba(251, 146, 60, 0.3); }`;
```

- [ ] **Step 3: `tts-store.ts`**

```ts
import { create } from "zustand";
import type { TtsState } from "@renderer/reader/tts/tts-engine";

interface TtsUiState {
  /** TTS 会话状态（控制条显隐 + 播放/暂停按钮态）。由 tts-controller 单向写入。 */
  status: TtsState;
}

/** TTS 运行态发布（非持久化；偏好在 prefs-store.ttsPrefs）。 */
export const useTtsStore = create<TtsUiState>()(() => ({ status: "idle" }));
```

- [ ] **Step 4: typecheck + 提交**

```bash
pnpm typecheck
git add -A && git commit -m "feat(tts): add speech port, voices readiness, highlight css and status store"
```

---

### Task 8: `tts-controller.ts` 集成单例

**Files:**

- Create: `src/renderer/reader/tts/tts-controller.ts`

控制器是 DOM 编排胶水（视口判定/iframe 轮询/滚动），状态机与纯函数已各自有测试；本文件靠 typecheck + 冒烟验证。

- [ ] **Step 1: 实现**

```ts
import { createLogger } from "@renderer/logger";
import { usePrefsStore } from "@renderer/store/prefs-store";
import { useTtsStore } from "@renderer/store/tts-store";
import { detectParagraphLang } from "./detect-lang";
import { pickVoice } from "./pick-voice";
import { segmentParagraphs, type TtsParagraph } from "./segment-paragraphs";
import { createTtsEngine, type TtsEngine } from "./tts-engine";
import { browserSpeechPort, currentPlatform, getVoicesReady } from "./voices";

const log = createLogger("tts");

/** EpubReader attach 进来的上下文（卸载时 detach）。 */
export interface ReaderTtsContext {
  sectionCount: number;
  getTopSectionIndex: () => number;
  scrollToSection: (index: number) => void;
}

const SECTION_DOC_POLL_MS = 100;
const SECTION_DOC_TIMEOUT_MS = 5000;
/** 自动滚动后的 scroll 事件忽略窗（区分用户滚动以挂起跟随）。 */
const AUTO_SCROLL_IGNORE_MS = 300;

function sectionDoc(index: number): Document | null {
  const frame = document.querySelector<HTMLIFrameElement>(`[data-section-index="${index}"] iframe`);
  const doc = frame?.contentDocument ?? null;
  return doc?.body && doc.body.childNodes.length > 0 ? doc : null;
}

function sectionFrame(index: number): HTMLIFrameElement | null {
  return document.querySelector<HTMLIFrameElement>(`[data-section-index="${index}"] iframe`);
}

function scrollerEl(): Element | null {
  return document.querySelector(".no-scrollbar");
}

/** 视口内第一个可见段；无（图片页等）→ 0（spec §6：从该 section 第一段起）。 */
function firstVisibleParagraph(paras: TtsParagraph[], frame: HTMLIFrameElement): number {
  const scroller = scrollerEl();
  if (!scroller) return 0;
  const frameTop = frame.getBoundingClientRect().top;
  const view = scroller.getBoundingClientRect();
  for (let i = 0; i < paras.length; i++) {
    const r = paras[i]!.element.getBoundingClientRect(); // iframe 不内滚：主坐标 = frameTop + r
    if (frameTop + r.bottom > view.top + 4 && frameTop + r.top < view.bottom) return i;
  }
  return 0;
}

class TtsController {
  private ctx: ReaderTtsContext | null = null;
  private engine: TtsEngine | null = null;
  private paragraphs: TtsParagraph[] = [];
  private sectionIndex = 0;
  private voices: SpeechSynthesisVoice[] = [];
  /** 自动跨章中：忽略引擎的瞬时 idle、抑制用户导航打断判定。 */
  private crossing = false;
  private followSuspended = false;
  private ignoreScrollUntil = 0;
  private readonly onScrollerScroll = () => {
    if (performance.now() > this.ignoreScrollUntil && this.status() !== "idle") {
      this.followSuspended = true;
    }
  };

  attach(ctx: ReaderTtsContext): void {
    this.ctx = ctx;
    // scroll 不冒泡但可捕获（EpubReader 既有同款监听）；iframe 内滚轮经 VirtualDocs 转发
    // 后最终体现为 scroller 滚动，捕获 document scroll 即可观测到。
    document.addEventListener("scroll", this.onScrollerScroll, true);
  }

  detach(): void {
    this.stop();
    document.removeEventListener("scroll", this.onScrollerScroll, true);
    this.ctx = null;
  }

  status() {
    return useTtsStore.getState().status;
  }

  async playFromViewport(): Promise<void> {
    const ctx = this.ctx;
    if (!ctx) return;
    this.voices = await getVoicesReady();
    const index = ctx.getTopSectionIndex();
    const doc = sectionDoc(index);
    const frame = sectionFrame(index);
    if (!doc || !frame) {
      log.warn(`play aborted: section ${index} iframe not ready`);
      return;
    }
    const paras = segmentParagraphs(doc.body);
    if (paras.length === 0) {
      log.warn(`play aborted: section ${index} has no readable paragraphs`);
      return;
    }
    this.followSuspended = false;
    this.startSection(index, paras, firstVisibleParagraph(paras, frame));
  }

  pause(): void {
    this.engine?.pause();
  }

  resume(): void {
    this.followSuspended = false;
    this.engine?.resume();
  }

  stop(): void {
    this.crossing = false;
    this.engine?.stop();
    this.clearHighlight();
  }

  setRate(rate: number): void {
    this.engine?.setRate(rate);
  }

  /** 用户主动导航（跳章/标注跳转）→ 打断（spec §6）；自动跨章不算。 */
  notifyUserNavigation(): void {
    if (this.crossing || this.status() === "idle") return;
    this.stop();
  }

  private ensureEngine(): TtsEngine {
    if (this.engine) return this.engine;
    this.engine = createTtsEngine(browserSpeechPort(), {
      onParagraphChange: (i) => this.onParagraph(i),
      onStateChange: (s) => {
        if (this.crossing && s === "idle") return; // 跨章瞬时 idle 不发布
        useTtsStore.setState({ status: s });
      },
      onQueueEnd: () => void this.advanceSection(),
      onUtteranceError: (text, err) => log.warn(`utterance failed: ${text.slice(0, 40)}`, err),
    });
    return this.engine;
  }

  private startSection(index: number, paras: TtsParagraph[], startPara: number): void {
    const prefs = usePrefsStore.getState().ttsPrefs;
    const platform = currentPlatform();
    this.sectionIndex = index;
    this.paragraphs = paras;
    this.ensureEngine().play(
      paras.map((p) => p.text),
      startPara,
      {
        rate: prefs.rate,
        pickVoiceFor: (text) => pickVoice(detectParagraphLang(text), this.voices, prefs, platform),
      },
    );
  }

  private async advanceSection(): Promise<void> {
    const ctx = this.ctx;
    if (!ctx) return;
    let next = this.sectionIndex + 1;
    this.crossing = true;
    try {
      while (next < ctx.sectionCount) {
        this.ignoreScrollUntil = performance.now() + AUTO_SCROLL_IGNORE_MS + SECTION_DOC_TIMEOUT_MS;
        ctx.scrollToSection(next);
        const doc = await this.waitForSectionDoc(next);
        if (!doc) {
          log.warn(`section ${next} iframe not ready in time, stopping`);
          break;
        }
        const paras = segmentParagraphs(doc.body);
        if (paras.length > 0) {
          this.ignoreScrollUntil = performance.now() + AUTO_SCROLL_IGNORE_MS;
          this.startSection(next, paras, 0);
          this.crossing = false;
          return;
        }
        next++; // 空 section（封面图等）继续向后
      }
    } finally {
      if (this.crossing) {
        this.crossing = false;
        this.clearHighlight();
        useTtsStore.setState({ status: "idle" }); // 书末/失败：收口为停止态
      }
    }
  }

  private waitForSectionDoc(index: number): Promise<Document | null> {
    return new Promise((resolve) => {
      const deadline = performance.now() + SECTION_DOC_TIMEOUT_MS;
      const tick = () => {
        if (this.crossing === false) return resolve(null); // 等待中被 stop
        const doc = sectionDoc(index);
        if (doc) return resolve(doc);
        if (performance.now() > deadline) return resolve(null);
        setTimeout(tick, SECTION_DOC_POLL_MS);
      };
      tick();
    });
  }

  private onParagraph(i: number): void {
    const para = this.paragraphs[i];
    const doc = sectionDoc(this.sectionIndex);
    if (!para || !doc) return;
    this.applyHighlight(doc, para.element);
    if (!this.followSuspended) this.scrollToParagraph(para.element);
  }

  private applyHighlight(doc: Document, el: Element): void {
    const win = doc.defaultView;
    if (!win?.CSS?.highlights) return;
    const range = doc.createRange();
    range.selectNodeContents(el);
    // 用 iframe realm 的 Highlight 构造器（跨 realm Range 注册不可靠）
    win.CSS.highlights.set("tts-current", new win.Highlight(range));
  }

  private clearHighlight(): void {
    const doc = sectionDoc(this.sectionIndex);
    doc?.defaultView?.CSS?.highlights?.delete("tts-current");
  }

  private scrollToParagraph(el: Element): void {
    const frame = sectionFrame(this.sectionIndex);
    const scroller = scrollerEl();
    if (!frame || !scroller) return;
    const view = scroller.getBoundingClientRect();
    const topMain = frame.getBoundingClientRect().top + el.getBoundingClientRect().top;
    if (topMain >= view.top && topMain <= view.bottom - 80) return; // 已可见
    this.ignoreScrollUntil = performance.now() + AUTO_SCROLL_IGNORE_MS;
    scroller.scrollBy({ top: topMain - view.top - view.height / 3 });
  }
}

/** 模块单例：顶栏/控制条直接调方法（命令式），状态经 useTtsStore 发布。 */
export const ttsController = new TtsController();
```

注：若 typecheck 报 `win.Highlight` / `CSS.highlights` 类型缺失（lib.dom 版本差异），在文件顶补最小声明：

```ts
declare global {
  interface Window {
    Highlight: typeof Highlight;
  }
}
```

（先直接 typecheck，过了就不加。）

- [ ] **Step 2: typecheck + 提交**

```bash
pnpm typecheck
git add -A && git commit -m "feat(tts): add reader tts controller (cross-section playback, highlight, follow-scroll)"
```

---

### Task 9: EpubReader 集成

**Files:**

- Modify: `src/renderer/reader/EpubReader.tsx`

- [ ] **Step 1: 接线**

四处修改：

① import 区追加：

```ts
import { ttsController } from "./tts/tts-controller";
import { TTS_IFRAME_CSS } from "./tts/tts-css";
```

② `topChapterIdRef` 旁加 section 索引 ref，并在 `onTopSectionChange` 开头维护：

```ts
// TTS 起读用：最近一次滚动得出的顶部 section 索引。
const topSectionIndexRef = useRef(0);
```

`onTopSectionChange` 函数体第一行（`if (!book) return;` 之后）加：

```ts
topSectionIndexRef.current = index;
```

③ attach/detach + 打断接线。`book` 就绪后 attach（放在「精确恢复」effect 之后）：

```ts
// TTS：book 就绪即挂接上下文；卸载/换书 detach（内部停止朗读并清高亮）。
useEffect(() => {
  if (!book) return;
  ttsController.attach({
    sectionCount: book.count,
    getTopSectionIndex: () => topSectionIndexRef.current,
    scrollToSection: (i) => vRef.current?.scrollToIndex(i),
  });
  return () => ttsController.detach();
}, [book]);
```

跳章 effect（`currentChapterId` 变化那个）中，在 `if (currentChapterId === topChapterIdRef.current) return;` 之后加一行——该判定之后才是「用户主动跳章」：

```ts
ttsController.notifyUserNavigation();
```

侧栏标注跳转 effect（`scrollCommand`）中，`scrollToCfi(scrollCommand.locator);` 之前加：

```ts
ttsController.notifyUserNavigation();
```

④ styleCss 拼接追加（`readerThemeCss(...)` 之后）：

```ts
readerThemeCss(resolvedTheme === "dark") + "\n" + TTS_IFRAME_CSS;
```

- [ ] **Step 2: typecheck + 全测 + 提交**

```bash
pnpm typecheck && pnpm test
git add -A && git commit -m "feat(tts): wire tts controller into EpubReader"
```

---

### Task 10: 顶栏按钮 + 浮动控制条

**Files:**

- Create: `src/renderer/reader/TtsControlBar.tsx`
- Modify: `src/renderer/reader/ReaderView.tsx`

- [ ] **Step 1: `TtsControlBar.tsx`**

```tsx
import { useTranslation } from "react-i18next";
import { Pause, Play, Square } from "lucide-react";
import { Button } from "@renderer/components/ui/button";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@renderer/components/ui/select";
import { usePrefsStore } from "@renderer/store/prefs-store";
import { useTtsStore } from "@renderer/store/tts-store";
import { ttsController } from "@renderer/reader/tts/tts-controller";

const RATE_OPTIONS = [0.5, 0.75, 1, 1.25, 1.5, 2];

/** 朗读浮动控制条（spec §7.1）：正文区底部胶囊；status=idle 时不渲染。 */
export function TtsControlBar() {
  const { t } = useTranslation();
  const status = useTtsStore((s) => s.status);
  const rate = usePrefsStore((s) => s.ttsPrefs.rate);
  const updateTtsPrefs = usePrefsStore((s) => s.updateTtsPrefs);
  if (status === "idle") return null;

  const toggleLabel =
    status === "playing" ? t("reader.tts.pause", "暂停") : t("reader.tts.resume", "继续");
  return (
    <div className="absolute bottom-6 left-1/2 z-10 flex -translate-x-1/2 items-center gap-1 rounded-full border bg-popover px-2 py-1 shadow-md">
      <Button
        variant="ghost"
        size="icon"
        aria-label={toggleLabel}
        onClick={() => (status === "playing" ? ttsController.pause() : ttsController.resume())}
      >
        {status === "playing" ? <Pause /> : <Play />}
      </Button>
      <Button
        variant="ghost"
        size="icon"
        aria-label={t("reader.tts.stop", "停止")}
        onClick={() => ttsController.stop()}
      >
        <Square />
      </Button>
      <Select
        value={String(rate)}
        onValueChange={(val) => {
          const r = Number(val);
          updateTtsPrefs({ rate: r });
          ttsController.setRate(r);
        }}
      >
        <SelectTrigger
          className="h-8 w-20 border-none shadow-none"
          aria-label={t("reader.tts.rate", "语速")}
        >
          <SelectValue />
        </SelectTrigger>
        <SelectContent>
          {RATE_OPTIONS.map((r) => (
            <SelectItem key={r} value={String(r)}>
              {r}×
            </SelectItem>
          ))}
        </SelectContent>
      </Select>
    </div>
  );
}
```

注：先读 `src/renderer/components/ui/select.tsx` 确认导出名（Base UI 版 shadcn 的 Select 子组件命名可能略异——`SelectValue` 或 `SelectTrigger` 写法以该文件实际导出为准，相应调整）。

- [ ] **Step 2: ReaderView 接线**

① import 追加：

```ts
import { Volume2 } from "lucide-react";
import { TtsControlBar } from "@renderer/reader/TtsControlBar";
import { ttsController } from "@renderer/reader/tts/tts-controller";
import { useTtsStore } from "@renderer/store/tts-store";
```

② 组件内取状态（与其它 store 选择器并列）：

```ts
const ttsStatus = useTtsStore((s) => s.status);
```

③ 顶栏朗读按钮：放在 `{!book.isPending && (book.data?.format === "pdf" ? <PdfPrefs /> : <ReaderPrefs />)}` 之后、AI 面板开关之前。仅 ePub 显示；idle 时点击开播，播放中点击停止：

```tsx
{
  !book.isPending && book.data?.format !== "pdf" && (
    <Tooltip>
      <TooltipTrigger
        render={
          <Button
            variant="ghost"
            size="icon"
            onClick={() =>
              ttsStatus === "idle" ? void ttsController.playFromViewport() : ttsController.stop()
            }
            aria-label={
              ttsStatus === "idle" ? t("reader.tts.start", "朗读") : t("reader.tts.stop", "停止")
            }
            className="text-muted-foreground"
          />
        }
      >
        <Volume2 className={ttsStatus !== "idle" ? "text-primary" : undefined} />
      </TooltipTrigger>
      <TooltipContent>
        {ttsStatus === "idle" ? t("reader.tts.start", "朗读") : t("reader.tts.stop", "停止")}
      </TooltipContent>
    </Tooltip>
  );
}
```

④ `<main>` 加 `relative` 并挂控制条（顶栏收起时控制条仍可见——spec §7.1）：

```tsx
<main className="relative min-w-0 flex-1">
  {book.isPending ? null : book.data?.format === "pdf" ? (
    <PdfReader bookId={bookId} chapters={chapters.data ?? []} />
  ) : (
    <EpubReader bookId={bookId} chapters={chapters.data ?? []} />
  )}
  <TtsControlBar />
</main>
```

- [ ] **Step 3: typecheck + 提交**

```bash
pnpm typecheck
git add -A && git commit -m "feat(tts): add header read-aloud button and floating control bar"
```

---

### Task 11: 设置页「朗读」区

**Files:**

- Modify: `src/renderer/settings/ReadingSettings.tsx`

- [ ] **Step 1: 实现**

在既有 `autoSummarize` 区块之后追加「朗读」小节。voice 行：zh / en 两语种下拉（值 = `voice.name`，空 = 自动），右侧试听按钮；语速下拉与控制条同款档位。

```tsx
// import 追加
import { useEffect, useState } from "react";
import { Volume2 } from "lucide-react";
import { Button } from "@renderer/components/ui/button";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@renderer/components/ui/select";
import { NOVELTY_BLOCKLIST } from "@renderer/reader/tts/pick-voice";
import { getVoicesReady } from "@renderer/reader/tts/voices";
import type { TtsLang } from "@renderer/reader/tts/detect-lang";

const RATE_OPTIONS = [0.5, 0.75, 1, 1.25, 1.5, 2];
const AUTO_VALUE = "__auto__"; // Select 空值哨兵（Base UI Select 不接受 "" item）
const PREVIEW_TEXT: Record<string, string> = {
  zh: "你好，这是朗读功能的试听。",
  en: "Hello, this is a read-aloud preview.",
};

function VoiceRow({ lang, label }: { lang: TtsLang; label: string }) {
  const { t } = useTranslation();
  const ttsPrefs = usePrefsStore((s) => s.ttsPrefs);
  const updateTtsPrefs = usePrefsStore((s) => s.updateTtsPrefs);
  const [voices, setVoices] = useState<SpeechSynthesisVoice[]>([]);
  useEffect(() => {
    let alive = true;
    void getVoicesReady().then((list) => {
      if (alive) setVoices(list);
    });
    return () => {
      alive = false;
    };
  }, []);
  const options = voices.filter(
    (v) => v.lang.toLowerCase().startsWith(lang) && !NOVELTY_BLOCKLIST.includes(v.name),
  );
  const selected = ttsPrefs.voiceByLang[lang] ?? AUTO_VALUE;
  const preview = () => {
    const u = new SpeechSynthesisUtterance(PREVIEW_TEXT[lang]);
    const v = options.find((o) => o.name === ttsPrefs.voiceByLang[lang]);
    if (v) u.voice = v;
    u.rate = ttsPrefs.rate;
    window.speechSynthesis.cancel();
    window.speechSynthesis.speak(u);
  };
  return (
    <div className="flex items-center justify-between gap-3">
      <span className="text-sm">{label}</span>
      <div className="flex items-center gap-1">
        <Select
          value={selected}
          onValueChange={(val) => {
            const next = { ...ttsPrefs.voiceByLang };
            if (val === AUTO_VALUE) delete next[lang];
            else next[lang] = val;
            updateTtsPrefs({ voiceByLang: next });
          }}
        >
          <SelectTrigger className="w-44" aria-label={label}>
            <SelectValue />
          </SelectTrigger>
          <SelectContent>
            <SelectItem value={AUTO_VALUE}>
              {t("settings.tts.autoVoice", "自动（推荐）")}
            </SelectItem>
            {options.map((v) => (
              <SelectItem key={v.name} value={v.name}>
                {v.name}
              </SelectItem>
            ))}
          </SelectContent>
        </Select>
        <Button
          variant="ghost"
          size="icon"
          aria-label={t("settings.tts.preview", "试听")}
          onClick={preview}
        >
          <Volume2 />
        </Button>
      </div>
    </div>
  );
}
```

组件 JSX 中 `autoSummarize` 区块后追加：

```tsx
<div className="space-y-3">
  <h3 className="text-sm font-medium">{t("settings.tts.title", "朗读")}</h3>
  <div className="flex items-center justify-between gap-3">
    <span className="text-sm">{t("settings.tts.rate", "语速")}</span>
    <Select
      value={String(ttsPrefs.rate)}
      onValueChange={(val) => updateTtsPrefs({ rate: Number(val) })}
    >
      <SelectTrigger className="w-44" aria-label={t("settings.tts.rate", "语速")}>
        <SelectValue />
      </SelectTrigger>
      <SelectContent>
        {RATE_OPTIONS.map((r) => (
          <SelectItem key={r} value={String(r)}>
            {r}×
          </SelectItem>
        ))}
      </SelectContent>
    </Select>
  </div>
  <VoiceRow lang="zh" label={t("settings.tts.voiceZh", "中文 voice")} />
  <VoiceRow lang="en" label={t("settings.tts.voiceEn", "英文 voice")} />
</div>
```

（组件顶部需补 `const ttsPrefs = usePrefsStore((s) => s.ttsPrefs);` 与 `const updateTtsPrefs = usePrefsStore((s) => s.updateTtsPrefs);`。Select 导出名同 Task 10 注意事项。）

- [ ] **Step 2: typecheck + 提交**

```bash
pnpm typecheck
git add -A && git commit -m "feat(tts): add read-aloud settings section (rate + per-language voice + preview)"
```

---

### Task 12: i18n、lint、全测、changeset

- [ ] **Step 1: i18n 抽取与英文翻译**

```bash
pnpm i18n:extract
```

抽取后检查 `src/shared/i18n/locales/zh-CN.ts`（应已带中文默认值）与 `en.ts`，给 en 手补翻译（参考：`reader.tts.start` = "Read aloud"、`pause` = "Pause"、`resume` = "Resume"、`stop` = "Stop"、`rate` = "Speed"、`settings.tts.title` = "Read aloud"、`settings.tts.rate` = "Speed"、`settings.tts.autoVoice` = "Auto (recommended)"、`settings.tts.preview` = "Preview"、`settings.tts.voiceZh` = "Chinese voice"、`settings.tts.voiceEn` = "English voice"）。然后：

```bash
pnpm i18n:lint
```

注意 i18n 既往坑：extract 可能用旧 fallback 反向覆盖 locale 修正——extract 后 `git diff src/shared/i18n` 逐行确认无误伤。

- [ ] **Step 2: lint + format + 全测**

```bash
pnpm lint && pnpm format:check && pnpm test
```

预期全绿（format 不过就跑 `pnpm format`）。

- [ ] **Step 3: changeset**

创建 `.changeset/tts-read-aloud.md`：

```md
---
"marginalia": minor
---

Add read-aloud (TTS) for ePub books: play from the current position with automatic chapter continuation, paragraph highlight that follows the speech, a floating control bar (pause/resume/stop/speed), and per-language voice selection with preview in Settings. Voices are matched to the content language of each paragraph, not the UI language.
```

- [ ] **Step 4: 提交**

```bash
git add -A && git commit -m "chore(tts): i18n strings and changeset"
```

---

### Task 13: 冒烟验证（真 app）

- [ ] **Step 1: 启动 dev app 冒烟**

```bash
pnpm start
```

（如走 CDP 自动化：`--remote-debugging-port` + playwright-core `connectOverCDP`（必须 ws URL）；dev 传 Chromium 开关恰好一个 `--`。）

冒烟清单（中文书 + 英文书各验）：

1. 顶栏喇叭按钮仅 ePub 书显示；点击后从当前视口位置开始朗读，底部控制条浮现。
2. **中文书读中文 voice、英文书读英文 voice**（不被 UI 语言带偏——issue 核心坑）；中文书内英文段落切英文 voice。
3. 当前段橙色高亮，随朗读推进；段不在视口时自动滚动跟随；手动滚走后不再抢滚动条，按暂停→继续后恢复跟随。
4. 读完一章自动续下一章；封面/图片 section 自动跳过；书末自然停止、控制条收起。
5. 暂停/继续/停止按钮行为正确；语速切换立即生效（从当前段头重读）。
6. 设置页「朗读」区：换中文 voice 后重新播放生效；试听按钮发声；重启 app 后语速与 voice 选择保留（`ttsPrefs` 落盘）。
7. 朗读中点 TOC 跳章/点标注跳转 → 朗读停止；返回书库 → 朗读停止。
8. 暗色模式下高亮可读。

- [ ] **Step 2: 修复冒烟发现的问题并提交**

每个修复独立 commit（`fix(tts): ...`）。

---

### Task 14: 收尾

- [ ] **Step 1: 合并交付**

invoke superpowers:finishing-a-development-branch skill；合并 commit message 含 `closes #61`（本地 rebase 线性工作流：rebase 回 main，不要 merge commit）。

- [ ] **Step 2: kanban 挪卡**

issue 关闭后把 #61 卡挪到 Done（合并推送 main 后 GitHub 自动关 issue + 自动挪卡；确认即可，未自动则按 kanban skill 手动）。

---

## Self-Review 记录

- **Spec 覆盖**：§4.1→Task 4、§4.2→Task 2/3、§4.3→Task 5/6、§4.4→Task 7、§5→Task 3、§6→Task 8/9、§7.1→Task 10、§7.2→Task 1、§7.3→Task 11、§8 测试→各任务 TDD + Task 13 冒烟。
- **类型一致性**：`TtsParagraph`（Task 4）被 Task 8 消费；`SpeechPort`/`UtteranceLike`（Task 6）被 Task 7 `browserSpeechPort` 实现；`TtsLang`（Task 2）贯穿 Task 3/11；`TtsPrefs`（Task 1）贯穿 Task 8/10/11。
- **已知留白（有意）**：macOS 推荐 voice 名单与 novelty 黑名单按 spike 信息给出初始值，Task 13 冒烟时按实际 `getVoices()` 结果微调名单（属数据校准，非结构变更）。
