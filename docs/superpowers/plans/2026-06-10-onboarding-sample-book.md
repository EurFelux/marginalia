# Onboarding Sample Book Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 首次启动时自动为空书库导入一本内置、本地化（zh-CN / en）、正常可删的样书，补齐 onboarding 体验闭环。

**Architecture:** 主进程用 fflate 代码内构建样书 EPUB3 字节（内容为可审阅常量），按首启解析出的 UI 语言选整本同语种内容，经 `importBook(db,{bytes})` 落库（无打包资源/无临时文件）。一次性保护用独立的 `app_meta` KV 表（与用户偏好分离），删书不复活。播种挂在 `app.on("ready")`、`createWindow()` 前 `await`。

**Tech Stack:** TypeScript（strict）、Drizzle ORM + better-sqlite3、fflate（zip）、`@marginalia/epub-parser`、vitest（headless，`:memory:` SQLite）。

**Spec:** `docs/superpowers/specs/2026-06-10-onboarding-sample-book-design.md`

---

## 文件结构

| 文件                                      | 责任                                                           | 动作     |
| ----------------------------------------- | -------------------------------------------------------------- | -------- |
| `src/main/db/schema.ts`                   | 新增 `app_meta` 表（镜像 `preferences`）                       | Modify   |
| `src/main/db/migrations/<ts>_*/`          | `pnpm db:generate` 生成的迁移（勿手编辑）                      | Generate |
| `src/main/app-meta/repository.ts`         | `getAppMeta/setAppMeta`（主进程内部 KV）                       | Create   |
| `src/main/app-meta/repository.test.ts`    | 仓储往返单测                                                   | Create   |
| `src/main/onboarding/sample-book.ts`      | `buildSampleEpub(language)` + 两语言内容常量（纯函数）         | Create   |
| `src/main/onboarding/sample-book.test.ts` | 两语言 `parseEpub` 往返                                        | Create   |
| `src/main/onboarding/seed-sample.ts`      | `maybeSeedSampleBook(db, language)`（幂等播种）                | Create   |
| `src/main/onboarding/seed-sample.test.ts` | `:memory:` 播种逻辑单测                                        | Create   |
| `src/main.ts`                             | ready 改 async；提 `lang` 复用；`createWindow()` 前 await 播种 | Modify   |
| `package.json`                            | 加 `fflate` 直接依赖                                           | Modify   |

通用注意：

- 每改一处先 `git branch --show-current` 应为 `feat/onboarding-flow`，**不要切分支**。
- pre-commit 钩子（prek）跑 lint:fix + format，可能改文件并以 "files were modified by this hook" 中止；遇到就重新 `git add` 再跑同一条 commit（第二次过）。
- 测试跑在 Electron 运行时（`pnpm test`），无需任何 ABI 翻转。
- 主进程日志用 `import { createLogger } from "@main/logger"`，模块名 `library` 或新 `onboarding` 短域名；Error 作第二参，勿拼进 message。

---

## Task 1: `app_meta` 表 + 迁移 + 仓储（TDD）

**Files:**

- Create: `src/main/app-meta/repository.ts`
- Test: `src/main/app-meta/repository.test.ts`
- Modify: `src/main/db/schema.ts`
- Generate: `src/main/db/migrations/<ts>_*/`

- [ ] **Step 1: 写失败测试**

Create `src/main/app-meta/repository.test.ts`:

```ts
import path from "node:path";
import { describe, expect, it } from "vitest";
import { createDb, runMigrations } from "@main/db/client";
import { getAppMeta, setAppMeta } from "@main/app-meta/repository";

const MIGRATIONS = path.resolve(__dirname, "../db/migrations");

function freshDb() {
  const db = createDb(":memory:");
  runMigrations(db, MIGRATIONS);
  return db;
}

describe("app-meta repository", () => {
  it("returns null for an unset key", () => {
    const db = freshDb();
    expect(getAppMeta(db, "sampleSeeded")).toBeNull();
  });

  it("set then get round-trips the value", () => {
    const db = freshDb();
    setAppMeta(db, "sampleSeeded", true);
    expect(getAppMeta(db, "sampleSeeded")).toBe(true);
  });

  it("upsert overwrites an existing key", () => {
    const db = freshDb();
    setAppMeta(db, "sampleSeeded", true);
    setAppMeta(db, "sampleSeeded", false);
    expect(getAppMeta(db, "sampleSeeded")).toBe(false);
  });
});
```

