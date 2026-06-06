# PDF 支持 P2（选区问 AI + readPage 工具 + TOC 跳页）实现计划

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** PDF 阅读器接通「选区→问 AI」全链路、AI 获得按页读取工具（text/image，按 provider 能力门控）、TOC 跳页与当前章高亮，并补齐扫描版聊天防御与导入 title 回退。

**Architecture:** 渲染层在 P1 的 canvas 页上叠 pdfjs v6 `TextLayer`（透明 span 流），原生 DOM selection → 页内字符偏移 + 字符窗口上下文 → 复用既有 `SelectionInfo`/chips 链路（AI 契约零改动）。主进程 `createReadingTools` 按 `book.format` 附加 `readPage` 工具，image 模式经 AI SDK v6 `toModelOutput` 以 `file-data` content part 回传，门控 = provider type 白名单。spec：`docs/superpowers/specs/2026-06-06-pdf-support-design.md` §6/§7/§9。

**Tech Stack:** pdfjs-dist 6.0.227（TextLayer）、AI SDK v6（ai 6.0.193 `tool.toModelOutput`）、react-virtuoso（`VirtuosoHandle.scrollToIndex`）、happy-dom（新 devDep，仅 DOM 纯函数测试）。

**分支：** 全程在 `feat/pdf-support-p2`（已自 `feat/pdf-support` 切出）。完成后审核合回 `feat/pdf-support`（**不是 main**）。**任何 subagent 严禁 `git switch`/`git checkout` 切分支。**

---

## 关键 API 事实（已对本仓 node_modules 实物核实，勿凭旧知识改写）

1. **pdfjs v6 `TextLayer`**（`pdfjs-dist` 具名导出）：`new TextLayer({ textContentSource, container, viewport })` → `.render(): Promise` / `.cancel()` / `.textDivs`。取消时 render promise 以 `AbortException` reject。
2. **pdfjs v6 的 CSS 缩放变量是 `--total-scale-factor`**（v4 时代的 `--scale-factor` 已废弃）；textLayer 容器还需定义 `--scale-round-x/--scale-round-y`（官方 pdf_viewer.css 默认 `1px`）。
3. **AI SDK v6 `toModelOutput`** 签名：`({ toolCallId, input, output }) => ToolResultOutput`；图像 content part 形状为 `{ type: "content", value: [{ type: "file-data", mediaType: "image/png", data: <base64 字符串> }] }`（**不是** v5 文档里的 `type: "media"`）。
4. **provider 对图像 tool result 的支持**（grep 各 `@ai-sdk/*` dist 实证）：`@ai-sdk/openai`、`@ai-sdk/anthropic`、`@ai-sdk/google` 均处理 `file-data`；**`@ai-sdk/openai-compatible` 完全不处理**（openai-chat-completions 的 tool 消息只收纯文本）。
5. **`MockLanguageModelV3.doStream`** 收到的 `options.prompt` 是数组，system 提示在 `prompt` 中以 `{ role: "system", content: string }` 出现（send.ts 经 `system:` 参数传入后 SDK 归一化）。
6. **页内偏移坐标空间**（spec §4/§5.1 注记）：标注/选区偏移 = textLayer DOM 的 text node 按文档序拼接（即 getTextContent items 顺序，**不含** pdfjs 的 EOL 合成换行）。它与主进程 `extractPdfText` 的「章内偏移」（含 `[p.N]` 标记）是两个互不转换的空间。P3 高亮绘制将以同一 DOM 空间解释。
7. **设计决策（spec §7 的「实现计划阶段定」落锤）**：image 模式门控 **只看 provider type**（硬技术约束），不做「模型是否视觉」启发式白名单——白名单必然漏掉新视觉模型而静默剥夺能力，违背项目「未知一律保留」先例（provider-models.ts `NON_TEXT_MODEL` 注释）；非视觉模型误调 image 的失败会以真实错误流回（honest-error），模型可自行改用 text。

---

## 文件结构总览

| 文件                                         | 动作 | 职责                                                        |
| -------------------------------------------- | ---- | ----------------------------------------------------------- |
| `src/main/library/repository.ts`             | 改   | `ImportInput.fileName` + PDF title 回退文件名               |
| `src/main/ipc/library-handlers.ts`           | 改   | libraryImport 传 `basename(filePath)`                       |
| `src/main/ai/assistant-model.ts`             | 改   | `ResolvedModel` ok 分支带 `providerType`                    |
| `src/main/ai/model-factory.ts`               | 改   | `supportsImageToolResults()`                                |
| `src/main/library/content.ts`                | 改   | `readChapterText`/`readBookText` 扫描版 throw               |
| `src/shared/i18n/locales/en.ts`              | 改   | `errors.noTextLayer` 文案通用化                             |
| `src/main/ai/tools.ts`                       | 改   | `readPage` 工具 + 按 format 分发 + `imageToolResults` dep   |
| `src/main/ai/prompt.ts`                      | 改   | `pdfSystemNote()` 纯函数                                    |
| `src/main/ai/send.ts`                        | 改   | PDF system prompt 注入 + 门控判定传 tools                   |
| `src/main/providers/assistant.ts`            | 改   | `DEFAULT_SYSTEM_PROMPT` 格式中立化                          |
| `src/renderer/reader/pdf-locator.ts`         | 改   | `makePdfLocatorRange`/`parsePdfLocatorRange`                |
| `src/renderer/reader/pdf-book.ts`            | 改   | `renderPage` 增 textLayer 渲染（共享 page 生命周期）        |
| `src/index.css`                              | 改   | `.textLayer` 全局样式（pdfjs 注入 DOM，无法用 Tailwind 类） |
| `src/renderer/reader/pdf-selection.ts`       | 新   | `flatOffsetOf` + `buildPdfSelectionInfo` 纯函数             |
| `src/renderer/reader/pdf-chapter-at-page.ts` | 新   | `chapterIdAtPage` 纯函数                                    |
| `src/renderer/reader/PdfReader.tsx`          | 改   | textLayer 叠加、选区接线、TOC 跳页、当前章回写              |
| `src/renderer/reader/SelectionToolbar.tsx`   | 改   | PDF 下隐藏高亮/笔记组（P3 解锁）                            |
| `src/renderer/reader/ReaderView.tsx`         | 改   | 给 PdfReader 传 chapters                                    |

各任务的测试文件与被改文件同目录、同名 `.test.ts`。

---

### Task 1: PDF 导入 title 回退文件名

**背景**：PDF 元数据缺 `Title` 时当前 `books.title` 落 `null`，书库显示退化（用户要求：用文件名去扩展名作 title）。`library:import` 的 input 本来就有 `filePath`，文件名垂手可得。

**Files:**

- Modify: `src/main/library/repository.ts`
- Modify: `src/main/ipc/library-handlers.ts`
- Test: `src/main/library/repository.test.ts`

- [ ] **Step 1: 写失败测试**

在 `src/main/library/repository.test.ts` 的 `describe("importBook (pdf)")` 内追加（该 describe 现有用例的 db 构造方式照抄——文件顶部已有 `createDb(":memory:")` + `runMigrations` 的 setup 模式，沿用同一 helper）：

```ts
it("falls back to the file name (sans extension) when pdf metadata has no title", async () => {
  const db = freshDb(); // 与同 describe 现有用例一致的 db 构造（以文件内实际 helper 名为准）
  const bytes = await makeTextPdf({ outline: false }); // 不带 title 选项 → 元数据无 Title
  const book = await importBook(db, { bytes, fileName: "深入浅出统计学.pdf" });
  expect(book.title).toBe("深入浅出统计学");
  // 单章退化的章节 title 兜底也应用同一回退值
  const chs = db.select().from(chapters).where(eq(chapters.bookId, book.id)).all();
  expect(chs[0]!.title).toBe("深入浅出统计学");
});

it("metadata title wins over the file name", async () => {
  const db = freshDb();
  const bytes = await makeTextPdf({ outline: false, title: "Real Title" });
  const book = await importBook(db, { bytes, fileName: "whatever.pdf" });
  expect(book.title).toBe("Real Title");
});
```

（`chapters`/`eq` 等 import 若该文件尚未引入则补上；`makeTextPdf` 已在文件中导入。）

- [ ] **Step 2: 跑测试确认失败**

