# API key 明文落库重构 · 实现计划

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 按 [2026-06-04 spec](../specs/2026-06-04-plaintext-api-key-storage-design.md) 将 API key 从 safeStorage 密文（`api_key_encrypted` BLOB）改为明文落库（`api_key` TEXT），退役 Encryptor 抽象，`ProviderDto.key` 判别联合降为 `keyMask: string | null`。

**Architecture:** 明文仅存 SQLite + 主进程内存；IPC 契约不变（DTO 只携掩码，明文只经显式 reveal）。涉及五层联动：schema/迁移 → shared 契约 → providers 仓储 → AI 层/IPC 胶水 → 渲染层。Tasks 1–5 是**同一原子变更**（跨层类型耦合，拆开无法全绿），在 Task 5 末尾一次提交；其后各任务独立提交。

**Tech Stack:** Drizzle ORM 1.0.0-rc.3 / better-sqlite3 / Zod 4 / vitest 4（`ELECTRON_RUN_AS_NODE` 跑 Electron 运行时）/ React 19。

**执行位置:** 主检出 `/Users/wangjiyuan/dev/marginalia`、`main` 分支直接提交（本会话既定惯例；开工前确认 `git status` 干净）。

---

### Task 1: Schema 改列 + 生成迁移

**Files:**

- Modify: `src/main/db/schema.ts:29`
- Create（由 db:generate 生成）: `src/main/db/migrations/<timestamp>_<name>/`

- [ ] **Step 1: 改 schema 列定义**

`src/main/db/schema.ts` 第 29 行：

```ts
// 旧
    apiKeyEncrypted: blob("api_key_encrypted", { mode: "buffer" }),
// 新（明文落库；安全立场见 docs/superpowers/specs/2026-06-04-plaintext-api-key-storage-design.md）
    apiKey: text("api_key"),
```

检查文件内是否还有其它 `blob(` 用法（`grep -n "blob(" src/main/db/schema.ts`）；若仅此一处，把首行 import 中的 `blob, ` 删掉（否则 oxlint 报未用导入）。

- [ ] **Step 2: 生成迁移**

Run: `pnpm db:generate`
Expected: `src/main/db/migrations/` 新增一个 `<timestamp>_<name>/` 子目录（含 `migration.sql` 与 `snapshot.json`）。**不要手工编辑生成物。**

- [ ] **Step 3: 审查迁移 SQL**

Run: `cat src/main/db/migrations/<新目录>/migration.sql`

两种可接受形态：

1. `ALTER TABLE \`providers\` DROP COLUMN \`api_key_encrypted\`;`+`ALTER TABLE \`providers\` ADD \`api_key\` text;`（理想，无表重建）。
2. 表重建（CREATE 新表 + INSERT SELECT + DROP + RENAME）——此时 DROP 会涉及 `assistants.provider_id` 外键；`runMigrations` 已有「事务外切 FK」修复兜底，**Task 9 的真实库冒烟必须执行**以验证。

若出现第 2 形态，仅记录在案，不改生成物。

（此时全仓编译/测试为红，属预期；**不提交**，继续 Task 2。）

---

### Task 2: shared 契约——`keyMask` 取代判别联合

**Files:**

- Modify: `src/shared/providers.ts:86-111`

- [ ] **Step 1: 删除 `ProviderKeyState`，改 `ProviderDto.key` 为 `keyMask`**

删除 `src/shared/providers.ts` 86–95 行整块：

```ts
/**
 * 密钥存在性的判别联合（仅这三态合法，非法组合不可表示）：
 *  - `none`：密文不存在。
 *  - `set`：密文存在且本机可解密，附掩码预览（如 "sk-…1234"）。
 *  - `undecryptable`：密文存在但本机无法解密（跨机器迁移 / safeStorage 不可用）。
 */
export type ProviderKeyState =
  | { status: "none" }
  | { status: "set"; mask: string }
  | { status: "undecryptable" };
```

`ProviderDto` 内（原 106 行）：

```ts
// 旧
key: ProviderKeyState;
// 新
/** null = 未配置；非 null = 已配置，值为掩码预览（如 "sk-…1234"）。绝不含明文。 */
keyMask: string | null;
```

ProviderDto 上方的接口注释「绝不含明文 / 密文，只含掩码预览」语义不变，保留。

---

### Task 3: providers 仓储重写（先改测试 → 红 → 改实现 → 绿）