- [ ] **Step 2: 跑测试确认失败**

Run: `pnpm test src/main/app-meta/repository.test.ts`
Expected: FAIL — `Cannot find module '@main/app-meta/repository'`。

- [ ] **Step 3: 加 `app_meta` 表（`src/main/db/schema.ts`）**

在 `preferences` 表定义之后（约 line 213 之后）加：

```ts
/** 应用内部状态 KV（非用户偏好；渲染层不可见）。与 preferences 表分离，故不进任何渲染层契约。 */
export const appMeta = sqliteTable("app_meta", {
  key: text("key").primaryKey(),
  value: text("value", { mode: "json" }).$type<unknown>().notNull(),
  updatedAt: integer("updated_at")
    .notNull()
    .$defaultFn(() => Date.now()),
});
```

（`sqliteTable`/`text`/`integer` 已在文件顶部从 `drizzle-orm/sqlite-core` 导入，无需新增 import。）

- [ ] **Step 4: 生成迁移**

Run: `pnpm db:generate`
Expected: 在 `src/main/db/migrations/` 下新增一个子目录 `<timestamp>_<name>/`（含 `migration.sql` 创建 `app_meta` 表 + `snapshot.json`）。**不要手编辑**生成物。

- [ ] **Step 5: 写仓储实现**

Create `src/main/app-meta/repository.ts`:

```ts
import { eq } from "drizzle-orm";
import type { DB } from "@main/db/client";
import { appMeta } from "@main/db/schema";

/** 应用内部状态键（非用户偏好，渲染层不可见）。新增内部标记＝在此加一个字面量。 */
export type AppMetaKey = "sampleSeeded";

/** 读应用内部状态；未存返回 null。value 为存入时的任意 JSON。 */
export function getAppMeta(db: DB, key: AppMetaKey): unknown {
  const row = db.select().from(appMeta).where(eq(appMeta.key, key)).get();
  return row ? row.value : null;
}

/** 写应用内部状态（upsert）。 */
export function setAppMeta(db: DB, key: AppMetaKey, value: unknown): void {
  const now = Date.now();
  db.insert(appMeta)
    .values({ key, value, updatedAt: now })
    .onConflictDoUpdate({ target: appMeta.key, set: { value, updatedAt: now } })
    .run();
}
```

- [ ] **Step 6: 跑测试确认通过**

Run: `pnpm test src/main/app-meta/repository.test.ts && pnpm typecheck`
Expected: PASS（3 用例绿；typecheck 干净——`runMigrations` 在 `:memory:` 建出 `app_meta` 表）。

- [ ] **Step 7: 提交**

```bash
git add src/main/db/schema.ts src/main/db/migrations src/main/app-meta/repository.ts src/main/app-meta/repository.test.ts
git commit -m "feat(app-meta): add internal app_meta KV table + repository"
```

---

## Task 2: fflate 依赖 + `buildSampleEpub`（TDD）

**Files:**

- Modify: `package.json`
- Create: `src/main/onboarding/sample-book.ts`
- Test: `src/main/onboarding/sample-book.test.ts`

- [ ] **Step 1: 加 fflate 直接依赖**

Run: `pnpm add fflate@^0.8.2`
Expected: `package.json` `dependencies` 出现 `"fflate": "^0.8.2"`（解析到已装的 0.8.3，与 epub-parser 同版本去重）。该命令会触发 install；根 `postinstall` 会把 better-sqlite3 翻回 Electron ABI（自动，无需手动）。

- [ ] **Step 2: 写失败测试**

Create `src/main/onboarding/sample-book.test.ts`:

```ts
import { describe, expect, it } from "vitest";
import { parseEpub } from "@marginalia/epub-parser";
import { buildSampleEpub } from "@main/onboarding/sample-book";

describe("buildSampleEpub", () => {
  it("builds a valid 3-chapter English book", async () => {
    const parsed = await parseEpub(buildSampleEpub("en"));
    expect(parsed.title).toMatch(/Margin/);
    expect(parsed.spine.length).toBe(3);
    expect(parsed.toc.length).toBe(3);
  });

  it("builds a valid 3-chapter Chinese book", async () => {
    const parsed = await parseEpub(buildSampleEpub("zh-CN"));
    expect(parsed.title).toMatch(/页边/);
    expect(parsed.spine.length).toBe(3);
    expect(parsed.toc.length).toBe(3);
  });

  it("English and Chinese builds differ", () => {
    expect(buildSampleEpub("en")).not.toEqual(buildSampleEpub("zh-CN"));
  });
});
```

- [ ] **Step 3: 跑测试确认失败**

Run: `pnpm test src/main/onboarding/sample-book.test.ts`
Expected: FAIL — `Cannot find module '@main/onboarding/sample-book'`。

- [ ] **Step 4: 写实现（含两语言完整文案）**

Create `src/main/onboarding/sample-book.ts`:

```ts
import { strToU8, zipSync } from "fflate";
import type { UILanguage } from "@shared/i18n/language";

/** 一种语言的整本样书内容（书名 + dc:language + 3 章）。 */
interface SampleContent {
  identifier: string;
  bookTitle: string;
  /** OPF dc:language 值。 */
  lang: string;
  navTitle: string;
  chapters: { id: string; title: string; bodyHtml: string }[];
}

const EN: SampleContent = {
  identifier: "urn:uuid:marginalia-sample-en",
  bookTitle: "The Margin — A Sample Reader",
  lang: "en",
  navTitle: "Contents",
  chapters: [
    {
      id: "ch1",
      title: "I. On Reading in the Margins",
      bodyHtml:
        "<h1>I. On Reading in the Margins</h1>" +
        "<p>A book is never quite finished on the day it is printed. It waits, patiently, for a reader who will argue with it, underline it, and scribble in the white space along its edges. Those edges have a name: the margins. For centuries they were where readers kept their truest thoughts.</p>" +
        "<p>To read in the margins is to refuse to be a passive guest. You stop, you doubt, you ask a question the author never anticipated. The page becomes a conversation rather than a lecture, and the conversation can last for years.</p>" +
        "<p>Try it now. Choose any sentence on this page that interests you, and ask what it assumes, what it leaves out, or what it would mean if it were false. The smallest question, asked honestly, can unlock the whole paragraph.</p>" +
        "<p>The best marginalia are not summaries. They are surprises — the moment you notice that two distant ideas secretly rhyme, or that a confident claim rests on a quiet, unexamined leap. Keep your pencil close. The next surprise is usually one sentence away.</p>",
    },
    {
      id: "ch2",
      title: "II. A Question Worth Keeping",
      bodyHtml:
        "<h1>II. A Question Worth Keeping</h1>" +
        "<p>Not every question deserves an answer on the spot. Some are worth keeping — carried from page to page, turned over in the dark, allowed to ripen. A good reader collects questions the way others collect quotations.</p>" +
        "<p>When a sentence resists you, that resistance is information. Do not rush to resolve it. Ask it aloud, write it in the margin, and let it travel with you into the next chapter, where the book may answer it without meaning to.</p>" +
        "<p>The strange thing about a kept question is how it changes what you notice. Once you are genuinely curious whether the author is right, every example becomes evidence and every aside a clue. The book stops washing over you and starts arguing back.</p>" +
        "<p>So when something here puzzles you, resist the urge to move on. Select it, and hold it up to the light. The question you keep today is the understanding you earn tomorrow.</p>",
    },
    {
      id: "ch3",
      title: "III. The Lamplighter's Question",
      bodyHtml:
        "<h1>III. The Lamplighter's Question</h1>" +
        "<p>In a town that had forgotten the stars, there lived a lamplighter who climbed the same hill every dusk to light a single lamp. No one had asked him to. The lamp lit nothing but a bend in an empty road.</p>" +
        "<p>One evening a child followed him up and asked why he bothered, since no traveler ever came. The lamplighter thought for a long moment. “I light it,” he said, “so that if someone comes, the dark will not have the last word.”</p>" +
        "<p>The child returned the next night, and the next, until lighting the lamp became something the two of them did together. In time others climbed the hill as well, not because the road had changed, but because a small, stubborn light had given them a reason to look up.</p>" +
        "<p>Years later the town remembered the lamp long after it remembered the darkness. That is the strange arithmetic of small, faithful acts: they are easy to dismiss while they happen, and impossible to forget once they are done.</p>",
    },
  ],
};

const ZH: SampleContent = {
  identifier: "urn:uuid:marginalia-sample-zh",
  bookTitle: "页边 · 示例读本",
  lang: "zh-CN",
  navTitle: "目录",
  chapters: [
    {
      id: "ch1",
      title: "一、在书页的边缘阅读",
      bodyHtml:
        "<h1>一、在书页的边缘阅读</h1>" +
        "<p>读书最孤独也最自由的时刻，往往不在正文之内，而在页边那一道窄窄的空白里。那里没有作者的声音，只有你自己的疑问、反驳与忽然亮起的联想。把它们写下来，一本书才真正属于你。</p>" +
        "<p>边缘不是次要的地方。许多伟大的思想，最初都只是某个读者在页脚潦草写下的一句「真的是这样吗？」。怀疑不是对作者的不敬，而是阅读最诚实的姿态。</p>" +
        "<p>现在不妨试试：在这一段里挑一句你最不确定的话，问问它依赖了什么前提，又回避了什么。一个足够小的问题，常常能撒动一整页的意义。</p>" +
        "<p>真正好的批注从不只是复述。它是一种发现——你忽然看见两个相隔很远的念头其实在暗暗押韵，或是一个笃定的断言底下，藏着一处无人追问的轻轻一跃。把铅笔握紧，下一个发现往往就在一句话之外。</p>",
    },
    {
      id: "ch2",
      title: "二、值得留住的疑问",
      bodyHtml:
        "<h1>二、值得留住的疑问</h1>" +
        "<p>不是每个问题都该当场得到答案。有些值得留住——从这一页带到那一页，在夜里反复掂量，任它慢慢成熟。好的读者收集疑问，就像别人收集警句。</p>" +
        "<p>当一句话让你卡住，那份卡顿本身就是信息。别急着把它抹平。把它念出声，写在页边，让它随你走进下一章——书也许会在无意之间替你回答。</p>" +
        "<p>留住的疑问最奇妙之处，在于它改变你所看见的东西。一旦你真心想知道作者是否正确，每个例子都成了证据，每句旁白都成了线索。书不再从你身上漫过，而是开始与你争辩。</p>" +
        "<p>所以当这里有什么让你困惑，别急着翻过去。选中它，举到光下细看。你今天留住的疑问，正是你明天挣得的理解。</p>",
    },
    {
      id: "ch3",
      title: "三、点灯人的问题",
      bodyHtml:
        "<h1>三、点灯人的问题</h1>" +
        "<p>在一座忘记了星辰的小镇上，住着一个点灯人。每到黄昏，他都爬上同一座山岗，点亮一盏灯。没有人请他这么做。那盏灯照亮的，不过是空荡荡路上的一个弯。</p>" +
        "<p>一天傍晚，一个孩子跟着他上了山，问他何必如此——从没有旅人经过。点灯人想了很久，说：「我点上它，是为了万一有人来时，黑暗不至于说了最后一句话。」</p>" +
        "<p>第二天孩子又来了，之后每天都来，直到点灯成了他俩一起做的事。渐渐地，别的人也爬上山岗——不是因为路变了，而是因为一簇小小的、固执的光，给了他们抬头的理由。</p>" +
        "<p>许多年后，小镇记住那盏灯的时间，远比记住黑暗的时间长。这正是微小而忠实之举古怪的算术：它们发生时容易被轻视，做成了却再难被忘记。</p>",
    },
  ],
};

function contentFor(language: UILanguage): SampleContent {
  switch (language) {
    case "zh-CN":
      return ZH;
    case "en":
      return EN;
    default:
      return EN;
  }
}

/** 按语言代码内构建一本合法 EPUB3 样书字节（无打包资源）。纯函数。 */
export function buildSampleEpub(language: UILanguage): Uint8Array {
  const c = contentFor(language);

  const container =
    '<?xml version="1.0"?>\n' +
    '<container version="1.0" xmlns="urn:oasis:names:tc:opendocument:xmlns:container">\n' +
    '  <rootfiles><rootfile full-path="OEBPS/content.opf" media-type="application/oebps-package+xml"/></rootfiles>\n' +
    "</container>";

  const manifestItems = c.chapters
    .map((ch) => `<item id="${ch.id}" href="${ch.id}.xhtml" media-type="application/xhtml+xml"/>`)
    .join("\n    ");
  const spineItems = c.chapters.map((ch) => `<itemref idref="${ch.id}"/>`).join("\n    ");

  const opf =
    '<?xml version="1.0" encoding="utf-8"?>\n' +
    '<package xmlns="http://www.idpf.org/2007/opf" version="3.0" unique-identifier="bookid">\n' +
    '  <metadata xmlns:dc="http://purl.org/dc/elements/1.1/">\n' +
    `    <dc:identifier id="bookid">${c.identifier}</dc:identifier>\n` +
    `    <dc:title>${c.bookTitle}</dc:title>\n` +
    "    <dc:creator>Marginalia</dc:creator>\n" +
    `    <dc:language>${c.lang}</dc:language>\n` +
    "  </metadata>\n" +
    "  <manifest>\n" +
    '    <item id="nav" href="nav.xhtml" media-type="application/xhtml+xml" properties="nav"/>\n' +
    `    ${manifestItems}\n` +
    "  </manifest>\n" +
    "  <spine>\n" +
    `    ${spineItems}\n` +
    "  </spine>\n" +
    "</package>";

  const navList = c.chapters
    .map((ch) => `<li><a href="${ch.id}.xhtml">${ch.title}</a></li>`)
    .join("\n    ");
  const nav =
    '<?xml version="1.0" encoding="utf-8"?>\n' +
    '<html xmlns="http://www.w3.org/1999/xhtml" xmlns:epub="http://www.idpf.org/2007/ops">\n' +
    `  <head><title>${c.navTitle}</title></head>\n` +
    `  <body><nav epub:type="toc"><ol>\n    ${navList}\n  </ol></nav></body>\n` +
    "</html>";

  const files: Record<string, Uint8Array | [Uint8Array, { level: 0 }]> = {
    mimetype: [strToU8("application/epub+zip"), { level: 0 }],
    "META-INF/container.xml": strToU8(container),
    "OEBPS/content.opf": strToU8(opf),
    "OEBPS/nav.xhtml": strToU8(nav),
  };
  for (const ch of c.chapters) {
    const xhtml =
      '<?xml version="1.0" encoding="utf-8"?>\n' +
      `<html xmlns="http://www.w3.org/1999/xhtml"><head><title>${ch.title}</title></head><body>${ch.bodyHtml}</body></html>`;
    files[`OEBPS/${ch.id}.xhtml`] = strToU8(xhtml);
  }

  return zipSync(files as Parameters<typeof zipSync>[0]);
}
```