Run: `pnpm test src/main/library/repository.test.ts -t "falls back to the file name"`
Expected: FAIL（`ImportInput` 无 `fileName` 字段 → 类型错误或 title 为 null）

- [ ] **Step 3: 实现**

`src/main/library/repository.ts`：

```ts
export interface ImportInput {
  bytes: Uint8Array;
  /** 原始文件名（不含路径）。PDF 元数据缺 Title 时回退为书名（去扩展名）。 */
  fileName?: string;
}
```

`importBook` 分发处传递：

```ts
export async function importBook(db: DB, input: ImportInput): Promise<BookRow> {
  return detectFormat(input.bytes) === "pdf"
    ? importPdfBook(db, input.bytes, input.fileName)
    : importEpubBook(db, input.bytes);
}
```

`importPdfBook` 签名与 title 链（替换现 `title: parsed.title ?? null` 与章节 title 兜底）：

```ts
async function importPdfBook(db: DB, bytes: Uint8Array, fileName?: string): Promise<BookRow> {
  const parsed = await parsePdf(bytes);
  const id = createHash("sha256").update(bytes).digest("hex"); // PDF 无自然键，统一文件哈希

  // PDF 元数据缺 Title 时回退文件名（去扩展名）；trim 后为空串视同缺失。
  const fallbackTitle = fileName?.replace(/\.[^.]+$/, "").trim() || undefined;
  const title = parsed.title ?? fallbackTitle ?? null;
  ...
  // books insert: title,
  // chapters insert 的兜底链改为: title: parsed.toc[index]?.label ?? title,
```

`src/main/ipc/library-handlers.ts` 的 `libraryImport`：

```ts
import path from "node:path";
// ...
const book = await importBook(getDb(), { bytes, fileName: path.basename(input.filePath) });
```

- [ ] **Step 4: 跑测试确认通过**

Run: `pnpm test src/main/library/repository.test.ts`
Expected: 全 PASS（含既有用例——`Untitled Things` 等带 title 的用例不受影响）

- [ ] **Step 5: Commit**

```bash
git add src/main/library/repository.ts src/main/ipc/library-handlers.ts src/main/library/repository.test.ts
git commit -m "feat(library): fall back to file name for untitled pdf imports"
```

---

### Task 2: ResolvedModel 暴露 providerType + supportsImageToolResults

**背景**：image 模式门控需要知道当前聊天模型背后的 provider type（关键 API 事实 #4/#7）。`ResolvedModel` ok 分支现在只有 `{ model, modelId }`；`providerType` 设为**可选**字段——既有测试里大量 `{ ok: true, model, modelId }` mock 字面量不必全改，undefined 按「不支持图像」保守处理。

**Files:**

- Modify: `src/main/ai/assistant-model.ts`
- Modify: `src/main/ai/model-factory.ts`
- Test: `src/main/ai/model-factory.test.ts`、`src/main/ai/assistant-model.test.ts`

- [ ] **Step 1: 写失败测试**

`src/main/ai/model-factory.test.ts` 追加：

```ts
import { supportsImageToolResults } from "@main/ai/model-factory";

describe("supportsImageToolResults", () => {
  it("allows providers whose SDK converts file-data tool results", () => {
    expect(supportsImageToolResults("anthropic")).toBe(true);
    expect(supportsImageToolResults("google-generate-content")).toBe(true);
    expect(supportsImageToolResults("openai-responses")).toBe(true);
  });
  it("denies openai-chat-completions (text-only tool messages) and undefined", () => {
    expect(supportsImageToolResults("openai-chat-completions")).toBe(false);
    expect(supportsImageToolResults(undefined)).toBe(false);
  });
});
```

`src/main/ai/assistant-model.test.ts` 追加（沿用该文件现有「配置 provider + assistant 后 resolve」的 setup 模式）：

```ts
it("exposes providerType on successful resolution", () => {
  // 在现有「resolve 成功」用例同款 setup 后：
  const resolved = resolveAssistantModel(db);
  expect(resolved.ok && resolved.providerType).toBe("anthropic"); // 以该用例实际配置的 type 为准
});
```

- [ ] **Step 2: 跑测试确认失败**

Run: `pnpm test src/main/ai/model-factory.test.ts src/main/ai/assistant-model.test.ts`
Expected: FAIL（`supportsImageToolResults` 不存在；`providerType` 不在类型上）

- [ ] **Step 3: 实现**

`src/main/ai/model-factory.ts` 追加（`AiProviderApiType` 已在该文件 import 链上，自 `@shared/providers`）：

```ts
/**
 * provider 是否支持图像 tool result（file-data content part；spec §7 门控）。
 * openai-chat-completions 的 tool 消息只收纯文本（@ai-sdk/openai-compatible 不处理 file-data）；
 * 其余三家 SDK 均转换 file-data → 各自原生图像格式（对各包 dist 实证）。
 * undefined（测试 mock 未注入 providerType）按不支持处理——保守但 honest。
 * 刻意不做「模型是否视觉」启发式白名单：白名单必漏新视觉模型而静默剥夺能力（对齐
 * provider-models.ts「未知一律保留」原则）；误调 image 的失败以真实错误流回，模型自会改用 text。
 */
export function supportsImageToolResults(type?: AiProviderApiType): boolean {
  return type === "anthropic" || type === "google-generate-content" || type === "openai-responses";
}
```

`src/main/ai/assistant-model.ts`：

```ts
import type { AiProviderApiType } from "@shared/providers";

export type ResolvedModel =
  | { ok: true; model: ChatModel; modelId: string; providerType?: AiProviderApiType }
  | { ok: false; reason: string };
```

`resolveAssistantModel` 与 `resolveSummaryModel` 的成功 return 各加 `providerType: provider.type`。

- [ ] **Step 4: 跑测试确认通过**

Run: `pnpm test src/main/ai/model-factory.test.ts src/main/ai/assistant-model.test.ts`
Expected: PASS

- [ ] **Step 5: Commit**

```bash
git add src/main/ai/assistant-model.ts src/main/ai/model-factory.ts src/main/ai/model-factory.test.ts src/main/ai/assistant-model.test.ts
git commit -m "feat(ai): expose provider type on resolved model and image tool-result capability check"
```

---

### Task 3: 聊天链路扫描版防御 + errors.noTextLayer 通用化

**背景**：spec §8——业务不变量不靠 UI 守。当前 `readChapterText` 对扫描版 PDF 静默返回空文本（模型收到空文本只能瞎猜）。在 content 层 throw 明确错误；该错误经 tool error result 流回模型，配合 Task 5 的 system prompt 注入（「扫描版请用 readPage image」）形成闭环。现有 i18n 键 `errors.noTextLayer` 文案绑定「摘要」场景，通用化。

**Files:**

- Modify: `src/main/library/content.ts`
- Modify: `src/shared/i18n/locales/en.ts`
- Test: `src/main/library/content.test.ts`

- [ ] **Step 1: 写失败测试**

`src/main/library/content.test.ts` 追加（沿用文件现有 setup 模式；`makeScannedPdf` 自 `@marginalia/pdf-parser/fixture` 导入）：

```ts
describe("scanned pdf guard (no text layer)", () => {
  it("readChapterText rejects instead of silently returning empty text", async () => {
    const db = freshDb(); // 以文件内实际 helper 为准
    const bytes = await makeScannedPdf();
    const book = await importBook(db, { bytes });
    const ch = db.select().from(chapters).where(eq(chapters.bookId, book.id)).get()!;
    await expect(readChapterText(db, bytes, book.id, ch.id, {})).rejects.toThrow(
      /text layer|文本层/,
    );
  });

  it("readBookText rejects the same way", async () => {
    const db = freshDb();
    const bytes = await makeScannedPdf();
    const book = await importBook(db, { bytes });
    await expect(readBookText(db, bytes, book.id, { maxChars: 100 })).rejects.toThrow(
      /text layer|文本层/,
    );
  });
});
```

- [ ] **Step 2: 跑测试确认失败**

Run: `pnpm test src/main/library/content.test.ts -t "scanned pdf guard"`
Expected: FAIL（当前静默返回空切片，不 reject）

- [ ] **Step 3: 实现**

`src/main/library/content.ts`——`readChapterText` 与 `readBookText` 的 `book.format === "pdf"` 分支顶部各加：