**Files:**

- Modify: `src/main/providers/repository.test.ts`
- Modify: `src/main/providers/repository.ts`

- [ ] **Step 1: 改写测试到新契约**

`src/main/providers/repository.test.ts` 全文改动要点（完整代码如下，逐处替换）：

1. 删 import：`import type { Encryptor } from "@main/secrets/encryptor";`
2. 删三个 fake（`fakeEncryptor` / `unavailableEncryptor` / `brokenDecryptEncryptor`，31–52 行整块）；保留 `okTester`。
3. **所有** `upsertProvider(db, fakeEncryptor, {...})` → `upsertProvider(db, {...})`；`listProviders(db, fakeEncryptor)` → `listProviders(db)`；`revealProviderKey(db, fakeEncryptor, id)` → `revealProviderKey(db, id)`；`testProvider(db, fakeEncryptor, okTester, ...)` → `testProvider(db, okTester, ...)`（含 `spyTester`/`spy` 处）。
4. 首个用例改为：

```ts
it("creates a provider with a plaintext key and exposes only a masked preview", () => {
  const db = freshDb();
  const dto = upsertProvider(db, {
    type: "openai-responses",
    baseUrl: "https://api.openai.com/v1",
    apiKey: "sk-abcdefghij",
  });
  expect(dto.type).toBe("openai-responses");
  expect(dto.keyMask).toBe("sk-…ghij");
  const row = getProviderRow(db, dto.id);
  expect(row?.apiKey).toBe("sk-abcdefghij"); // 明文落库（spec 决策）
  // DTO 绝不暴露明文字段
  expect(dto).not.toHaveProperty("apiKey");
  expect(dto.createdAt).toBeGreaterThan(0);
});
```

5. `creates a provider without a key`：断言改 `expect(dto.keyMask).toBeNull();`
6. 新增短 key 掩码用例（紧随其后）：

```ts
it("masks short keys (≤8 chars) entirely", () => {
  const db = freshDb();
  const dto = upsertProvider(db, {
    type: "openai-responses",
    baseUrl: "https://api.openai.com/v1",
    apiKey: "sk-short", // 8 字符
  });
  expect(dto.keyMask).toBe("••••");
});
```

7. **整块删除**三个钥匙串环境用例：`refuses to store a key when secure storage is unavailable`（161–169 行）、`reports key status 'undecryptable' when decryption fails`（171–180 行）、testProvider 内 `returns ok:false when the key cannot be decrypted`（267–279 行）。
8. DeepSeek 直插用例（311–334 行）：`apiKeyEncrypted: fakeEncryptor.encrypt("sk-deepseek0001")` → `apiKey: "sk-deepseek0001"`。
9. `upsert sets models...` 用例：删 `const enc = fakeEncryptor;`，各 `upsertProvider(db, enc, ...)` → `upsertProvider(db, ...)`。
10. `builtin provider immutability` 描述块同步去 encryptor 参数；`listProviders(db, fakeEncryptor)` → `listProviders(db)`。

- [ ] **Step 2: 跑测试确认红**

Run: `pnpm test src/main/providers/repository.test.ts`
Expected: FAIL（旧实现签名不匹配——`input` 被当 `encryptor` 用，运行时报错）。

- [ ] **Step 3: 重写实现**

`src/main/providers/repository.ts` 改动（逐处替换）：

1. import 区：删 `import type { Encryptor } from "@main/secrets/encryptor";`；shared 导入删 `ProviderKeyState,`。
2. **删除** `keyState` 函数（18–28 行整块）。
3. `toDto` 改为（不再收 encryptor）：

```ts
/** Provider → DTO（明文仅在 main；DTO 只携掩码）。入参经工厂解析，故 baseUrl 已按 type 派生。 */
function toDto(provider: Provider): ProviderDto {
  return {
    id: provider.id,
    type: provider.type,
    compatibleApis: provider.compatibleApis ?? [provider.type],
    label: provider.label ?? null,
    baseUrl: provider.baseUrl, // 工厂已派生（DeepSeek 等内置不再是 db 里的 null）
    keyMask: provider.apiKey == null ? null : maskKey(provider.apiKey),
    models: provider.models ?? [],
    isBuiltin: provider.isBuiltin,
    createdAt: provider.createdAt,
  };
}
```

