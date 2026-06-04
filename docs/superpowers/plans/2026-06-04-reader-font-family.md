# 正文字体切换实现计划

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 阅读偏好里可切换正文字体(原书默认 / 文楷 / 宋体 / 黑体),打包三款中文阅读字体,@font-face 注入 section iframe。

**Architecture:** `readerPrefs` 新增 `fontFamily` 枚举字段(`.default("default")` 保旧数据兼容,复用现有持久化流水线,零新 IPC);`prefsToCss()` 按档位输出 `font-family` 覆盖规则;@fontsource 切片 CSS 经 vite `?inline` 取字符串、只拼当前档进 `styleCss` 注入每个 section iframe;ReaderPrefs 浮窗加 2×2 字体选择按钮(按钮用自家字体渲染预览)。

**Tech Stack:** `@fontsource/lxgw-wenkai`、`@fontsource/noto-serif-sc`、`@fontsource/noto-sans-sc`(切片 woff2)、vite `?inline`、Zod 4、zustand、i18next。

**Spec:** `docs/superpowers/specs/2026-06-04-reader-font-family-design.md`

**分支:** `feat/reader-font-family`(已从本地 main 切出)

**关键背景(执行者必读):**

- vitest 跑在 Electron 运行时(`pnpm test`),better-sqlite3 永远 Electron ABI;`pnpm install`/`pnpm add` 后 postinstall 自动 rebuild,无需手动。
- prek pre-commit hook 可能以 "files were modified by this hook" 中止提交:重新 `git add` 被改文件、原命令再跑一次即可。
- 提交信息用 Conventional Commits。
- i18n:locale 是 `src/shared/i18n/locales/{zh-CN,en}.ts` 平铺键;代码里 `t("key", "中文默认值")` 后跑 `pnpm i18n:extract` 同步 zh-CN(primary),en.ts 需**手动**补英文;extract 先于 typecheck(i18next.d.ts 强类型,缺键会红)。extract 后 `git diff` 检查没误清空 en.ts 既有键。
- dev CDP 冒烟:`pnpm start` 透传 Chromium 开关**恰好一个 `--`**(多一个裸 `--` 会静默失效)。
- 渲染层启用 React Compiler:别手写 useCallback/useMemo。
- UI 样式规范:优先 Tailwind 类;内联 `style` 仅允许运行时计算值(字体预览按钮的 `fontFamily` 来自数据表,属于此例外)。

---

### Task 1: 安装字体依赖并确认包内文件名

**Files:**

- Modify: `package.json`、`pnpm-lock.yaml`(由 pnpm 自动)

- [ ] **Step 1: 安装三个 fontsource 包**

```bash
pnpm add @fontsource/lxgw-wenkai @fontsource/noto-serif-sc @fontsource/noto-sans-sc
```

Expected: 安装成功,postinstall 自动跑 `db:rebuild:electron`(better-sqlite3 回 Electron ABI)。

- [ ] **Step 2: 确认各包提供的 CSS 文件名(后续 import 路径依据)**

```bash
ls node_modules/@fontsource/lxgw-wenkai/ | grep -E "^(400|700|index)\.css$"
ls node_modules/@fontsource/noto-serif-sc/ | grep -E "^(400|700)\.css$"
ls node_modules/@fontsource/noto-sans-sc/ | grep -E "^(400|700)\.css$"
ls node_modules/@fontsource-variable/fraunces/ | grep -iE "ital|wght|index"
ls node_modules/@fontsource-variable/manrope/ | grep -iE "wght|index"
```

Expected: 三个中文包都有 `400.css` 与 `700.css`;fraunces 有 `wght.css` 与 italic 变体(预期名 `wght-italic.css`);manrope 有 `wght.css`。
**若实际文件名与 Task 4 代码中的 import 路径不符,以本步输出为准修正 Task 4 的 import。**(若某包缺 700.css,删去对应 import,浏览器会合成粗体。)

- [ ] **Step 3: 跑测试确认 ABI 正常**

```bash
pnpm test src/shared/preferences.test.ts
```

Expected: PASS(说明 postinstall rebuild 正常)。

- [ ] **Step 4: 提交依赖**

```bash
git add package.json pnpm-lock.yaml
git commit -m "chore(deps): add cjk reading fonts (lxgw-wenkai, noto serif/sans sc)"
```

---

### Task 2: Spike——验证 `?inline` 切片 CSS 在 srcdoc iframe 中能加载字体(dev)