```ts
if (book.format === "pdf") {
  // 扫描版防御（spec §8）：绝不静默返回空文本——模型/调用方必须收到真实原因。
  if (!book.hasTextLayer) {
    throw new Error(t("errors.noTextLayer", "扫描版 PDF 没有文本层，无法提取文本"));
  }
  return extractPdfText(...); // 原有调用不动
}
```

同文件 `assertTextLayer` 的默认值同步通用化（同一键）：

```ts
throw new Error(t("errors.noTextLayer", "扫描版 PDF 没有文本层，无法提取文本"));
```

`src/shared/i18n/locales/en.ts`：

```ts
"errors.noTextLayer": "This scanned PDF has no text layer, so its text cannot be extracted",
```

- [ ] **Step 4: 跑测试确认通过**

Run: `pnpm test src/main/library/content.test.ts`
Expected: 全 PASS（既有摘要防御用例若断言旧文案需同步更新断言）

- [ ] **Step 5: Commit**

```bash
git add src/main/library/content.ts src/shared/i18n/locales/en.ts src/main/library/content.test.ts
git commit -m "feat(content): reject text extraction for scanned pdfs in chat path"
```

---

### Task 4: readPage 工具 + 工具集按 format 分发

**背景**：spec §7。PDF 书的工具集附加 `readPage(page, mode)`；image 模式渲染 PNG 经 `toModelOutput` 以 content part 回传（关键 API 事实 #3）；mode 的 schema 按 `imageToolResults` 门控收窄（不支持的 provider 看不到 image 选项）。

**Files:**

- Modify: `src/main/ai/tools.ts`
- Test: `src/main/ai/tools.test.ts`

- [ ] **Step 1: 写失败测试**

`src/main/ai/tools.test.ts` 追加：

```ts
import { makeScannedPdf, makeTextPdf } from "@marginalia/pdf-parser/fixture";

async function setupPdf(o: { scanned?: boolean; imageToolResults?: boolean } = {}) {
  const db = createDb(":memory:");
  runMigrations(db, MIGRATIONS);
  const bytes = o.scanned
    ? await makeScannedPdf()
    : await makeTextPdf({ outline: true, title: "Px" });
  const book = await importBook(db, { bytes });
  const loadBytes: LoadBytes = async () => bytes;
  const tools = createReadingTools({
    db,
    bookId: book.id,
    loadBytes,
    imageToolResults: o.imageToolResults,
  });
  return { db, book, tools };
}

describe("readPage tool (pdf)", () => {
  it("is absent for epub books", async () => {
    const { tools } = await setup(); // 既有 epub setup
    expect("readPage" in tools).toBe(false);
  });

  it("is present for pdf books", async () => {
    const { tools } = await setupPdf();
    expect("readPage" in tools).toBe(true);
  });

  it("mode text returns the page text with its page marker", async () => {
    const { tools } = await setupPdf();
    if (!("readPage" in tools)) throw new Error("readPage missing");
    const out = (await tools.readPage.execute!({ page: 2, mode: "text" }, opts)) as {
      kind: string;
      page: number;
      text: string;
    };
    expect(out.kind).toBe("text");
    expect(out.text).toContain("[p.2]");
    expect(out.text).toContain("body text of page 2");
  });

  it("mode image returns base64 png and toModelOutput emits a file-data content part", async () => {
    const { tools } = await setupPdf({ imageToolResults: true });
    if (!("readPage" in tools)) throw new Error("readPage missing");
    const out = (await tools.readPage.execute!({ page: 1, mode: "image" }, opts)) as {
      kind: string;
      data: string;
    };
    expect(out.kind).toBe("image");
    const buf = Buffer.from(out.data, "base64");
    expect([...buf.subarray(0, 4)]).toEqual([0x89, 0x50, 0x4e, 0x47]); // PNG 魔数
    const modelOut = await tools.readPage.toModelOutput!({
      toolCallId: "t",
      input: { page: 1, mode: "image" },
      output: out,
    } as never);
    expect(modelOut).toEqual({
      type: "content",
      value: [{ type: "file-data", mediaType: "image/png", data: out.data }],
    });
  });

  it("gates mode image out of the schema when provider lacks image tool results", async () => {
    const { tools } = await setupPdf({ imageToolResults: false });
    if (!("readPage" in tools)) throw new Error("readPage missing");
    const schema = tools.readPage.inputSchema as z.ZodTypeAny;
    expect(schema.safeParse({ page: 1, mode: "image" }).success).toBe(false);
    expect(schema.safeParse({ page: 1, mode: "text" }).success).toBe(true);
  });

  it("mode text rejects for scanned pdfs with an actionable error", async () => {
    const { tools } = await setupPdf({ scanned: true, imageToolResults: true });
    if (!("readPage" in tools)) throw new Error("readPage missing");
    await expect(tools.readPage.execute!({ page: 1, mode: "text" }, opts)).rejects.toThrow(
      /scanned|text layer/,
    );
  });

  it("rejects out-of-range pages", async () => {
    const { tools } = await setupPdf();
    if (!("readPage" in tools)) throw new Error("readPage missing");
    await expect(tools.readPage.execute!({ page: 99, mode: "text" }, opts)).rejects.toThrow(
      /out of range/,
    );
  });
});
```

- [ ] **Step 2: 跑测试确认失败**

Run: `pnpm test src/main/ai/tools.test.ts -t "readPage"`
Expected: FAIL（`imageToolResults` 字段与 `readPage` 工具不存在）

- [ ] **Step 3: 实现**

`src/main/ai/tools.ts`：

```ts
import { extractPdfText, renderPageImage } from "@marginalia/pdf-parser";
import { getBook, resolveChapterByHref } from "@main/library/repository";

export interface ReadingToolsDeps {
  db: DB;
  bookId: string;
  loadBytes: LoadBytes;
  /** provider 是否支持图像 tool result（readPage image 模式门控；spec §7）。缺省按不支持。 */
  imageToolResults?: boolean;
}

/** 给模型看的页面图像渲染宽度（px）：兼顾排版可读与 token 成本。 */
const READ_PAGE_IMAGE_WIDTH = 1280;

export function createReadingTools(deps: ReadingToolsDeps) {
  const { db, bookId, loadBytes } = deps;
  const base = {
    getToc: tool({ ... }),            // 三个既有工具原样保留
    getChapterSummary: tool({ ... }),
    readChapterText: tool({ ... }),
  };

  const book = getBook(db, bookId);
  if (book?.format !== "pdf") return base;

  const pageCount = book.pageCount ?? 0;
  const hasTextLayer = Boolean(book.hasTextLayer);
  const imageOk = deps.imageToolResults ?? false;
  // 运行时按门控收窄 enum；类型断言为全集使 execute 的 mode 覆盖两种值。
  // spec §7：不支持图像 tool result 的 provider 不在 schema 中声明 image，避免模型调用后失败。
  const modes = (imageOk ? ["text", "image"] : ["text"]) as ["text", "image"];

  return {
    ...base,
    readPage: tool({
      description: imageOk
        ? 'Read one page of this PDF by 1-based page number. mode "text" returns the page text; mode "image" returns a rendered image of the page — use it for figures, tables, complex layouts, or scanned pages.'
        : 'Read one page of this PDF by 1-based page number, returning the page text.',
      inputSchema: z.object({
        page: z.number().int().min(1),
        mode: z.enum(modes).default("text"),
      }),
      execute: async ({ page, mode }) => {
        if (page > pageCount) {
          throw new Error(`page ${page} is out of range (this book has ${pageCount} pages)`);
        }
        const bytes = await loadBytes(bookId);
        if (mode === "image") {
          const png = await renderPageImage(bytes, page, { targetWidth: READ_PAGE_IMAGE_WIDTH });
          return { kind: "image" as const, page, data: Buffer.from(png).toString("base64") };
        }
        if (!hasTextLayer) {
          throw new Error(
            `this PDF is scanned and has no text layer; text extraction is unavailable${
              imageOk ? ' — use mode "image" instead' : ""
            }`,
          );
        }
        const slice = await extractPdfText(bytes, { startPage: page, endPage: page });
        return { kind: "text" as const, page, text: slice.text };
      },
      // 图像必须以 content part 回传模型（默认 JSON 序列化只会把 base64 变成一坨文本）；
      // text 维持 JSON 形状。
      toModelOutput: ({ output }) =>
        output.kind === "image"
          ? {
              type: "content" as const,
              value: [
                { type: "file-data" as const, mediaType: "image/png", data: output.data },
              ],
            }
          : { type: "json" as const, value: { page: output.page, text: output.text } },
    }),
  };
}
```