4. `listProviders(db: DB): ProviderDto[]`——签名去 encryptor，`.map((r) => toDto(createProvider(r)))`。
5. `upsertProvider(db: DB, input: UpsertProviderInput): ProviderDto`——签名去 encryptor；函数体开头的加密块：

```ts
// 旧（82–88 行）
let encrypted: Buffer | undefined;
if (input.apiKey !== undefined) {
  if (!encryptor.isAvailable()) {
    throw new Error(t("errors.secureStorageUnavailable", "无法存储密钥：系统安全存储不可用"));
  }
  encrypted = encryptor.encrypt(input.apiKey);
}
// 新：整块删除（apiKey 两态语义由下方落库点直接表达）
```

update 分支 `.set({...})` 内：`...(encrypted !== undefined ? { apiKeyEncrypted: encrypted } : {})` → `...(input.apiKey !== undefined ? { apiKey: input.apiKey } : {})`；
insert `.values({...})` 内：`apiKeyEncrypted: encrypted ?? null,` → `apiKey: input.apiKey ?? null,`；
两处 `return toDto(createProvider(row), encryptor)` / `toDto(createProvider(inserted), encryptor)` → 去掉第二参。
首注释「仅当传入新明文 key 时加密…」改为「apiKey 两态：省略=保留既有，提供=替换（明文直存，见 2026-06-04 spec）」。6. `revealProviderKey(db: DB, id: string): string`：

```ts
export function revealProviderKey(db: DB, id: string): string {
  const row = getProviderRow(db, id);
  if (!row)
    throw new Error(t("errors.providerNotFound", "未找到$t(terms.provider) {{id}}", { id }));
  if (row.apiKey == null)
    throw new Error(
      t("errors.providerHasNoApiKey", "$t(terms.provider) {{id}} 未配置密钥", { id }),
    );
  return row.apiKey;
}
```

7. `testProvider(db: DB, tester: ProviderTester, id: string, model: string)`：签名去 encryptor；`provider.apiKeyEncrypted == null` → `provider.apiKey == null`；删除 decrypt try-catch（196–202 行），直接 `tester.test({ type: provider.type, baseUrl: provider.baseUrl, apiKey: provider.apiKey, model })`。

- [ ] **Step 4: 跑测试确认绿**

Run: `pnpm test src/main/providers/repository.test.ts`
Expected: PASS（全部用例）。

（仍不提交——assistant-model/handlers/渲染层还红。）

---

### Task 4: AI 层与 IPC 胶水

**Files:**

- Modify: `src/main/ai/assistant-model.test.ts`
- Modify: `src/main/ai/assistant-model.ts`
- Modify: `src/main/ai/send-deps.ts`
- Modify: `src/main/ipc/settings-handlers.ts`

- [ ] **Step 1: 改写 assistant-model 测试**

`src/main/ai/assistant-model.test.ts`：

1. 删 import `Encryptor` 与三个 fake encryptor（20–36 行）。
2. `configure()` 内 `upsertProvider(db, fakeEncryptor, {...})` → `upsertProvider(db, {...})`；其余用例同理去 encryptor 参数；`resolveAssistantModel(db, fakeEncryptor)` → `resolveAssistantModel(db)`。
3. **整块删除**两个用例：`fails when the stored key cannot be decrypted on this machine`（90–95 行）、`fails when secure storage is unavailable`（97–102 行）。

- [ ] **Step 2: 跑测试确认红**

Run: `pnpm test src/main/ai/assistant-model.test.ts`
Expected: FAIL。

- [ ] **Step 3: 改实现**

`src/main/ai/assistant-model.ts`：删 `Encryptor` import；`resolveAssistantModel(db: DB): ResolvedModel`；27–45 行的密钥块改为：

```ts
if (!provider.apiKey)
  return { ok: false, reason: t("errors.assistantNoApiKey", "$t(terms.provider)未设置密钥") };
```

（`isAvailable` 检查、decrypt try-catch、`apiKey` 局部变量全删；下方 `resolveLanguageModel({...})` 的 `apiKey,` 改为 `apiKey: provider.apiKey,`。）

`src/main/ai/send-deps.ts`：删第 3 行 `safeStorageEncryptor` import；两处 `resolveAssistantModel(db, safeStorageEncryptor)` → `resolveAssistantModel(db)`。

`src/main/ipc/settings-handlers.ts`：删第 14 行 `safeStorageEncryptor` import；五处调用去 encryptor 参数：

