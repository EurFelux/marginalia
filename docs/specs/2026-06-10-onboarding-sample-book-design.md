# Onboarding Sample Book — Design

**Issue:** #25 Onboarding / landing flow（样书子特性）
**Date:** 2026-06-10
**Source:** brainstorming 会话 2026-06-10（onboarding 体验需要一本可读的书）
**关联 spec:** `2026-06-09-onboarding-flow-design.md`（AI 引导卡片，本特性的姐妹件）

## 1. 目标与非目标

**目标**：首次启动时自动为空书库导入一本**内置、本地化、正常可删**的样书，让新用户立刻有内容可读、可标注、可（配好 AI 后）选区问 AI——补齐 onboarding 体验闭环。

**非目标**：

- 不打包二进制 epub 资源（改为主进程代码内构建，见 §3）。
- 不追随后续 UI 语言切换重新本地化已导入的样书（只按首启语言播一次，见 §5.3）。
- 不给样书任何特殊标记/特殊行为——它就是一本普通书（普通删除、普通阅读、普通进度/标注）。
- 不阻断或改变 AI 引导卡片（两者互补，见 §6）。

## 2. 交付方式（brainstorming 结论）

| 维度     | 决策                                                     | 理由                                                                                                        |
| -------- | -------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------- |
| 出现方式 | **首启自动导入**为一本正常可删的书                       | 「内置于应用、用于 onboarding」最名符其实；空书架对新用户是死胡同                                           |
| 构建方式 | **主进程代码内构建字节**（fflate），非打包二进制         | `importBook` 直接吃 bytes；避开 `extraResource`/dev-prod 路径/asar 打包坑（见 CLAUDE.md「打包期资源路径」） |
| 本地化   | 按**首启语言**构建整本同语种内容（zh-CN / en）           | 书与界面语言一致；闭合枚举仅两值                                                                            |
| 重复保护 | 持久 `sampleSeeded` 标记（存 `app_meta` 表）；删书不重置 | 用户删了不再自动塞回，尊重选择                                                                              |

## 3. 关键架构事实（实现据此）

- **导入吃字节**：`importBook(db, input: { bytes: Uint8Array; fileName? }): Promise<BookRow>`（`src/main/library/repository.ts`）内部 `detectFormat` 后走 `importEpubBook`。故主进程可 `await importBook(getDb(), { bytes: buildSampleEpub(lang) })`，**无需 filePath / 临时文件 / 打包资源**。
- **语言解析单一源**：`resolveInitialLanguage(stored, systemLocale)` 与 `matchSystemLanguage`（`src/shared/i18n/language.ts`，纯函数）——「已存 `language` 偏好优先，否则系统 locale：`zh*`→zh-CN，其余→en」。`main.ts` 启动已用它喂 `initMainI18n`（line 133-135）。**本特性复用该次解析结果**（不重复解析），故书与 UI 语言必然一致。
- **应用内部状态新表 `app_meta`**：`sampleSeeded` 是**主进程内部状态**，不属用户偏好，故**不**进 `preferences` 表/契约（避免污染面向渲染层的 `setPreferenceInput` + 启动快照）。新建独立 KV 表 `app_meta`（镜像 `preferences` 表结构：`key TEXT PK / value JSON / updated_at`），由主进程专用 `getAppMeta/setAppMeta` 读写；表与渲染层完全无关。
- **幂等启动播种先例**：`initDb()` 已调 `ensureBuiltinProviders`，且其内先跑 `runMigrations`（故 `app_meta` 表在播种前已存在）；样书播种仿此挂在启动序列（`app.on("ready")` 内，`initDb()` 后）。
- **fflate 可用**：epub-parser 依赖已传递安装于根 `node_modules`；本特性主进程直接 import，故**提为根直接依赖**（package.json）以正名，不靠 hoist 巧合。

## 4. 模块与文件

| 文件                                      | 责任                                                                                                                                                                                                                                                               | 动作     |
| ----------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ | -------- |
| `src/main/db/schema.ts`                   | 新增 `app_meta` 表：`{ key: text PK, value: text json notNull, updatedAt: integer $defaultFn }`（镜像 `preferences`）。                                                                                                                                            | Modify   |
| `src/main/db/migrations/<ts>_app_meta/`   | `pnpm db:generate` 生成的迁移目录（`migration.sql` + `snapshot.json`）。**勿手编辑**。                                                                                                                                                                             | Generate |
| `src/main/app-meta/repository.ts`         | 主进程内部 KV 读写：`type AppMetaKey = "sampleSeeded"`；`getAppMeta(db, key: AppMetaKey): unknown \| null`、`setAppMeta(db, key: AppMetaKey, value: unknown): void`（upsert）。                                                                                    | Create   |
| `src/main/app-meta/repository.test.ts`    | `:memory:` DB：set→get 往返；未设时 get 返回 null；同 key upsert 覆盖。                                                                                                                                                                                            | Create   |
| `src/main/onboarding/sample-book.ts`      | `buildSampleEpub(language: UILanguage): Uint8Array`——按语言选内容集，fflate 打包成合法 EPUB3 字节。内容（书名/TOC/各章 HTML/`dc:title`/`dc:language`）以可审阅常量存于此。纯函数。                                                                                 | Create   |
| `src/main/onboarding/sample-book.test.ts` | 往返测试：两语言各自 `parseEpub(buildSampleEpub(lang))` → 对应语种标题 + spine 3 + toc 3。                                                                                                                                                                         | Create   |
| `src/main/onboarding/seed-sample.ts`      | `maybeSeedSampleBook(db, language: UILanguage): Promise<void>`（async）——`getAppMeta(db,"sampleSeeded")===true` 则返回；否则 `await importBook(db,{bytes:buildSampleEpub(language)})`→`setAppMeta(db,"sampleSeeded",true)`→`log.info`；失败 `log.warn` 不置 flag。 | Create   |
| `src/main/onboarding/seed-sample.test.ts` | `:memory:` DB：首播导入一本（标题为注入语种）且置 flag；二次调用不重复导入；flag 已 true 时即使库空也不导入（模拟删后不复活）。                                                                                                                                    | Create   |
| `src/main.ts`                             | 把 line 134 的语言解析提为 `const lang`，喂 `initMainI18n(lang)`；ready 回调改 `async`；`createWindow()` 前 `await maybeSeedSampleBook(getDb(), lang)`。                                                                                                           | Modify   |
| `package.json`                            | 加 `fflate` 直接依赖。                                                                                                                                                                                                                                             | Modify   |