（返回类型为两分支 union；调用方 `streamText({ tools })` 与 `'readPage' in tools` 收窄均成立。）

- [ ] **Step 4: 跑测试确认通过**

Run: `pnpm test src/main/ai/tools.test.ts`
Expected: 全 PASS（既有 epub 用例不受影响）

- [ ] **Step 5: Commit**

```bash
git add src/main/ai/tools.ts src/main/ai/tools.test.ts
git commit -m "feat(ai): add readPage tool for pdf books with provider-gated image mode"
```

---

### Task 5: system prompt PDF 注入 + DEFAULT_SYSTEM_PROMPT 中立化

**背景**：spec §7——不注入的话模型未必意识到页粒度工具的存在价值。注入内容按书（页数/扫描版）与门控（image 模式有无）组合。顺带把默认系统提示词里的 "an ePub reader" 改成格式中立的 "an e-book reader"（注：已有用户 DB 中 assistants 行存的旧文案不迁移——PDF note 追加在后，模型可正确理解；用户也可在设置中自行改）。

**Files:**

- Modify: `src/main/ai/prompt.ts`
- Modify: `src/main/ai/send.ts`
- Modify: `src/main/providers/assistant.ts`
- Test: `src/main/ai/prompt.test.ts`、`src/main/ai/send.test.ts`

- [ ] **Step 1: 写失败测试**

`src/main/ai/prompt.test.ts` 追加：

```ts
import { pdfSystemNote } from "@main/ai/prompt";

describe("pdfSystemNote", () => {
  it("mentions page count and readPage for text-layer pdfs", () => {
    const s = pdfSystemNote({ pageCount: 270, hasTextLayer: true, imageMode: false });
    expect(s).toContain("PDF");
    expect(s).toContain("270 pages");
    expect(s).toContain("readPage");
    expect(s).toContain("[p.N]");
    expect(s).not.toContain('"image"');
  });
  it("advertises image mode when gated on", () => {
    const s = pdfSystemNote({ pageCount: 10, hasTextLayer: true, imageMode: true });
    expect(s).toContain('mode "image"');
  });
  it("tells the truth about scanned pdfs", () => {
    const s = pdfSystemNote({ pageCount: null, hasTextLayer: false, imageMode: true });
    expect(s).toContain("scanned");
    expect(s).not.toContain("[p.N]");
  });
});
```

`src/main/ai/send.test.ts` 追加（mock 模式沿用文件现有 `textStreamModel`/`finishChunk`）：

```ts
import { makeTextPdf } from "@marginalia/pdf-parser/fixture";

function systemCapturingModel(captured: { system?: string }) {
  return new MockLanguageModelV3({
    doStream: async ({ prompt }) => {
      const sys = prompt.find((m) => m.role === "system");
      captured.system = sys && typeof sys.content === "string" ? sys.content : undefined;
      return {
        stream: simulateReadableStream({
          chunks: [
            { type: "text-start", id: "t1" },
            { type: "text-delta", id: "t1", delta: "ok" },
            { type: "text-end", id: "t1" },
            finishChunk("stop"),
          ],
        }),
      };
    },
  });
}

describe("pdf system prompt injection", () => {
  it("appends a pdf note (with image hint for capable providers) for pdf books", async () => {
    const captured: { system?: string } = {};
    const db = createDb(":memory:");
    runMigrations(db, MIGRATIONS);
    const bytes = await makeTextPdf({ outline: true, title: "P" });
    const book = await importBook(db, { bytes });
    const deps: SendDeps = {
      db,
      loadBytes: async () => bytes,
      resolveModel: () => ({
        ok: true,
        model: systemCapturingModel(captured),
        modelId: "m",
        providerType: "anthropic",
      }),
      resolveSummaryModel: () => ({ ok: false, reason: "unset" }),
    };
    const convo = createConversation(db, { bookId: book.id });
    const r = runSend(deps, {
      bookId: book.id,
      conversationId: convo.id,
      userText: "hi",
      chips: [],
    });
    if (!r.ok) throw new Error(r.reason);
    await r.finished;
    expect(captured.system).toContain("is a PDF");
    expect(captured.system).toContain("3 pages");
    expect(captured.system).toContain('mode "image"');
  });

  it("does not mention PDF for epub books", async () => {
    const captured: { system?: string } = {};
    const { db, book, deps } = await setup({
      ok: true,
      model: systemCapturingModel(captured),
      modelId: "m",
    });
    const convo = createConversation(db, { bookId: book.id });
    const r = runSend(deps, {
      bookId: book.id,
      conversationId: convo.id,
      userText: "hi",
      chips: [],
    });
    if (!r.ok) throw new Error(r.reason);
    await r.finished;
    expect(captured.system).not.toContain("is a PDF");
  });
});
```

（`createConversation` 入参形状、`SendInput` 的 chips 字段名以文件内既有用例为准——若现有用例的 `runSend` 输入还包含其它必填字段，照抄其形状。）

- [ ] **Step 2: 跑测试确认失败**

Run: `pnpm test src/main/ai/prompt.test.ts src/main/ai/send.test.ts -t "pdf"`
Expected: FAIL（`pdfSystemNote` 不存在）

- [ ] **Step 3: 实现**

`src/main/ai/prompt.ts` 追加：

```ts
/** PDF 会话的 system prompt 附注（spec §7）：让模型知道页粒度工具的存在与扫描版的现实。 */
export function pdfSystemNote(p: {
  pageCount: number | null;
  hasTextLayer: boolean;
  imageMode: boolean;
}): string {
  const pages = p.pageCount != null ? ` with ${p.pageCount} pages` : "";
  const lines = [`The current book is a PDF${pages}.`];
  if (p.hasTextLayer) {
    lines.push(
      "Chapter text contains [p.N] page-boundary markers; use the readPage tool to read a specific page by number.",
    );
  } else {
    lines.push(
      "This PDF is scanned and has no text layer, so chapter text extraction is unavailable.",
    );
  }
  if (p.imageMode) {
    lines.push(
      'readPage mode "image" renders a page visually — use it for figures, tables, or scanned pages.',
    );
  }
  return lines.join(" ");
}
```

`src/main/ai/send.ts`——步骤 5（组装 prompt）改为：

```ts
import { getBook } from "@main/library/repository";
import { supportsImageToolResults } from "@main/ai/model-factory";
import { assemblePrompt, pdfSystemNote } from "@main/ai/prompt";

// ……行 83 起：
const assistant = getDefaultAssistant(db);
const book = getBook(db, input.bookId);
const imageToolResults = supportsImageToolResults(resolved.providerType);
// PDF 书附加页粒度工具提示（spec §7）；epub 完全不变。
let systemPromptText = assistant.systemPrompt;
if (book?.format === "pdf") {
  const note = pdfSystemNote({
    pageCount: book.pageCount,
    hasTextLayer: Boolean(book.hasTextLayer),
    imageMode: imageToolResults,
  });
  systemPromptText = systemPromptText ? `${systemPromptText}\n\n${note}` : note;
}
const allMessages: ModelMessage[] = assemblePrompt({
  systemPrompt: systemPromptText,
  history,
  current: { chips: deduped, userText: input.userText },
});
```

行 102 的工具创建改为：

```ts
const tools = createReadingTools({ db, bookId: input.bookId, loadBytes, imageToolResults });
```

`src/main/providers/assistant.ts`：

```ts
export const DEFAULT_SYSTEM_PROMPT =
  "You are a reading assistant embedded in an e-book reader. The user is reading a book and may select text to ask about it. Ground your answers in the provided selection, surrounding paragraphs, and chapter summary. When you need more of the original text, use the available reading tools. Answer concisely.";
```

- [ ] **Step 4: 跑测试确认通过**

Run: `pnpm test src/main/ai/prompt.test.ts src/main/ai/send.test.ts`
Expected: 全 PASS（若有既有用例断言旧 "ePub reader" 文案，同步更新）

- [ ] **Step 5: Commit**