- [ ] **Step 5: 跑测试确认通过**

Run: `pnpm test src/main/onboarding/sample-book.test.ts && pnpm typecheck`
Expected: PASS（两语言往返解析出对应标题 + 各 3 章；typecheck 干净）。

- [ ] **Step 6: 提交**

```bash
git add package.json pnpm-lock.yaml src/main/onboarding/sample-book.ts src/main/onboarding/sample-book.test.ts
git commit -m "feat(onboarding): build localized sample epub in-code (fflate)"
```

---

## Task 3: `maybeSeedSampleBook` 幂等播种（TDD）

**Files:**

- Create: `src/main/onboarding/seed-sample.ts`
- Test: `src/main/onboarding/seed-sample.test.ts`

- [ ] **Step 1: 写失败测试**

Create `src/main/onboarding/seed-sample.test.ts`:

```ts
import path from "node:path";
import { describe, expect, it } from "vitest";
import { createDb, runMigrations } from "@main/db/client";
import { books } from "@main/db/schema";
import { getAppMeta, setAppMeta } from "@main/app-meta/repository";
import { maybeSeedSampleBook } from "@main/onboarding/seed-sample";

const MIGRATIONS = path.resolve(__dirname, "../db/migrations");

function freshDb() {
  const db = createDb(":memory:");
  runMigrations(db, MIGRATIONS);
  return db;
}

describe("maybeSeedSampleBook", () => {
  it("seeds one book in the given language and sets the flag", async () => {
    const db = freshDb();
    await maybeSeedSampleBook(db, "en");
    const rows = db.select().from(books).all();
    expect(rows.length).toBe(1);
    expect(rows[0].title).toMatch(/Margin/);
    expect(getAppMeta(db, "sampleSeeded")).toBe(true);
  });

  it("seeds the Chinese book when language is zh-CN", async () => {
    const db = freshDb();
    await maybeSeedSampleBook(db, "zh-CN");
    const rows = db.select().from(books).all();
    expect(rows[0].title).toMatch(/页边/);
  });

  it("does not re-import on a second call", async () => {
    const db = freshDb();
    await maybeSeedSampleBook(db, "en");
    await maybeSeedSampleBook(db, "en");
    expect(db.select().from(books).all().length).toBe(1);
  });

  it("does not import when the flag is already set (deleted-sample stays gone)", async () => {
    const db = freshDb();
    setAppMeta(db, "sampleSeeded", true);
    await maybeSeedSampleBook(db, "en");
    expect(db.select().from(books).all().length).toBe(0);
  });
});
```