```ts
(bind(C.providersList, () => listProviders(getDb())),
  bind(C.providersUpsert, (input) => upsertProvider(getDb(), input)),
  bind(C.providersReveal, (input) => ({ apiKey: revealProviderKey(getDb(), input.id) })),
  bind(C.providersTest, (input) => testProvider(getDb(), aiSdkTester, input.id, input.model)),
  // providersListModels 内：
  (apiKey = input.apiKey ?? revealProviderKey(getDb(), input.id ?? "")));
```

- [ ] **Step 4: 跑主进程全量测试确认绿**

Run: `pnpm test`
Expected: PASS（渲染层不在 vitest 范围；typecheck 仍红，Task 5 后转绿）。

---

### Task 5: 渲染层适配 + 核心提交

**Files:**

- Modify: `src/renderer/settings/ProviderCard.tsx:40-45`
- Modify: `src/renderer/settings/ProviderForm.tsx:46,117-123`

- [ ] **Step 1: ProviderCard**

```tsx
// 旧（40–45 行）
function keyText(p: ProviderDto): string {
  if (p.key.status === "set") return p.key.mask;
  if (p.key.status === "undecryptable")
    return t("settings.provider.keyUndecryptable", "本机无法解密");
  return t("settings.provider.keyNotSet", "未配置");
}
// 新
function keyText(p: ProviderDto): string {
  return p.keyMask ?? t("settings.provider.keyNotSet", "未配置");
}
```

- [ ] **Step 2: ProviderForm**

第 46 行：

```tsx
const [editingKey, setEditingKey] = useState(provider == null || provider.keyMask === null);
```

117–123 行：

```tsx
        {!editingKey && provider && provider.keyMask !== null ? (
          <div className="flex items-center gap-2">
            <span className="flex-1 truncate font-mono text-sm text-muted-foreground">
              {provider.keyMask}
            </span>
```

（`<Button …编辑…>` 及其后结构不动。）

- [ ] **Step 3: 全量验证**

Run: `pnpm test && pnpm typecheck && pnpm lint`
Expected: 三者全绿。

- [ ] **Step 4: 核心提交**

```bash
git add -A
git commit -m "refactor(providers)!: store API keys as plaintext for backup recovery

按 2026-06-04 spec：api_key_encrypted(BLOB) → api_key(TEXT)；
ProviderKeyState 判别联合降为 keyMask: string | null；
展示/存取全程不再触碰 OS 钥匙串；旧密文不迁移（重输一次）。

Co-Authored-By: Claude Opus 4.8 (1M context) <noreply@anthropic.com>"
```

（prek 若因 lint:fix/format 修改文件而中止：`git add -A` 后原命令重跑一次。）

---

### Task 6: 退役 Encryptor 抽象

**Files:**

- Delete: `src/main/secrets/encryptor.ts`
- Delete: `src/main/secrets/safe-storage-encryptor.ts`

- [ ] **Step 1: 确认零引用**

Run: `grep -rn "encryptor\|Encryptor" src/ --include="*.ts" --include="*.tsx"`
Expected: 仅剩 `src/main/secrets/encryptor.ts` 与 `safe-storage-encryptor.ts` 自身（无任何外部 import）。若有残留引用，回上一任务补漏。

- [ ] **Step 2: 删除 + 验证 + 提交**

```bash
git rm src/main/secrets/encryptor.ts src/main/secrets/safe-storage-encryptor.ts
pnpm test && pnpm typecheck && pnpm lint
git commit -m "refactor(secrets): retire Encryptor abstraction (safeStorage no longer used)

Co-Authored-By: Claude Opus 4.8 (1M context) <noreply@anthropic.com>"
```

Expected: 测试/typecheck/lint 全绿后提交通过。（`secrets/tester.ts`、`secrets/ai-sdk-tester.ts` 与加密无关，保留。）

---

### Task 7: i18n 键清理

**Files:**

- Modify: `src/shared/i18n/locales/zh-CN.ts:53-54,61-62,158`
- Modify: `src/shared/i18n/locales/en.ts:56-57,64-65,167`

- [ ] **Step 1: extract 同步（先于 typecheck，操作规约）**

Run: `pnpm i18n:extract`
Expected: 两 locale 文件中以下 5 键被移除（extract 按代码实际 `t()` 调用同步）：
`errors.keyUndecryptable`、`errors.keyUndecryptableMachine`、`errors.secureStorageUnavailable`、`errors.secureStorageUnavailableMachine`、`settings.provider.keyUndecryptable`。
**注意**：`errors.noApiKeyAvailable`、`errors.assistantNoApiKey`、`errors.providerHasNoApiKey`、`errors.noApiKeySet`、`settings.provider.keyNotSet` 仍在使用，必须保留。