```bash
git add src/main/ai/prompt.ts src/main/ai/send.ts src/main/providers/assistant.ts src/main/ai/prompt.test.ts src/main/ai/send.test.ts
git commit -m "feat(ai): inject pdf system note and pass image capability to reading tools"
```

---

### Task 6: pdf-locator range 变体

**背景**：spec §4——标注 locatorRange 形状 `pdf:{"page":12,"start":480,"end":527}`。P2 选区即产出 locatorRange（P3 标注直接消费），make/parse 成对落地。

**Files:**

- Modify: `src/renderer/reader/pdf-locator.ts`
- Test: `src/renderer/reader/pdf-locator.test.ts`

- [ ] **Step 1: 写失败测试**

`src/renderer/reader/pdf-locator.test.ts` 追加：

```ts
import { makePdfLocatorRange, parsePdfLocatorRange } from "./pdf-locator";

describe("pdf range locator", () => {
  it("round-trips", () => {
    const s = makePdfLocatorRange({ page: 12, start: 480, end: 527 });
    expect(s).toBe('pdf:{"page":12,"start":480,"end":527}');
    expect(parsePdfLocatorRange(s)).toEqual({ page: 12, start: 480, end: 527 });
  });
  it("rejects non-pdf prefixes and malformed json", () => {
    expect(parsePdfLocatorRange("epubcfi(/6/4!/4)")).toBeNull();
    expect(parsePdfLocatorRange("pdf:{nope")).toBeNull();
  });
  it("rejects invalid shapes", () => {
    expect(parsePdfLocatorRange('pdf:{"page":0,"start":0,"end":1}')).toBeNull();
    expect(parsePdfLocatorRange('pdf:{"page":1,"start":-1,"end":1}')).toBeNull();
    expect(parsePdfLocatorRange('pdf:{"page":1,"start":5,"end":4}')).toBeNull();
    expect(parsePdfLocatorRange('pdf:{"page":1,"scrollRatio":0.5}')).toBeNull(); // 进度形状不是 range
  });
});
```

- [ ] **Step 2: 跑测试确认失败**

Run: `pnpm test src/renderer/reader/pdf-locator.test.ts -t "range"`
Expected: FAIL（函数不存在）

- [ ] **Step 3: 实现**

`src/renderer/reader/pdf-locator.ts` 追加：

```ts
/**
 * PDF 标注 locatorRange（spec §4）：页内文本流字符偏移（[start, end) 闭开区间）。
 * 坐标空间 = textLayer DOM 文本流（getTextContent items 顺序，不含 EOL 合成换行），
 * 与渲染层选区/（P3）高亮绘制同一空间；与主进程「章内偏移」互不转换。
 */
export interface PdfRangeLocator {
  page: number; // 1-based
  start: number;
  end: number;
}

export function makePdfLocatorRange(r: PdfRangeLocator): string {
  return `pdf:${JSON.stringify({ page: r.page, start: r.start, end: r.end })}`;
}

export function parsePdfLocatorRange(s: string): PdfRangeLocator | null {
  if (!s.startsWith("pdf:")) return null;
  try {
    const v: unknown = JSON.parse(s.slice(4));
    if (typeof v !== "object" || v === null) return null;
    const { page, start, end } = v as { page?: unknown; start?: unknown; end?: unknown };
    if (typeof page !== "number" || !Number.isInteger(page) || page < 1) return null;
    if (typeof start !== "number" || !Number.isInteger(start) || start < 0) return null;
    if (typeof end !== "number" || !Number.isInteger(end) || end < start) return null;
    return { page, start, end };
  } catch {
    return null;
  }
}
```

- [ ] **Step 4: 跑测试确认通过**

Run: `pnpm test src/renderer/reader/pdf-locator.test.ts`
Expected: 全 PASS

- [ ] **Step 5: Commit**

```bash
git add src/renderer/reader/pdf-locator.ts src/renderer/reader/pdf-locator.test.ts
git commit -m "feat(reader): add pdf range locator for annotation offsets"
```

---

### Task 7: textLayer 渲染（pdf-book + 全局样式 + PdfPage 叠加）

**背景**：spec §6——每页 canvas 上叠 pdfjs `TextLayer`（透明 span 承载原生选区）。**textLayer 与 canvas 必须共享同一次 `getPage` 并统一在两路都 settle 后 `page.cleanup()`**：两条独立生命周期会在 cleanup 与另一路进行中渲染之间竞态（pdfjs 对「渲染中 cleanup」抛错）。textLayer 坐标系是 CSS 像素（canvas 才乘 dpr）。本任务纯渲染层 DOM 行为，无 headless 测试——以 typecheck + lint + Task 11 冒烟验收。

**Files:**

- Modify: `src/renderer/reader/pdf-book.ts`
- Modify: `src/index.css`
- Modify: `src/renderer/reader/PdfReader.tsx`（仅 PdfPage 组件）

- [ ] **Step 1: pdf-book.ts 扩展 renderPage**

import 行改为：

```ts
import * as pdfjsLib from "pdfjs-dist";
import { TextLayer } from "pdfjs-dist";
import type { PDFDocumentProxy, RenderTask } from "pdfjs-dist";
```

`PdfBook.renderPage` 签名与 doc 注释更新：

```ts
  /**
   * 渲染第 index（0-based）页到 canvas，并（若给了 textLayerDiv）叠加 pdfjs TextLayer
   * （透明 span 流，承载原生选区）。cssWidth 为目标 CSS 宽度，canvas 内部按
   * devicePixelRatio 放大物理像素；textLayer 坐标系为 CSS 像素。
   * 约束：对同一 canvas 发起新渲染前必须先调用上一次的 cancel()。done 在成功或取消时
   * resolve，意外渲染错误时 reject（调用方需 catch）。
   */
  renderPage: (
    index: number,
    canvas: HTMLCanvasElement,
    cssWidth: number,
    textLayerDiv?: HTMLDivElement,
  ) => { done: Promise<void>; cancel: () => void };
```

实现（替换现 renderPage 函数体）：

```ts
    renderPage: (index, canvas, cssWidth, textLayerDiv) => {
      let task: RenderTask | null = null;
      let textLayer: TextLayer | null = null;
      let cancelled = false;
      const done = (async () => {
        const page = await doc.getPage(index + 1);
        try {
          if (cancelled) return;
          const dpr = window.devicePixelRatio || 1;
          const pageBase = page.getViewport({ scale: 1 });
          const cssScale = cssWidth / pageBase.width;
          const viewport = page.getViewport({ scale: cssScale * dpr });
          canvas.width = Math.floor(viewport.width);
          canvas.height = Math.floor(viewport.height);
          const ctx = canvas.getContext("2d");
          if (!ctx) return;
          task = page.render({ canvasContext: ctx, canvas, viewport });
          // textLayer 与 canvas 共享同一次 getPage、两路都 settle 后才 cleanup——
          // 独立生命周期会在 page.cleanup() 与进行中的另一路渲染间竞态（pdfjs 抛错）。
          const textPromise = textLayerDiv
            ? (async () => {
                textLayerDiv.replaceChildren();
                // v6 的 CSS 缩放变量是 --total-scale-factor（span 字号经 calc() 换算）；
                // textLayer 用 CSS 像素 viewport（不乘 dpr）。
                textLayerDiv.style.setProperty("--total-scale-factor", String(cssScale));
                textLayer = new TextLayer({
                  textContentSource: page.streamTextContent(),
                  container: textLayerDiv,
                  viewport: page.getViewport({ scale: cssScale }),
                });
                await textLayer.render();
              })()
            : Promise.resolve();
          const [canvasR, textR] = await Promise.allSettled([
            task.promise.catch((err) => {
              // RenderingCancelledException = 主动取消，静默；其他错误透传
              if ((err as Error).name !== "RenderingCancelledException") throw err;
            }),
            textPromise.catch((err) => {
              // 取消时 TextLayer.render 以 AbortException reject——主动取消静默
              if (!cancelled) throw err;
            }),
          ]);
          if (canvasR.status === "rejected") throw canvasR.reason;
          if (textR.status === "rejected") throw textR.reason;
        } finally {
          page.cleanup();
        }
      })();
      return {
        done,
        cancel: () => {
          cancelled = true;
          task?.cancel();
          textLayer?.cancel();
        },
      };
    },
```

- [ ] **Step 2: src/index.css 加 textLayer 样式**