> 这是 spec 列的最大风险点:vite rebase 后的 `url()` 在 srcdoc iframe(base 继承父文档)下能否解析。验证通过才继续;失败则停下来向主会话汇报(候选对策:woff2 转 base64 内联、自定义协议、改注入 `<link>`)。**本任务的代码改动是临时的,验证后全部撤销,不提交。**

**Files:**

- 临时修改(验证后撤销): `src/renderer/reader/EpubReader.tsx`

- [ ] **Step 1: 临时改 EpubReader 注入文楷**

在 `src/renderer/reader/EpubReader.tsx` 顶部 import 区加:

```ts
// @ts-expect-error spike: ?inline 声明在正式任务补
import wenkai400 from "@fontsource/lxgw-wenkai/400.css?inline";
```

把 `styleCss={...}` 的拼接改为(在 `prefsToCss(prefs)` 前面多拼两段):

```tsx
styleCss={
  wenkai400 +
  '\nbody, body * { font-family: "LXGW WenKai" !important; }\n' +
  prefsToCss(prefs) +
  "\n" +
  ANNO_IFRAME_CSS +
  "\n" +
  readerThemeCss(resolvedTheme === "dark")
}
```

- [ ] **Step 2: 后台启动 dev(带 CDP 端口,用 dev 库现成书)**

```bash
pnpm start -- --remote-debugging-port=9222
```

(后台运行;dev 用 `marginalia-dev` userData,书库应有书。若书库为空,先用 Task 8 Step 2 的脚本造 `/tmp/font-smoke.epub`,启动后拖入或经 CDP 调 `window.api` 导入——preload 暴露形状先 `grep -n "importBook" src/preload.ts` 确认。)

- [ ] **Step 3: 写 CDP eval 工具脚本(后续任务复用)**

写入 `/tmp/cdp-eval.mjs`:

```js
// 用法: node /tmp/cdp-eval.mjs <port> '<js-expression>'
const [port, expr] = process.argv.slice(2);
const targets = await (await fetch(`http://localhost:${port}/json`)).json();
const page = targets.find((t) => t.type === "page" && !t.url.startsWith("devtools"));
if (!page) {
  console.error("no page target");
  process.exit(1);
}
const ws = new WebSocket(page.webSocketDebuggerUrl);
await new Promise((res, rej) => {
  ws.onopen = res;
  ws.onerror = rej;
});
const result = await new Promise((resolve) => {
  ws.onmessage = (e) => {
    const m = JSON.parse(e.data);
    if (m.id === 1) resolve(m.result);
  };
  ws.send(
    JSON.stringify({
      id: 1,
      method: "Runtime.evaluate",
      params: { expression: expr, awaitPromise: true, returnByValue: true },
    }),
  );
});
console.log(JSON.stringify(result?.result?.value ?? result, null, 2));
ws.close();
```

- [ ] **Step 4: 打开一本书(CDP 点击书卡)**

先 dump 书库 DOM 确定书卡选择器,再点击:

```bash
node /tmp/cdp-eval.mjs 9222 'document.body.innerHTML.slice(0, 2000)'
# 据输出找到书卡元素,例如:
node /tmp/cdp-eval.mjs 9222 'document.querySelectorAll("main img")[0]?.closest("[class]")?.click() ?? "no card"'
```

Expected: 阅读视图出现(再次 dump DOM 应见 iframe)。

- [ ] **Step 5: 断言 iframe 内文楷已加载**

```bash
node /tmp/cdp-eval.mjs 9222 '(async () => {
  const f = document.querySelector("iframe");
  if (!f?.contentDocument) return "no iframe";
  const d = f.contentDocument;
  await d.fonts.ready;
  const p = d.querySelector("p") ?? d.body;
  return {
    computed: d.defaultView.getComputedStyle(p).fontFamily,
    wenkaiLoaded: d.fonts.check("16px \"LXGW WenKai\""),
    fontFaces: d.fonts.size,
  };
})()'
```

Expected: `computed` 含 `LXGW WenKai`,`wenkaiLoaded: true`,`fontFaces > 0`。
**若 `wenkaiLoaded: false`**:检查 devtools 网络错误——`node /tmp/cdp-eval.mjs 9222 '...'` 改查 `performance.getEntriesByType("resource").filter(r => r.name.includes("woff"))`(在 iframe 的 `contentWindow` 上查)。定位是 URL 解析问题还是 CSP 问题,停下汇报。

- [ ] **Step 6: 撤销临时改动并停掉 dev**

```bash
git checkout -- src/renderer/reader/EpubReader.tsx
git status --short   # 应只剩(若有)未跟踪的 /tmp 外文件,工作树干净
```

停掉后台 `pnpm start` 进程(用启动时记下的 shell/task 句柄停止;**不要**宽 `pkill electron`,可能误杀别的 worktree)。

---

### Task 3: shared schema——`fontFamily` 字段(TDD)

**Files:**

- Modify: `src/shared/preferences.ts:5-11`
- Modify: `src/renderer/store/prefs-store.ts:25`(`PREFS_INITIAL` 补字段,保 typecheck 绿)
- Modify: `src/renderer/reader/prefs-to-css.test.ts:6,13`(现有两个调用补 `fontFamily: "default"`,保 typecheck 绿)
- Test: `src/shared/preferences.test.ts`

- [ ] **Step 1: 写失败测试**

在 `src/shared/preferences.test.ts` 的 `describe("preferences schemas")` 块内追加:

```ts
it("readerPrefs 旧 JSON(无 fontFamily)parse 成功且默认 default", () => {
  const parsed = readerPrefsSchema.parse({ fontScale: 1, lineHeight: 1.9, maxWidth: 640 });
  expect(parsed.fontFamily).toBe("default");
});