- [ ] **Step 2: 跑测试确认失败**

Run: `pnpm test src/main/onboarding/seed-sample.test.ts`
Expected: FAIL — `Cannot find module '@main/onboarding/seed-sample'`。

- [ ] **Step 3: 写实现**

Create `src/main/onboarding/seed-sample.ts`:

```ts
import type { DB } from "@main/db/client";
import type { UILanguage } from "@shared/i18n/language";
import { importBook } from "@main/library/repository";
import { getAppMeta, setAppMeta } from "@main/app-meta/repository";
import { buildSampleEpub } from "@main/onboarding/sample-book";
import { createLogger } from "@main/logger";

const log = createLogger("onboarding");

/**
 * 首启幂等播种内置样书：未播过则按 language 构建并导入一本，置 sampleSeeded 标记。
 * 已播过（含用户删书后）直接返回——删了不再自动塞回。失败留 warn 不置标记，下次重试。
 */
export async function maybeSeedSampleBook(db: DB, language: UILanguage): Promise<void> {
  if (getAppMeta(db, "sampleSeeded") === true) return;
  try {
    await importBook(db, { bytes: buildSampleEpub(language) });
    setAppMeta(db, "sampleSeeded", true);
    log.info("seeded sample book", { language });
  } catch (err) {
    log.warn("sample book seed failed", err);
  }
}
```

- [ ] **Step 4: 跑测试确认通过**

Run: `pnpm test src/main/onboarding/seed-sample.test.ts && pnpm typecheck`
Expected: PASS（4 用例绿：英文播种+置 flag、中文播种、二次不重播、flag-true 不播）。

- [ ] **Step 5: 提交**

```bash
git add src/main/onboarding/seed-sample.ts src/main/onboarding/seed-sample.test.ts
git commit -m "feat(onboarding): seed localized sample book on first run"
```

---

## Task 4: `main.ts` 启动接线

**Files:**

- Modify: `src/main.ts`

> 无自动化单测（启动接线）；靠 `pnpm typecheck` + Task 5 手动冒烟保障。`resolveInitialLanguage` / `getPreference` 已在 main.ts 导入（line 134 处使用），只需新增 `maybeSeedSampleBook` 导入。

- [ ] **Step 1: 加 import**