在 `@layer base` 块**之前**追加（pdfjs 注入的第三方 DOM，无法用 Tailwind 类，全局 CSS 是规范允许的承载方式；精简自 pdfjs v6 官方 pdf_viewer.css 的 textLayer 段）：

```css
/* pdfjs textLayer（v6）：透明 span 绝对定位叠在页面 canvas 上，仅承载原生文本选区。
   --total-scale-factor 由 pdf-book renderPage 按页设置；--scale-round-* 是 pdfjs
   round() 表达式要求的量化步长（官方默认 1px）。 */
.textLayer {
  position: absolute;
  inset: 0;
  overflow: clip;
  text-align: initial;
  line-height: 1;
  text-size-adjust: none;
  forced-color-adjust: none;
  transform-origin: 0 0;
  caret-color: CanvasText;
  --scale-round-x: 1px;
  --scale-round-y: 1px;
}
.textLayer :is(span, br) {
  color: transparent;
  position: absolute;
  white-space: pre;
  cursor: text;
  transform-origin: 0% 0%;
}
.textLayer span.markedContent {
  top: 0;
  height: 0;
}
.textLayer ::selection {
  background: rgb(59 130 246 / 0.35);
}
```

- [ ] **Step 3: PdfPage 叠加 textLayer div**

`src/renderer/reader/PdfReader.tsx` 的 `PdfPage` 组件改为（`cn` 自 `@renderer/lib/utils` 导入）：

```tsx
/** 单页：canvas + textLayer 叠层；卸载/参数变化取消未完成渲染（pdf-book 契约要求）。 */
function PdfPage(props: {
  book: PdfBook;
  index: number;
  cssWidth: number;
  cssHeight: number;
  invert: boolean;
}) {
  const { book, index, cssWidth, cssHeight, invert } = props;
  const canvasRef = useRef<HTMLCanvasElement | null>(null);
  const textLayerRef = useRef<HTMLDivElement | null>(null);
  const [renderError, setRenderError] = useState(false);

  useEffect(() => {
    const canvas = canvasRef.current;
    if (!canvas) return;
    setRenderError(false);
    const task = book.renderPage(index, canvas, cssWidth, textLayerRef.current ?? undefined);
    task.done.catch(() => setRenderError(true)); // done 可能 reject（pdf-book 契约）
    return () => task.cancel();
  }, [book, index, cssWidth]);

  return (
    <div className="flex justify-center py-2">
      {renderError ? (
        <div
          className="flex items-center justify-center bg-muted font-sans text-xs text-muted-foreground"
          // 运行时计算的页面尺寸（规范允许内联承载运行时值）
          style={{ width: cssWidth, height: cssHeight }}
        >
          ⚠ p.{index + 1}
        </div>
      ) : (
        <div className="relative shadow-sm" style={{ width: cssWidth, height: cssHeight }}>
          <canvas
            ref={canvasRef}
            className={cn("h-full w-full", invert && "[filter:invert(1)_hue-rotate(180deg)]")}
          />
          {/* data-page：选区处理据此识别页号（1-based）。invert 滤镜只作用于 canvas，
              textLayer 的 ::selection 高亮在暗色下保持可见。 */}
          <div ref={textLayerRef} data-page={index + 1} className="textLayer" />
        </div>
      )}
    </div>
  );
}
```

- [ ] **Step 4: 验证**

Run: `pnpm typecheck && pnpm lint && pnpm test`
Expected: 全绿（本任务无新测试；确认无回归）

- [ ] **Step 5: Commit**

```bash
git add src/renderer/reader/pdf-book.ts src/index.css src/renderer/reader/PdfReader.tsx
git commit -m "feat(reader): overlay pdfjs text layer on pdf pages"
```

---

### Task 8: pdf-selection 纯函数（含 happy-dom 测试）

**背景**：选区 → 页内偏移 + SelectionInfo 的可测内核。DOM 遍历用 TreeWalker（happy-dom 支持），`Range`/rect 等不可 headless 的部分留在 PdfReader 薄层（Task 9）。**先装 devDep：** `pnpm add -D -w happy-dom`（装包后 postinstall 自动把 better-sqlite3 翻回 Electron ABI，无需手动）。

**Files:**

- Create: `src/renderer/reader/pdf-selection.ts`
- Test: `src/renderer/reader/pdf-selection.test.ts`
- Modify: `package.json`（devDep happy-dom，经 pnpm add）

- [ ] **Step 1: 装依赖**

Run: `pnpm add -D -w happy-dom`
Expected: 安装成功，`pnpm test` 仍全绿（postinstall 已翻 ABI）

- [ ] **Step 2: 写失败测试**

`src/renderer/reader/pdf-selection.test.ts`：

```ts
// @vitest-environment happy-dom
import { describe, expect, it } from "vitest";
import { buildPdfSelectionInfo, flatOffsetOf } from "./pdf-selection";

function layer(spans: string[]): HTMLElement {
  const div = document.createElement("div");
  for (const s of spans) {
    const span = document.createElement("span");
    span.textContent = s;
    div.appendChild(span);
  }
  return div;
}

describe("flatOffsetOf", () => {
  it("accumulates text node lengths in document order", () => {
    const root = layer(["Hello ", "world", "!"]);
    const second = root.children[1]!.firstChild!;
    expect(flatOffsetOf(root, second, 0)).toBe(6);
    expect(flatOffsetOf(root, second, 3)).toBe(9);
  });
  it("returns null for a node outside the root", () => {
    const root = layer(["abc"]);
    const other = layer(["zzz"]);
    expect(flatOffsetOf(root, other.children[0]!.firstChild!, 0)).toBeNull();
  });
  it("returns null for an element (non-text) container", () => {
    const root = layer(["abc"]);
    expect(flatOffsetOf(root, root.children[0]!, 0)).toBeNull();
  });
});

describe("buildPdfSelectionInfo", () => {
  const rect = { x: 1, y: 2, width: 3, height: 4 };

  it("produces a locatorRange and a context window", () => {
    const pageStr = "A".repeat(400) + "TARGET" + "B".repeat(400);
    const info = buildPdfSelectionInfo({
      page: 7,
      pageStr,
      start: 400,
      end: 406,
      selectionText: "TARGET",
      rect,
    });
    expect(info.locatorRange).toBe('pdf:{"page":7,"start":400,"end":406}');
    expect(info.selectionText).toBe("TARGET");
    // 窗口 = 选区前后各 300 字符
    expect(info.paragraphCurrent).toHaveLength(300 + 6 + 300);
    expect(info.paragraphCurrent).toContain("TARGET");
    expect(info.paragraphBefore).toBeNull();
    expect(info.paragraphAfter).toBeNull();
    expect(info.rect).toEqual(rect);
  });

  it("clamps the window at page boundaries", () => {
    const info = buildPdfSelectionInfo({
      page: 1,
      pageStr: "short page text",
      start: 0,
      end: 5,
      selectionText: "short",
      rect,
    });
    expect(info.paragraphCurrent).toBe("short page text");
  });

  it("yields null locatorRange when offsets are unknown (cross-page / element container)", () => {
    const info = buildPdfSelectionInfo({
      page: 3,
      pageStr: "page text here",
      start: null,
      end: null,
      selectionText: "text",
      rect,
    });
    expect(info.locatorRange).toBeNull();
    expect(info.paragraphCurrent.length).toBeGreaterThan(0); // 上下文仍尽力提供
  });
});
```

- [ ] **Step 3: 跑测试确认失败**

Run: `pnpm test src/renderer/reader/pdf-selection.test.ts`
Expected: FAIL（模块不存在）

- [ ] **Step 4: 实现**

`src/renderer/reader/pdf-selection.ts`：