it("fontFamily 接受四档枚举、拒绝未知值", () => {
  const base = { fontScale: 1, lineHeight: 1.9, maxWidth: 640 };
  for (const v of ["default", "wenkai", "serif", "sans"]) {
    expect(readerPrefsSchema.safeParse({ ...base, fontFamily: v }).success).toBe(true);
  }
  expect(readerPrefsSchema.safeParse({ ...base, fontFamily: "comic-sans" }).success).toBe(false);
});
```

- [ ] **Step 2: 跑测试确认失败**

```bash
pnpm test src/shared/preferences.test.ts
```

Expected: FAIL——`parsed.fontFamily` 为 `undefined`(字段尚不存在)。

- [ ] **Step 3: 实现 schema**

`src/shared/preferences.ts` 中,在 `readerPrefsSchema` 前加枚举、并在 schema 内加字段:

```ts
/** 正文字体档位:default=原书默认(零干预);其余映射到打包字体栈(见 renderer 的 font-stacks)。 */
export const readerFontFamily = z.enum(["default", "wenkai", "serif", "sans"]);
export type ReaderFontFamily = z.infer<typeof readerFontFamily>;

/** 阅读排版偏好(字号倍率 / 行距 / 栏宽 px / 字体档)。@renderer/types 的 ReaderPrefs 由此推导,单一源。 */
export const readerPrefsSchema = z.object({
  fontScale: z.number(),
  lineHeight: z.number(),
  maxWidth: z.number().int(),
  // .default 保旧落盘 JSON(无此字段)parse 通过,不连带重置字号/行距/栏宽
  fontFamily: readerFontFamily.default("default"),
});
```

`src/renderer/types.ts` 的 re-export 行补类型(现有 `export type { ReaderLayout, ReaderPrefs }`):

```ts
export type { ReaderFontFamily, ReaderLayout, ReaderPrefs } from "@shared/preferences";
```

`src/renderer/store/prefs-store.ts` 的 `PREFS_INITIAL`:

```ts
prefs: { fontScale: 1, lineHeight: 1.9, maxWidth: 640, fontFamily: "default" },
```

`src/renderer/reader/prefs-to-css.test.ts` 现有两个 `prefsToCss({...})` 调用对象各补 `fontFamily: "default"`(纯类型适配,行为不变)。

- [ ] **Step 4: 跑测试与 typecheck 确认通过**

```bash
pnpm test src/shared/preferences.test.ts src/renderer/reader/prefs-to-css.test.ts
pnpm typecheck
```

Expected: 全 PASS。(`setPreferenceInput` 的 `readerPrefs` arm 复用同一 schema 对象,自动获得新字段,无需改动——`preferences.test.ts` 的 drift 测试仍绿。)

- [ ] **Step 5: 提交**

```bash
git add src/shared/preferences.ts src/shared/preferences.test.ts src/renderer/types.ts src/renderer/store/prefs-store.ts src/renderer/reader/prefs-to-css.test.ts
git commit -m "feat(shared): add fontFamily to reader prefs schema"
```

---

### Task 4: font-stacks + prefsToCss 字体规则(TDD)

**Files:**

- Create: `src/renderer/reader/font-stacks.ts`
- Modify: `src/renderer/reader/prefs-to-css.ts`
- Test: `src/renderer/reader/prefs-to-css.test.ts`

- [ ] **Step 1: 写失败测试**

在 `src/renderer/reader/prefs-to-css.test.ts` 追加:

```ts
const base = { fontScale: 1, lineHeight: 1.9, maxWidth: 640 } as const;