## 5. 行为规格

### 5.1 播种判定与时机

- 位置：`main.ts` 的 `app.on("ready")` 回调（改为 `async`），`initDb()` + `initMainI18n(lang)` 之后、`createWindow()` 之前 `await` 播种 → 首帧渲染时书与 flag 均已落库（无空→有闪烁；不依赖「epub 内部恰好同步」）。
- `lang` 复用：ready 回调把现有第 134 行的 `resolveInitialLanguage(getPreference(getDb(),"language") ?? undefined, app.getLocale())` 提取为 `const lang`，同时喂 `initMainI18n(lang)` 与 `maybeSeedSampleBook(getDb(), lang)`。
- `async maybeSeedSampleBook(db, language)`：
  1. `if (getAppMeta(db, "sampleSeeded") === true) return;`
  2. `try { await importBook(db, { bytes: buildSampleEpub(language) }); setAppMeta(db, "sampleSeeded", true); log.info("seeded sample book", { language }); }`
  3. `catch (err) { log.warn("sample book seed failed", err); }` —— **不置 flag**，下次启动重试（内容静态合法，失败仅可能为底层 DB 异常）。
- 非首启 `sampleSeeded=true` 直接返回，零开销。

### 5.2 本地化

- `buildSampleEpub(language)`：`switch (language) { case "zh-CN": …; case "en": …; default: en }`（`UILanguage` 闭合枚举仅两值，default 为防御）。每语言一套：书名、3 章标题、3 章正文 HTML、`<dc:title>`、`<dc:language>`。
- 内容主题（两语言各自成篇、非逐句互译，但同一主旨）：「在书页边缘阅读/批注」+ 一篇短篇（供测「生成摘要」）。具体文案在实现计划中给全。

### 5.3 只播一次

- 样书语言 = 首启那一刻解析出的语言。之后用户切换 UI 语言**不**重新本地化已存样书（`sampleSeeded` 已 true）。一本书语言本就固定；用户要换可自行删除并导入自己的书，应用不再自动塞。

### 5.4 删除行为

- 样书 = 普通书，走既有 `library:delete`（级联删 DB + unlink 副本）。删除后 `app_meta.sampleSeeded` 保持 true → 重启不复活。

## 6. 与 AI 引导卡片的关系

互补无冲突。首启首屏 = 样书一本（书库非空、空状态消失）+ AI 引导卡片仍在（AI 未配置）。用户可立即开样书阅读/标注；配好 AI 后即可对样书选区问 AI / 生成章节摘要，形成完整首次体验闭环。

## 7. 测试策略

- **纯构建**（headless vitest）：`sample-book.test.ts` —— 两语言往返 `parseEpub`，断言标题为对应语种、`spine`/`toc` 各 3。
- **播种逻辑**（`:memory:` DB）：`seed-sample.test.ts` —— 见 §4；覆盖首播+置 flag+导入语种正确、二次不重播、flag-true-空库不播。语言解析本身（stored vs locale）由 `resolveInitialLanguage` 既有测试覆盖，不在此重复。
- **app_meta 仓储**（`:memory:` DB）：`repository.test.ts` —— set/get 往返、缺省 null、upsert 覆盖。
- **手动冒烟**（dev，`--user-data-dir` 隔离）：① 全新 profile（系统 zh）→ 启动即见一本中文样书 + 引导卡片，空状态消失；开书读三章、选区标注。② 删样书 → 重启不复活，`sqlite` 查 `app_meta` 有 `sampleSeeded=true`。③ 全新 profile 预置 `language=en`（或英文系统 locale）→ 样书为英文。

## 8. 延后 / 非本特性

- 样书随 UI 语言切换重新本地化（本特性明确不做）。
- 样书内嵌封面图（暂用书库基于标题的色块占位封面，已够；如需精致封面后续单议）。
- 姐妹 spec 的设置页 `SummaryModelPicker` 未配置默认对话模型——仍属另一 follow-up。