```ts
import type { SelectionInfo } from "@renderer/types";
import { makePdfLocatorRange } from "./pdf-locator";

/** 上下文窗口半径（字符）：选区前后各取这么多页内文本充当「周围上下文」（spec §6——PDF 无段落 DOM）。 */
const CONTEXT_WINDOW = 300;

/**
 * 求 (node, offsetInNode) 在 root 内扁平文本流中的偏移。
 * 坐标空间 = root 内 text node 按文档序拼接（textLayer 的 span 流即 getTextContent items
 * 顺序，不含 pdfjs 的 EOL 合成换行）——与 pdf-locator range、（P3）高亮绘制同一空间。
 * node 不在 root 内或不是 text node（如 triple-click 的元素容器）→ null；
 * 调用方把 locatorRange 置 null：问 AI 不受影响，只是该选区不可锚定标注。
 */
export function flatOffsetOf(root: Node, node: Node, offsetInNode: number): number | null {
  if (node.nodeType !== Node.TEXT_NODE) return null;
  let acc = 0;
  const walker = (root.ownerDocument ?? document).createTreeWalker(root, NodeFilter.SHOW_TEXT);
  for (let t = walker.nextNode(); t; t = walker.nextNode()) {
    if (t === node) return acc + offsetInNode;
    acc += (t.textContent ?? "").length;
  }
  return null;
}

export interface PdfSelectionArgs {
  page: number; // 1-based
  /** 该页 textLayer 的扁平文本（element.textContent）。 */
  pageStr: string;
  /** 页内偏移；跨页选区或元素容器时为 null。 */
  start: number | null;
  end: number | null;
  selectionText: string;
  rect: { x: number; y: number; width: number; height: number };
}

/** 组装 PDF 选区的 SelectionInfo：「周围上下文」用选区前后字符窗口替代段落（spec §6）。 */
export function buildPdfSelectionInfo(a: PdfSelectionArgs): SelectionInfo {
  const s = a.start ?? 0;
  const e = a.end ?? Math.min(s + a.selectionText.length, a.pageStr.length);
  const windowText = a.pageStr
    .slice(Math.max(0, s - CONTEXT_WINDOW), Math.min(a.pageStr.length, e + CONTEXT_WINDOW))
    .trim();
  return {
    selectionText: a.selectionText,
    paragraphBefore: null,
    paragraphCurrent: windowText.length > 0 ? windowText : a.selectionText,
    paragraphAfter: null,
    rect: a.rect,
    locatorRange:
      a.start != null && a.end != null && a.end > a.start
        ? makePdfLocatorRange({ page: a.page, start: a.start, end: a.end })
        : null,
  };
}
```

注意：第一个测试断言窗口长度 `300+6+300`——`pageStr` 两端是连续字母无空白，`trim()` 不裁剪，长度精确成立。

- [ ] **Step 5: 跑测试确认通过**

Run: `pnpm test src/renderer/reader/pdf-selection.test.ts`
Expected: 全 PASS

- [ ] **Step 6: Commit**

```bash
git add package.json pnpm-lock.yaml src/renderer/reader/pdf-selection.ts src/renderer/reader/pdf-selection.test.ts
git commit -m "feat(reader): pdf selection offset and context-window helpers"
```

---

### Task 9: PdfReader 选区接线 + SelectionToolbar PDF 门控

**背景**：spec §6——同文档原生 selection（无 iframe 桥）。mouseup 设置选区、mousedown / 滚动清除（对齐 EpubReader 的既有行为）。SelectionToolbar 在 PDF 下隐藏高亮/笔记组：P3 才有标注绘制，现在落库的标注无人能看见（**P3 时移除此门控**）。

**Files:**

- Modify: `src/renderer/reader/PdfReader.tsx`
- Modify: `src/renderer/reader/SelectionToolbar.tsx`

- [ ] **Step 1: PdfReader 选区接线**

`src/renderer/reader/PdfReader.tsx`（PdfReader 组件内）追加：

```ts
import { useAnnotationStore } from "@renderer/store/annotation-store";
import { buildPdfSelectionInfo, flatOffsetOf } from "./pdf-selection";

// 组件内：
const setSelection = useAnnotationStore((s) => s.setSelection);

// 选区：textLayer 原生 DOM selection（同文档，无 iframe 桥）→ 页内偏移 + 字符窗口上下文。
const onMouseUp = () => {
  const sel = document.getSelection();
  if (!sel || sel.isCollapsed || sel.rangeCount === 0) return;
  const range = sel.getRangeAt(0);
  const startEl =
    range.startContainer instanceof Element
      ? range.startContainer
      : range.startContainer.parentElement;
  const layer = startEl?.closest<HTMLElement>(".textLayer");
  if (!layer || !containerRef.current?.contains(layer)) return;
  const page = Number(layer.dataset.page);
  if (!Number.isInteger(page) || page < 1) return;
  const start = flatOffsetOf(layer, range.startContainer, range.startOffset);
  const endEl =
    range.endContainer instanceof Element ? range.endContainer : range.endContainer.parentElement;
  // 跨页选区：终点不在同一 textLayer → 偏移记不了（locatorRange null），仍可问 AI。
  const end =
    endEl?.closest(".textLayer") === layer
      ? flatOffsetOf(layer, range.endContainer, range.endOffset)
      : null;
  const r = range.getBoundingClientRect();
  setSelection(
    buildPdfSelectionInfo({
      page,
      pageStr: layer.textContent ?? "",
      start,
      end,
      selectionText: sel.toString(),
      rect: { x: r.x, y: r.y, width: r.width, height: r.height },
    }),
  );
};
const onMouseDown = () => setSelection(null);

// 滚动即放弃（对齐 EpubReader）：工具栏锚定视口坐标，滚动后位置失真。
// 捕获阶段监听 document——scroll 不冒泡，但能捕获到 Virtuoso 滚动容器的滚动。
useEffect(() => {
  const onScroll = () => setSelection(null);
  document.addEventListener("scroll", onScroll, true);
  return () => document.removeEventListener("scroll", onScroll, true);
}, [setSelection]);
```

容器 div 接事件：

```tsx
<div ref={containerRef} className="relative h-full" onMouseUp={onMouseUp} onMouseDown={onMouseDown}>
```

（loading 早退分支的 `<div ref={containerRef} className="h-full">` 不接事件——无内容可选。）

- [ ] **Step 2: SelectionToolbar PDF 门控**

`src/renderer/reader/SelectionToolbar.tsx`：

```ts
import { useQuery } from "@tanstack/react-query"; // useMutation 已有，合并 import

// 组件内（早退判断之前）：
// 与 ReaderView 同 key（qk.book）——React Query 去重，零额外 IPC。
const book = useQuery({
  queryKey: qk.book(bookId ?? ""),
  queryFn: () => window.api.library.get({ bookId: bookId! }),
  enabled: bookId != null,
});
// P2：PDF 选区仅接问 AI；高亮/笔记的绘制与持久化是 P3（spec §9）——
// 入口先藏，免得写入无人能看见的标注。P3 接通绘制后移除此门控。
const annotatable = book.data?.format !== "pdf";
```

JSX 中高亮/笔记/分隔符三件包进条件（AI 组不动）：

```tsx
{
  annotatable && (
    <>
      <ToolBtn
        onClick={applyHighlight}
        icon={<Highlighter className="size-3.5" />}
        label={t("reader.selection.highlight", "高亮标记")}
      />
      <ToolBtn
        onClick={addNote}
        icon={<StickyNote className="size-3.5" />}
        label={t("reader.selection.addNote", "添加笔记")}
      />
      <span className="mx-0.5 h-5 w-px bg-border" />
    </>
  );
}
```

- [ ] **Step 3: 验证**

Run: `pnpm typecheck && pnpm lint && pnpm test`
Expected: 全绿

- [ ] **Step 4: Commit**

```bash
git add src/renderer/reader/PdfReader.tsx src/renderer/reader/SelectionToolbar.tsx
git commit -m "feat(reader): wire pdf text selection into the ask-ai flow"
```

---

### Task 10: TOC 跳页 + 当前章回写

**背景**：spec §6/§9——ChapterList 点击 → 滚到章起始页；滚动 → 侧栏当前章高亮。防回环模式照抄 EpubReader 的 `topChapterIdRef`（「由滚动得出的章 id」不再触发跳转）。页→章映射抽纯函数。

**Files:**

- Create: `src/renderer/reader/pdf-chapter-at-page.ts`
- Test: `src/renderer/reader/pdf-chapter-at-page.test.ts`
- Modify: `src/renderer/reader/PdfReader.tsx`
- Modify: `src/renderer/reader/ReaderView.tsx`

- [ ] **Step 1: 写失败测试**

`src/renderer/reader/pdf-chapter-at-page.test.ts`：