- [ ] **Step 2: grep 复核（i18n:lint 有漏报前科，不可只信它）**

Run: `grep -rn "keyUndecryptable\|secureStorageUnavailable" src/`
Expected: 零匹配。再 `git diff --stat` 确认仅两 locale 文件变动且无误删（若 extract 误清了仍在用的键，恢复后手工只删上述 5 键）。

- [ ] **Step 3: 验证 + 提交**

```bash
pnpm i18n:lint && pnpm test && pnpm typecheck
git add src/shared/i18n/locales
git commit -m "chore(i18n): drop unreachable keychain error keys

Co-Authored-By: Claude Opus 4.8 (1M context) <noreply@anthropic.com>"
```

---

### Task 8: 真实库迁移冒烟（drizzle 表重建 FK 坑防线）

**Files:** 无代码改动；只读验证。

- [ ] **Step 1: 拷贝真实 dev 库并应用新迁移**

```bash
cp "$HOME/Library/Application Support/marginalia-dev/marginalia.db" /tmp/mig-smoke.db
# 模拟 runMigrations 的事务外 FK 关闭语境（client.ts 的既有修复）
sqlite3 /tmp/mig-smoke.db "PRAGMA foreign_keys=OFF;" ".read src/main/db/migrations/<Task1 新目录>/migration.sql"
```

Expected: 无报错输出。

- [ ] **Step 2: 校验结构与数据完好**

```bash
sqlite3 /tmp/mig-smoke.db "PRAGMA foreign_key_check;"          # 期望：空输出
sqlite3 /tmp/mig-smoke.db "PRAGMA table_info(providers);"      # 期望：有 api_key、无 api_key_encrypted
sqlite3 /tmp/mig-smoke.db "SELECT type,label,(api_key IS NULL) FROM providers;"  # 期望：4 行、api_key 全 NULL（旧密文丢弃属预期）
sqlite3 /tmp/mig-smoke.db "SELECT count(*) FROM books; SELECT count(*) FROM chapters;"  # 期望：1 / 86（数据未伤）
rm /tmp/mig-smoke.db
```

若 Step 1/2 失败（多半是表重建撞 FK）：**停**，回报失败 SQL 与错误原文，勿自行改迁移生成物（根因多在 `runMigrations` FK 时序，见 drizzle FK 坑记录）。

---

### Task 9: ROADMAP 更新 + 收尾提交

**Files:**

- Modify: `docs/superpowers/ROADMAP.md`

- [ ] **Step 1: 更新 ROADMAP**

按 ROADMAP 现有体例：① 在已完成处记一笔「API key 明文落库（备份可恢复，2026-06-04 spec）」；② backlog 增「打包产物 ad-hoc 签名无效（Forge+Fuses 签名顺序，`codesign --verify` 报 invalid Info.plist）——分发/公证前必修」。

- [ ] **Step 2: 提交**

```bash
git add docs/superpowers/ROADMAP.md
git commit -m "docs(roadmap): plaintext api key landed; track broken package signature

Co-Authored-By: Claude Opus 4.8 (1M context) <noreply@anthropic.com>"
```

---

## 验收清单（对照 spec）

- [ ] §3.1 schema：`api_key` TEXT 列 + 迁移生成物（Task 1）
- [ ] §3.2 仓储：upsert 直存明文、keyState 蒸发、reveal/test 直读（Task 3）
- [ ] §3.2 AI 层：resolveAssistantModel 无 encryptor（Task 4）
- [ ] §3.3 契约：`keyMask: string | null`，`ProviderKeyState` 删除（Task 2）
- [ ] §3.4 渲染层：两文件适配、undecryptable 分支清除（Task 5）
- [ ] §3.5 Encryptor 退役：两文件删除、tester 保留（Task 6）
- [ ] §3.6 i18n：5 键移除、保留键无误删（Task 7）
- [ ] §3.7+§4 错误模型与测试：环境性失败用例删除、新增短 key 掩码与 DTO 边界断言（Tasks 3–4）
- [ ] §5 升级体验：真实库迁移冒烟通过（Task 8）；ROADMAP 记录（Task 9）