在 `src/main.ts` 顶部 import 区（其他 `@main/...` import 附近）加：

```ts
import { maybeSeedSampleBook } from "@main/onboarding/seed-sample";
```

- [ ] **Step 2: ready 回调改 async + 提取 lang + await 播种**

把 `app.on("ready", () => {` 改为 `app.on("ready", async () => {`。

把原本内联在 `initMainI18n(...)` 实参里的语言解析（约 line 133-135）：

```ts
initMainI18n(
  resolveInitialLanguage(getPreference(getDb(), "language") ?? undefined, app.getLocale()),
);
```

改为先解析为 `const lang` 再复用：

```ts
const lang = resolveInitialLanguage(
  getPreference(getDb(), "language") ?? undefined,
  app.getLocale(),
);
initMainI18n(lang);
```

并在该 ready 回调末尾的 `createWindow();`（约 line 151）**之前**插入：

```ts
await maybeSeedSampleBook(getDb(), lang);
createWindow();
```

- [ ] **Step 3: typecheck**

Run: `pnpm typecheck`
Expected: PASS（async 回调合法；`maybeSeedSampleBook` 返回 Promise 被 await）。

- [ ] **Step 4: 提交**

```bash
git add src/main.ts
git commit -m "feat(onboarding): seed sample book during startup before window creation"
```

---

## Task 5: 全量验证 + 手动冒烟 + changeset

**Files:**

- Create: `.changeset/<name>.md`

- [ ] **Step 1: 全量 gate**

Run: `pnpm typecheck && pnpm lint && pnpm test`
Expected: 三者全绿（app-meta / sample-book / seed-sample 测试通过；既有套件不回归）。失败则 STOP 报告，不擅改无关失败。

- [ ] **Step 2: 手动冒烟（全新 profile，由控制者执行）**

> 控制者（非子代理）用隔离临时 userData 起 dev 验证。dev 也吃 `--user-data-dir`（恰好一个 `--`）。直接 `electron-forge start`（`pnpm start` 的 concurrently 会把 `--` 后参数当成额外命令，故绕开）：

```bash
rm -rf /tmp/mg-sample-smoke
pnpm exec electron-forge start -- --user-data-dir=/tmp/mg-sample-smoke
```

目视核对：

1. 全新 profile（中文系统 locale）→ 启动即书库有**一本中文样书《页边 · 示例读本》** + AI 引导卡片（空状态消失）。
2. 打开样书 → 左栏 TOC 三章、可翻页、选区可标注。
3. 删除样书 → 重启同一 `--user-data-dir` → 样书**不复活**；`sqlite3 /tmp/mg-sample-smoke/marginalia.db "SELECT * FROM app_meta;"` 应见 `sampleSeeded|true`。
4. 英文核对：`rm -rf /tmp/mg-sample-smoke-en` 后预置语言（或英文系统 locale），起 `--user-data-dir=/tmp/mg-sample-smoke-en` → 样书为英文《The Margin — A Sample Reader》。

- [ ] **Step 3: 写 changeset**

参照 `.changeset/` 既有文件的 frontmatter（包名 `marginalia`）。Create `.changeset/onboarding-sample-book.md`：

```md
---
"marginalia": minor
---

Seed a built-in localized sample book into the library on first launch, so new readers have something to open, annotate, and try AI on right away. It is a normal, deletable book and won't come back once removed.
```

- [ ] **Step 4: 提交**

```bash
git add .changeset/onboarding-sample-book.md
git commit -m "chore(onboarding): add changeset for sample book"
```

---

## 收尾（实现完成后）

- 用 `superpowers:finishing-a-development-branch` 决定集成（本地 main rebase 线性，见 memory `local-main-rebase-linear-workflow`）。本特性与 AI 引导卡片同在 `feat/onboarding-flow` 分支，一并合并。
- 合并后用 `kanban` skill：commit 含 `closes #25` → GitHub 自动关 issue → Projects 自动挪 Done。
- 延后项（spec §8）：样书随语言切换重新本地化（不做）、精致封面、设置页 SummaryModelPicker 默认对话模型（姐妹 spec follow-up）。

```

```