```ts
import { describe, expect, it } from "vitest";
import type { ChapterRefDto } from "@shared/library";
import { chapterIdAtPage } from "./pdf-chapter-at-page";

const ch = (id: string, startPage: number | null, orderIndex: number): ChapterRefDto => ({
  id,
  title: id,
  href: `pdf-ch:${orderIndex}`,
  orderIndex,
  level: 0,
  startPage,
  endPage: null,
});

describe("chapterIdAtPage", () => {
  const chapters = [ch("a", 1, 0), ch("b", 5, 1), ch("c", 5, 2), ch("d", 20, 3)];

  it("picks the last chapter whose startPage <= page", () => {
    expect(chapterIdAtPage(chapters, 1)).toBe("a");
    expect(chapterIdAtPage(chapters, 4)).toBe("a");
    expect(chapterIdAtPage(chapters, 19)).toBe("c"); // 同页起章归后者
    expect(chapterIdAtPage(chapters, 20)).toBe("d");
    expect(chapterIdAtPage(chapters, 999)).toBe("d");
  });

  it("returns null before the first chapter or without page data", () => {
    expect(chapterIdAtPage([ch("x", 3, 0)], 2)).toBeNull();
    expect(chapterIdAtPage([ch("e", null, 0)], 1)).toBeNull(); // epub 形状的章（无页范围）
    expect(chapterIdAtPage([], 1)).toBeNull();
  });
});
```

- [ ] **Step 2: 跑测试确认失败**

Run: `pnpm test src/renderer/reader/pdf-chapter-at-page.test.ts`
Expected: FAIL（模块不存在）

- [ ] **Step 3: 实现纯函数**

`src/renderer/reader/pdf-chapter-at-page.ts`:

```ts
import type { ChapterRefDto } from "@shared/library";

/**
 * 当前页所属章 = startPage ≤ page 的最后一章（chapters 按 orderIndex 升序）。
 * 同页起章（outline 重叠，parse 端刻意允许）归后者——与「最近的标题」直觉一致。
 * 无匹配（page 在首章前 / 无页数据）→ null。
 */
export function chapterIdAtPage(chapters: ChapterRefDto[], page: number): string | null {
  let hit: string | null = null;
  for (const c of chapters) {
    if (c.startPage != null && c.startPage <= page) hit = c.id;
  }
  return hit;
}
```

- [ ] **Step 4: 跑测试确认通过**

Run: `pnpm test src/renderer/reader/pdf-chapter-at-page.test.ts`
Expected: PASS

- [ ] **Step 5: PdfReader 接线**

`src/renderer/reader/PdfReader.tsx`：

Props 与 import：

```ts
import { Virtuoso, type VirtuosoHandle } from "react-virtuoso";
import type { ChapterRefDto } from "@shared/library";
import { useNavigationStore } from "@renderer/store/navigation-store";
import { chapterIdAtPage } from "./pdf-chapter-at-page";

interface Props {
  bookId: string;
  chapters: ChapterRefDto[];
}

export function PdfReader({ bookId, chapters }: Props) {
  // ……既有 hooks 后追加：
  const currentChapterId = useNavigationStore((s) => s.currentChapterId);
  const setCurrentChapter = useNavigationStore((s) => s.setCurrentChapter);
  const virtuosoRef = useRef<VirtuosoHandle | null>(null);
  // 防循环：记录最近一次「由滚动得出的章 id」；跳章 effect 只在目标 ≠ 它时滚动（对齐 EpubReader）。
  const topChapterIdRef = useRef<string | null>(null);
```

跳章 effect（放在书加载 effect 之后）：

```ts
// 跳章：currentChapterId 变化（ChapterList 点击）→ 滚到章起始页。
useEffect(() => {
  if (!book || currentChapterId == null) return;
  if (currentChapterId === topChapterIdRef.current) return; // 由滚动引起的同步，不回滚
  const ch = chapters.find((c) => c.id === currentChapterId);
  if (ch?.startPage == null) return;
  virtuosoRef.current?.scrollToIndex({ index: ch.startPage - 1, align: "start" });
}, [book, currentChapterId, chapters]);
```

书加载 effect 的 cleanup 中追加重置（与 saveTimer 清理同处）：

```ts
topChapterIdRef.current = null;
```

Virtuoso 加 ref 并改 rangeChanged（首发同步章高亮但不写进度）：

```tsx
<Virtuoso
  ref={virtuosoRef}
  // ……其余 props 不变
  rangeChanged={(range) => {
    const page = range.startIndex + 1;
    // 当前章回写（含首发：开书恢复进度后侧栏即高亮正确章）。
    const chId = chapterIdAtPage(chapters, page);
    if (chId) {
      topChapterIdRef.current = chId;
      if (chId !== currentChapterId) setCurrentChapter(chId);
    }
    if (!sawInitialRange.current) {
      sawInitialRange.current = true;
      return; // 首发非用户滚动，不写进度
    }
    saveAt(page);
  }}
/>
```

- [ ] **Step 6: ReaderView 传 chapters**

`src/renderer/reader/ReaderView.tsx` 行 203-207 的 PDF 分支：

```tsx
<PdfReader bookId={bookId} chapters={chapters.data ?? []} />
```

- [ ] **Step 7: 验证**

Run: `pnpm typecheck && pnpm lint && pnpm test`
Expected: 全绿

- [ ] **Step 8: Commit**

```bash
git add src/renderer/reader/pdf-chapter-at-page.ts src/renderer/reader/pdf-chapter-at-page.test.ts src/renderer/reader/PdfReader.tsx src/renderer/reader/ReaderView.tsx
git commit -m "feat(reader): pdf toc jump and current-chapter highlight"
```

---

### Task 11: 全量验证 + i18n 核对 + CDP 冒烟（控制器亲自执行，不派 subagent）

- [ ] **Step 1: i18n 核对**

Run: `pnpm i18n:extract && git diff --stat src/shared/i18n/`
Expected: 本轮 UI 无新 t() 键（仅 errors.noTextLayer 改值，Task 3 已落）——extract 应零增删；若有 diff 审查后处理。

- [ ] **Step 2: 全量验证**

Run: `pnpm typecheck && pnpm lint && pnpm test`
Expected: 全绿

- [ ] **Step 3: CDP 真启动冒烟**

`pnpm start` 配 `--remote-debugging-port` 与独立 `--user-data-dir`（沿用 dev 库即可，注意 dev 透传 Chromium 开关恰好一个 `--`），清单：

1. **文字版 PDF（《图解HTTP》）**：开书 → 页面文本可拖选（透明 textLayer 与排版对齐）→ 选区工具栏出现且**只有 AI 组**（无高亮/笔记按钮）→ 点「AI 问」→ ContextPillBar 含选区+上下文 chips → 发送 → 流式回复。
2. **readPage 验证**：问「第 50 页讲了什么」→ 观察 tool call（readPage page:50）与正确回答。
3. **TOC 跳页**：侧栏点某章 → 滚到该章起始页；手动滚动 → 侧栏当前章高亮跟随；进度保存/恢复回归。
4. **缩放回归**：换档后文本层仍与画面对齐、选区仍可用。
5. **扫描版（《论语译注》）**：页面无可选文本（textLayer 空）✓；聊天问书内问题 → readChapterText 工具收到明确扫描版错误（不是空文本）；anthropic provider 下模型应改调 readPage(image) 并据图回答（best-effort，视模型配置）。
6. **title 回退**：导入一个元数据无 Title 的 PDF → 书库卡片显示文件名（去扩展名）。
7. **ePub 回归（《古事记》）**：选区工具栏完整（高亮/笔记/AI 全在）、高亮/进度/摘要照旧。

- [ ] **Step 4: 修复冒烟发现的问题并提交**

每个修复独立 commit（`fix(reader): ...`）。

---

## Self-Review 备忘（计划完成后已自查）

- spec §6 选区/TOC/textLayer、§7 readPage/门控/system prompt/既有工具兼容、§8 聊天路径防御、§9 P2 验收 —— 均有对应任务。
- §6 的「高亮绘制」「点击 overlay 编辑」属 P3，不在本计划。
- 进度 locator 的 scrollRatio 精确恢复、句柄缓存等仍在 ROADMAP 延后项，本计划不碰。
- 类型一致性：`ReadingToolsDeps.imageToolResults` / `ResolvedModel.providerType`（可选）/ `renderPage(…, textLayerDiv?)` / `PdfSelectionArgs` 各处签名前后一致。