it("default 档不输出 font-family 规则(零干预)", () => {
  const css = prefsToCss({ ...base, fontFamily: "default" });
  expect(css).not.toContain("font-family");
});

it("非 default 档输出 !important 字体覆盖与 code/pre 等宽例外", () => {
  const css = prefsToCss({ ...base, fontFamily: "wenkai" });
  expect(css).toContain('"LXGW WenKai"');
  expect(css).toMatch(/body, body \* \{ font-family: .+ !important/);
  expect(css).toContain("code");
  expect(css).toContain("monospace");
});

it("serif/sans 档映射到对应中文字体栈", () => {
  expect(prefsToCss({ ...base, fontFamily: "serif" })).toContain('"Noto Serif SC"');
  expect(prefsToCss({ ...base, fontFamily: "sans" })).toContain('"Noto Sans SC"');
});
```

- [ ] **Step 2: 跑测试确认失败**

```bash
pnpm test src/renderer/reader/prefs-to-css.test.ts
```

Expected: 新增 3 个用例 FAIL(`prefsToCss` 尚未处理 fontFamily)。

- [ ] **Step 3: 实现 font-stacks.ts**

创建 `src/renderer/reader/font-stacks.ts`:

```ts
import type { ReaderFontFamily } from "@renderer/types";

/**
 * 非 default 档的正文字体栈:西文专用字体在前、打包中文字体回退、系统兜底。
 * 文楷自带拉丁字形,不与西文字体混搭以保风格统一。
 */
export const FONT_STACKS: Record<Exclude<ReaderFontFamily, "default">, string> = {
  wenkai: `"LXGW WenKai", "Songti SC", serif`,
  serif: `"Fraunces Variable", "Noto Serif SC", Georgia, serif`,
  sans: `"Manrope Variable", "Noto Sans SC", system-ui, sans-serif`,
};

/** code/pre 等宽例外栈(字体覆盖时恢复,免代码块被正文字体破坏)。 */
export const MONO_STACK = `ui-monospace, SFMono-Regular, Menlo, Consolas, monospace`;
```

- [ ] **Step 4: 修改 prefs-to-css.ts**

整文件改为:

```ts
import type { ReaderPrefs } from "../types";
import { FONT_STACKS, MONO_STACK } from "./font-stacks";

/**
 * 把阅读偏好转成注入每个 section iframe 的 CSS 串(承载字号/行距/正文宽度/字体)。
 *
 * 注入位置在 ePub 自身样式之前(见 SectionFrame.buildSrcDoc),且 ePub 常在 `p`/`div`
 * 等元素上**直接**设 `line-height`/`margin`/`font-family`(直接命中元素优先于从 `body`
 * 继承),因此用户偏好必须用 `!important` 才能覆盖 ePub 自带样式;`line-height` 还需
 * **直接命中正文块**(仅设 `body` 够不到那些元素),标题不在其列以保紧凑。
 * `font-size` 设在 `html` 上以百分比缩放(ePub 极少改 `html` 字号),经 rem/em 级联即可,
 * 无需 `!important`。
 * 字体覆盖须 `body *` 全命中,并紧随其后给 code/pre 恢复等宽(更特异且靠后,稳赢);
 * `default` 档零干预(不输出 font-family 规则,保留原书字体)。
 */
export function prefsToCss(prefs: ReaderPrefs): string {
  const fontPct = Math.round(prefs.fontScale * 100);
  const rules = [
    `html { font-size: ${fontPct}%; }`,
    `body {`,
    `  max-width: ${prefs.maxWidth}px !important;`,
    `  margin: 0 auto !important;`,
    `  padding: 1rem !important;`,
    `}`,
    `body p, body div, body li, body blockquote, body dd, body dt, body td, body th {`,
    `  line-height: ${prefs.lineHeight} !important;`,
    `}`,
    `img { max-width: 100%; height: auto; }`,
  ];
  if (prefs.fontFamily !== "default") {
    rules.push(
      `body, body * { font-family: ${FONT_STACKS[prefs.fontFamily]} !important; }`,
      `body :is(code, pre, samp, kbd), body :is(code, pre) * { font-family: ${MONO_STACK} !important; }`,
    );
  }
  return rules.join("\n");
}
```

- [ ] **Step 5: 跑测试确认通过**

```bash
pnpm test src/renderer/reader/prefs-to-css.test.ts
pnpm typecheck
```

Expected: 全 PASS。

- [ ] **Step 6: 提交**

```bash
git add src/renderer/reader/font-stacks.ts src/renderer/reader/prefs-to-css.ts src/renderer/reader/prefs-to-css.test.ts
git commit -m "feat(renderer): map fontFamily pref to body font stack css"
```

---

### Task 5: reader-fonts(`?inline` @font-face)+ EpubReader 接线

**Files:**

- Create: `src/renderer/reader/reader-fonts.ts`
- Modify: `src/env.d.ts`(补 `*.css?inline` 声明)
- Modify: `src/renderer/reader/EpubReader.tsx`(styleCss 拼接)

- [ ] **Step 1: 补 `?inline` 模块声明**

`src/env.d.ts` 追加(vite/client 的 `*.css` 通配不匹配带 query 的 specifier):

```ts
declare module "*.css?inline" {
  const css: string;
  export default css;
}
```

- [ ] **Step 2: 创建 reader-fonts.ts**

> import 路径以 Task 1 Step 2 的 `ls` 输出为准;下面按标准 fontsource 布局书写。

```ts
// @fontsource 切片 @font-face CSS(?inline 取字符串),注入 section iframe 用。
// iframe 是独立 document,主文档的 @font-face 对其不可见,必须随 styleCss 注入;
// 仅拼当前选中档(中文切片 CSS 文本约百 KB/包,每个 iframe srcdoc 内联一份,勿全量塞)。
// 切片按 unicode-range 声明,浏览器只下载文本实际命中的 woff2,声明数百条几乎零成本。
import frauncesItalic from "@fontsource-variable/fraunces/wght-italic.css?inline";
import frauncesWght from "@fontsource-variable/fraunces/wght.css?inline";
import manropeWght from "@fontsource-variable/manrope/wght.css?inline";
import wenkai400 from "@fontsource/lxgw-wenkai/400.css?inline";
import wenkai700 from "@fontsource/lxgw-wenkai/700.css?inline";
import notoSansSc400 from "@fontsource/noto-sans-sc/400.css?inline";
import notoSansSc700 from "@fontsource/noto-sans-sc/700.css?inline";
import notoSerifSc400 from "@fontsource/noto-serif-sc/400.css?inline";
import notoSerifSc700 from "@fontsource/noto-serif-sc/700.css?inline";
import type { ReaderFontFamily } from "@renderer/types";

const FONT_FACE_CSS: Record<Exclude<ReaderFontFamily, "default">, string> = {
  wenkai: [wenkai400, wenkai700].join("\n"),
  // 正文 <em> 常见,衬线档带上 Fraunces 的 italic 轴(中文无斜体,浏览器合成)
  serif: [frauncesWght, frauncesItalic, notoSerifSc400, notoSerifSc700].join("\n"),
  sans: [manropeWght, notoSansSc400, notoSansSc700].join("\n"),
};

/** 当前档需注入 iframe 的 @font-face CSS;default 档返回空串(零干预)。 */
export function fontFaceCss(fontFamily: ReaderFontFamily): string {
  return fontFamily === "default" ? "" : FONT_FACE_CSS[fontFamily];
}
```

- [ ] **Step 3: EpubReader 拼接**

`src/renderer/reader/EpubReader.tsx`:import 区加

```ts
import { fontFaceCss } from "./reader-fonts";
```

`styleCss` 改为(@font-face 放最前,先声明后使用):

```tsx
styleCss={
  fontFaceCss(prefs.fontFamily) +
  "\n" +
  prefsToCss(prefs) +
  "\n" +
  ANNO_IFRAME_CSS +
  "\n" +
  readerThemeCss(resolvedTheme === "dark")
}
```

- [ ] **Step 4: typecheck + 全量测试**

```bash
pnpm typecheck
pnpm test
pnpm lint
```

Expected: 全绿(reader-fonts.ts 不进任何 vitest 测试文件,`?inline` 不会被 vitest 解析)。

- [ ] **Step 5: 提交**

```bash
git add src/env.d.ts src/renderer/reader/reader-fonts.ts src/renderer/reader/EpubReader.tsx
git commit -m "feat(renderer): inject per-preset @font-face css into section iframes"
```

---

### Task 6: ReaderPrefs UI + i18n

**Files:**

- Modify: `src/renderer/reader/ReaderPrefs.tsx`
- Modify: `src/shared/i18n/locales/zh-CN.ts`(经 `pnpm i18n:extract`)
- Modify: `src/shared/i18n/locales/en.ts`(手动补英文)

- [ ] **Step 1: 改 ReaderPrefs.tsx**

import 区追加(side-effect import 让**主文档**也有 @font-face,预览按钮才能渲染出真字体;400 足够):

```ts
import "@fontsource/lxgw-wenkai/400.css";
import "@fontsource/noto-sans-sc/400.css";
import "@fontsource/noto-serif-sc/400.css";
import type { ReaderFontFamily } from "@renderer/types";
import { FONT_STACKS } from "./font-stacks";
```

组件文件内(`Row` 组件之后)加选项表与字体行组件:

```tsx
const FONT_OPTIONS: ReadonlyArray<{
  value: ReaderFontFamily;
  labelKey: string;
  labelDefault: string;
  stack?: string;
}> = [
  { value: "default", labelKey: "reader.prefs.fontDefault", labelDefault: "原书默认" },
  {
    value: "wenkai",
    labelKey: "reader.prefs.fontWenkai",
    labelDefault: "文楷",
    stack: FONT_STACKS.wenkai,
  },
  {
    value: "serif",
    labelKey: "reader.prefs.fontSerif",
    labelDefault: "宋体",
    stack: FONT_STACKS.serif,
  },
  {
    value: "sans",
    labelKey: "reader.prefs.fontSans",
    labelDefault: "黑体",
    stack: FONT_STACKS.sans,
  },
];

function FontRow() {
  const { t } = useTranslation();
  const fontFamily = usePrefsStore((s) => s.prefs.fontFamily);
  const updatePrefs = usePrefsStore((s) => s.updatePrefs);
  return (
    <div className="space-y-1.5">
      <span className="text-xs text-muted-foreground">{t("reader.prefs.fontFamily", "字体")}</span>
      <div className="grid grid-cols-2 gap-1.5">
        {FONT_OPTIONS.map((o) => (
          <Button
            key={o.value}
            variant={fontFamily === o.value ? "secondary" : "outline"}
            size="sm"
            aria-pressed={fontFamily === o.value}
            // 预览即所得:按钮用自家字体栈渲染(运行时数据驱动,内联 style 属规范允许的例外)
            style={o.stack ? { fontFamily: o.stack } : undefined}
            onClick={() => updatePrefs({ fontFamily: o.value })}
          >
            {t(o.labelKey, o.labelDefault)}
          </Button>
        ))}
      </div>
    </div>
  );
}
```

`PopoverContent` 内、三个 `<Row …/>` 之后加:

```tsx
<FontRow />
```

- [ ] **Step 2: i18n extract + 手补 en**

```bash
pnpm i18n:extract
git diff src/shared/i18n/locales/
```

Expected: zh-CN.ts 多出 `reader.prefs.fontFamily/fontDefault/fontWenkai/fontSerif/fontSans` 五键;**确认 en.ts 既有键未被清空**。然后在 `src/shared/i18n/locales/en.ts` 按字母序手动补:

```ts
"reader.prefs.fontDefault": "Book default",
"reader.prefs.fontFamily": "Font",
"reader.prefs.fontSans": "Sans",
"reader.prefs.fontSerif": "Serif",
"reader.prefs.fontWenkai": "Kai",
```

- [ ] **Step 3: 校验**

```bash
pnpm typecheck
pnpm lint
pnpm test
grep -c "reader.prefs.font" src/shared/i18n/locales/en.ts src/shared/i18n/locales/zh-CN.ts
```

Expected: typecheck/lint/test 全绿;grep 两个文件各 ≥5(i18n:lint 有漏报,按记忆用 grep 复核)。

- [ ] **Step 4: 提交**

```bash
git add src/renderer/reader/ReaderPrefs.tsx src/shared/i18n/locales/
git commit -m "feat(renderer): font family picker in reader prefs popover"
```

---

### Task 7: dev 全链路冒烟(CDP)

**Files:** 无新文件(发现 bug 则修复并单独提交)

- [ ] **Step 1: 启动 dev + 开书**

```bash
pnpm start -- --remote-debugging-port=9222
```

后台运行;按 Task 2 Step 4 方式 CDP 点开一本书。

- [ ] **Step 2: 经 UI 切换字体档并断言 iframe 生效**

```bash
# 打开阅读偏好浮窗(aria-label 取自 i18n,zh 环境为「阅读偏好」)
node /tmp/cdp-eval.mjs 9222 'document.querySelector("[aria-label=阅读偏好], [aria-label=\"阅读偏好\"]")?.click() ?? "no trigger"'
# 点「文楷」
node /tmp/cdp-eval.mjs 9222 '[...document.querySelectorAll("button")].find(b => b.textContent === "文楷")?.click() ?? "no btn"'
# 断言 iframe 内 computed font-family 与字体加载
node /tmp/cdp-eval.mjs 9222 '(async () => {
  const d = document.querySelector("iframe").contentDocument;
  await d.fonts.ready;
  const p = d.querySelector("p") ?? d.body;
  return { computed: d.defaultView.getComputedStyle(p).fontFamily, loaded: d.fonts.check("16px \"LXGW WenKai\"") };
})()'
```

Expected: `computed` 以 `"LXGW WenKai"` 开头,`loaded: true`。
同法依次点「宋体」「黑体」断言 `Noto Serif SC` / `Noto Sans SC`,再点「原书默认」断言 computed **不含**上述字体(回到 ePub 自带)。

- [ ] **Step 3: 重启验证持久化**

停掉 app(精确停,勿宽 pkill),重新 `pnpm start -- --remote-debugging-port=9222`,开同一本书:

```bash
node /tmp/cdp-eval.mjs 9222 '(async () => {
  const d = document.querySelector("iframe").contentDocument;
  await d.fonts.ready;
  return d.defaultView.getComputedStyle(d.querySelector("p") ?? d.body).fontFamily;
})()'
```

Expected: 重启前最后所选档位仍生效(读 DB hydrate 成功)。验证完把档位切回「原书默认」或任意喜好值,停掉 dev。

- [ ] **Step 4: 如有修复,提交修复**

```bash
git add -A && git commit -m "fix(renderer): <发现的具体问题>"
```

(无问题则跳过。)

---

### Task 8: 打包冒烟(prod:file:// + asar 下字体加载)

**Files:** 无源码改动预期(发现打包缺口则修 `forge.config.ts` 并提交)

- [ ] **Step 1: 打包并确认字体进产物**

```bash
pnpm package
npx @electron/asar list out/*/Resources/app.asar 2>/dev/null | grep -c "woff2"
```

Expected: woff2 计数 > 0(字体切片经 vite 管线落在 `.vite/renderer/` 资产内)。若为 0,检查 `.vite/renderer/main_window/assets/` 是否有 woff2、`forge.config.ts` 的 ignore 白名单是否误伤,修复后重打包。

- [ ] **Step 2: 造最小中文 epub(自包含测试书)**

```bash
cd /tmp && rm -rf mini-epub font-smoke.epub && mkdir -p mini-epub/META-INF mini-epub/OEBPS && cd mini-epub
printf 'application/epub+zip' > mimetype
cat > META-INF/container.xml <<'EOF'
<?xml version="1.0"?>
<container version="1.0" xmlns="urn:oasis:names:tc:opendocument:xmlns:container">
  <rootfiles><rootfile full-path="OEBPS/content.opf" media-type="application/oebps-package+xml"/></rootfiles>
</container>
EOF
cat > OEBPS/content.opf <<'EOF'
<?xml version="1.0" encoding="utf-8"?>
<package xmlns="http://www.idpf.org/2007/opf" version="3.0" unique-identifier="uid">
  <metadata xmlns:dc="http://purl.org/dc/elements/1.1/">
    <dc:identifier id="uid">urn:uuid:font-smoke-0001</dc:identifier>
    <dc:title>字体冒烟测试</dc:title>
    <dc:language>zh</dc:language>
    <meta property="dcterms:modified">2026-06-04T00:00:00Z</meta>
  </metadata>
  <manifest>
    <item id="nav" href="nav.xhtml" media-type="application/xhtml+xml" properties="nav"/>
    <item id="c1" href="c1.xhtml" media-type="application/xhtml+xml"/>
  </manifest>
  <spine><itemref idref="c1"/></spine>
</package>
EOF
cat > OEBPS/nav.xhtml <<'EOF'
<?xml version="1.0" encoding="utf-8"?>
<html xmlns="http://www.w3.org/1999/xhtml" xmlns:epub="http://www.idpf.org/2007/ops">
<head><title>目录</title></head>
<body><nav epub:type="toc"><ol><li><a href="c1.xhtml">第一章</a></li></ol></nav></body>
</html>
EOF
cat > OEBPS/c1.xhtml <<'EOF'
<?xml version="1.0" encoding="utf-8"?>
<html xmlns="http://www.w3.org/1999/xhtml">
<head><title>第一章</title></head>
<body><h1>第一章 字体测试</h1>
<p>春江潮水连海平,海上明月共潮生。The quick brown fox jumps over the lazy dog. <em>斜体 Italic</em> <strong>加粗 Bold</strong></p>
<pre><code>const mono = true;</code></pre></body>
</html>
EOF
zip -X0 ../font-smoke.epub mimetype && zip -Xr9 ../font-smoke.epub META-INF OEBPS
```

- [ ] **Step 3: 启动产物(隔离 userData + CDP)并导入测试书**

```bash
out/*/marginalia.app/Contents/MacOS/marginalia --user-data-dir=/tmp/marginalia-font-smoke --remote-debugging-port=9223 &
sleep 5
grep -n "importBook" src/preload.ts   # 确认 window.api 导入方法名与签名
node /tmp/cdp-eval.mjs 9223 'window.api.importBook("/tmp/font-smoke.epub")'   # 按上行确认的真实签名调整
```

Expected: 导入成功,书库出现「字体冒烟测试」。

- [ ] **Step 4: 开书 → 切文楷 → 断言**

按 Task 7 Step 2 同法(端口 9223):点书卡 → 开阅读偏好 → 点「文楷」→ 断言 iframe `computed` 含 `LXGW WenKai`、`loaded: true`。**这是 spec 风险点①的最终验收:prod(file:// + asar)下切片 woff2 能被 srcdoc iframe 加载。**
再快速检查 code 块等宽:`getComputedStyle(d.querySelector("code")).fontFamily` 含 `monospace` 系。

- [ ] **Step 5: DB 惯例检查 + 收尾**

```bash
sqlite3 /tmp/marginalia-font-smoke/marginalia.db ".tables"
```

Expected: 列出全表(books/chapters/messages/preferences 等)。停掉产物进程,清理 `/tmp/marginalia-font-smoke`。
若 Step 1–4 改了 `forge.config.ts`:`git add forge.config.ts && git commit -m "fix(build): <具体缺口>"`。

---

### Task 9: ROADMAP 更新

**Files:**

- Modify: `docs/superpowers/ROADMAP.md`

- [ ] **Step 1: 在已交付能力处补一行**

在 ROADMAP 已交付列表(阅读排版偏好/颜色模式所在区域)按现有格式补:正文字体切换(原书默认/文楷/宋体/黑体,打包三款中文字体)已交付,并附 spec 链接 `specs/2026-06-04-reader-font-family-design.md`。若设置 backlog 中有相关旧条目则顺手勾掉。

- [ ] **Step 2: 提交**

```bash
git add docs/superpowers/ROADMAP.md
git commit -m "docs(roadmap): mark reader font family switching delivered"
```

> 合并回 main 用 superpowers:finishing-a-development-branch(本地 rebase 线性工作流,不要 merge commit)。

---

## Self-Review 记录

- **Spec 覆盖:** 数据模型(Task 3)、字体栈/CSS 生成(Task 4)、资源加载与 iframe 注入(Task 1/2/5)、UI+i18n(Task 6)、测试(Task 3/4 TDD + Task 7/8 冒烟)、风险点①spike(Task 2)+prod 验收(Task 8)、风险点③打包白名单(Task 8 Step 1)——全覆盖。
- **占位符:** 唯二开放点都有明确解法路径:fontsource 实际文件名(Task 1 Step 2 输出为准)、`window.api` 导入签名(Task 8 Step 3 grep 确认)。
- **类型一致:** `readerFontFamily`/`ReaderFontFamily`/`FONT_STACKS`/`MONO_STACK`/`fontFaceCss` 名称在 Task 3/4/5/6 间一致;`prefs.fontFamily` 字段名贯穿 schema→store→css→UI。
