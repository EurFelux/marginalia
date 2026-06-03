# RA5：多 Provider + baseUrl + 双栏设置 设计

> 状态：已确认（2026-06-03）。RA5「Provider / 设置 UI」收尾——把硬编码单一 anthropic 的 modal 设置，
> 改造成「应用内双栏设置面 + 多 provider 管理（含每 provider 多模型、从端点拉取）」。

## 1. 目标与非目标

**目标**

- 应用内**双栏**设置面（左栏分类 / 右栏详情），取代当前的居中 modal。
- 管理**多个 provider**（4 种 type：OpenAI Responses / OpenAI Chat Completions / Anthropic / Google Gemini），每个可配 `label` / `baseUrl` / `apiKey`。
- 每个 provider 关联**多个 model 名**（文本，存 `providers.models` JSON 列）；可**手输**或**从 provider 的 /models 端点拉取后勾选添加**。
- baseUrl 用各 type 默认端点作 **placeholder**（留空即用 SDK 自带默认）。
- 「对话模型」选择：provider 下拉 + model 下拉（取自该 provider 的 models）+ 测试连接 → 写 `assistant`。
- 把**颜色模式**、**自动摘要**迁入新设置面（外观 / 阅读 分类）。
- **初始态预置**默认 provider（OpenAI / Anthropic / Gemini，预填常用型号、空 key），定义单独存放（见 §3.4）。

**非目标（不做 / 记 backlog）**

- 不建 `models` / `provider_model` 表，不引 `modelId` 外键——model 保持纯文本，`assistants.model` **不变**。
- 不动**模型解析层** `resolveAssistantModel`（仍用 provider + `assistants.model` 文本）与 `model-factory` 生成路径。
- 不做真·独立 OS 窗口（用应用内全窗覆盖视图）。
- 不做 per-provider 代理覆盖 / PAC（已有 backlog 行）。
- model 下拉不做自由 combobox（自定义 model 名在 provider 的模型编辑器里加；assistant 选择器只从该 provider 的 models 选，并兼容显示当前已存值）。

## 2. 现状（已完备，本次不动）

主进程后端**已支持多 provider + baseUrl + 加密 key**：

- `resolveLanguageModel`（`src/main/ai/model-factory.ts`）四 type + baseUrl 全通；`assistant-model.ts` 的 `resolveAssistantModel` 用 provider + `assistants.model` 文本解析；注入 `net.fetch`（系统代理）。
- 仓储 `src/main/providers/repository.ts`：`listProviders` / `upsertProvider`（label/baseUrl/apiKey 省略=保留、null=清空）/ `removeProvider`（先解 assistant FK）/ `revealProviderKey` / `testProvider`。
- IPC（`src/main/ipc/settings-handlers.ts`）：`providersList/Upsert/Reveal/Test/Remove` + `assistantGetDefault/Update`，均经 `@shared/providers` / `@shared/assistant` 的 Zod 契约。
- `ProviderDto`（`@shared/providers.ts`）已含 `type` / `label` / `baseUrl` / `key`（判别联合）。

**缺口**＝本 spec 范围：①每 provider 的 model 名列表（数据 + UI）；②从端点拉模型（新能力）；③双栏设置 UI（取代硬编码 anthropic modal）。

## 3. 数据模型

### 3.1 schema：`providers.models` JSON 列

`src/main/db/schema.ts` 的 `providers` 表加一列（仿 `books.toc` 的 JSON 列写法）：

```ts
models: text("models", { mode: "json" }).$type<string[]>(),
```

- 可空；**null/缺失在边界处一律视作 `[]`**（`toDto` 用 `row.models ?? []`）。
- 迁移：`pnpm db:generate` 产出加列迁移（additive `ALTER ... ADD COLUMN models text`）；既有行得 NULL，读取即合并为 `[]`。
- `assistants.model`（text）**不变**；无 FK、无 `modelId`。

### 3.2 shared 元数据单一源（`src/shared/providers.ts`）

```ts
/** 各 type 的官方默认端点：UI baseUrl 占位符 + 拉模型兜底共用（不注入生成路径——那交 SDK 自带默认）。 */
export const DEFAULT_BASE_URL: Record<ProviderType, string | null> = {
  openai: "https://api.openai.com/v1",
  anthropic: "https://api.anthropic.com",
  google: "https://generativelanguage.googleapis.com/v1beta",
  "openai-compatible": null, // 无默认，必填
};

/** provider type 的 UI 显示名（枚举值不变；按其讲的 API 命名更清楚）。 */
export const PROVIDER_TYPE_LABEL: Record<ProviderType, string> = {
  openai: "OpenAI Responses",
  "openai-compatible": "OpenAI Chat Completions",
  anthropic: "Anthropic",
  google: "Google Gemini",
};
```

### 3.3 契约扩展（`src/shared/providers.ts`）

- `ProviderDto` 加 `models: string[]`。
- `upsertProviderInput` 加 `models: z.array(z.string().min(1)).optional()`（**省略=保留既有，提供数组=整体替换**；`[]` 即清空。与 label/baseUrl 的「省略=保留」一致，但 models 无「null 清空」语义——空数组即清空）。
- **拉模型入参 / 结果**：

```ts
/** 列 provider 可用模型：key 解析 = 表单现填 apiKey ?? 由 id 解密的存储 key（兼顾新建未存 / 编辑未重填 key）。 */
export const listModelsInput = z.object({
  type: providerType,
  baseUrl: z.string().min(1).nullish(),
  apiKey: z.string().min(1).optional(),
  id: z.string().min(1).optional(),
});
export type ListModelsInput = z.infer<typeof listModelsInput>;

export const listModelsResult = z.discriminatedUnion("ok", [
  z.object({ ok: z.literal(true), models: z.array(z.string()) }),
  z.object({ ok: z.literal(false), status: z.number().int().optional(), message: z.string() }),
]);
export type ListModelsResult = z.infer<typeof listModelsResult>;
```

### 3.4 默认 provider 播种（初始/空态）

默认 provider 的配置定义**单独存放**于 `src/main/providers/default-providers.ts`（seed 单一源，不内联进 seeding 逻辑）：

```ts
/** 初始态预置的默认 provider（不含 openai-compatible——那个由用户手动加）。models 为预填的常用起始型号，
 *  baseUrl 留 null（用各 type 默认端点）；无 apiKey（用户后填）。型号可后续被用户编辑/拉取覆盖。 */
export const DEFAULT_PROVIDERS: { type: ProviderType; label: string; models: string[] }[] = [
  { type: "openai", label: "OpenAI", models: ["gpt-4o", "gpt-4o-mini"] },
  {
    type: "anthropic",
    label: "Anthropic",
    models: ["claude-3-5-sonnet-latest", "claude-3-5-haiku-latest"],
  },
  { type: "google", label: "Gemini", models: ["gemini-1.5-flash", "gemini-1.5-pro"] },
];
```

播种纯函数 `seedDefaultProviders(db)`（同模块或仓储，可 `:memory:` 测）：

- **空列表就播种**：启动时若 `providers` 表为空 → 依次插入 `DEFAULT_PROVIDERS`（type/label/models，`baseUrl=null`、`apiKeyEncrypted=null`）；非空则 no-op。无播种状态位。
- 语义：现有用户（表非空，如开发库已有 anthropic）不受影响、不重复播；用户删光全部 provider 后下次启动会重现三默认（“初始态总有默认可用”，可接受）。
- 调用点：`initDb()` 在 `runMigrations` 之后调一次 `seedDefaultProviders(getDb())`（glue 层；纯函数本身无 Electron 依赖、headless 可测）。

## 4. 后端变更

### 4.1 仓储（`src/main/providers/repository.ts`）

- `toDto`：加 `models: row.models ?? []`。
- `upsertProvider`：update 与 insert 分支按 `input.models !== undefined ? { models: input.models } : {}`（省略=保留；insert 时 `?? []`）。

### 4.2 从端点拉模型（新模块 `src/main/providers/provider-models.ts`）

纯逻辑、`fetch` 显式注入（可测）：

```ts
export interface FetchModelsParams {
  type: ProviderType;
  baseUrl: string | null;
  apiKey: string;
}

/** 调 provider 的 /models 端点，返回 model id 列表。失败抛错（含 status / 真实 message），由调用方映射为 ListModelsResult。 */
export async function fetchProviderModels(
  p: FetchModelsParams,
  fetchImpl: typeof fetch,
): Promise<string[]>;
```

**三家响应结构不同，需显式归一**——`fetchProviderModels` 内拆**两个按 type 的纯步骤**（各自单测）：

1. `buildModelsRequest(type, base, apiKey) → { url, headers }`（base = `p.baseUrl ?? DEFAULT_BASE_URL[type]`；openai-compatible 无默认 → base 必须有，否则抛「baseUrl required」）。
2. `adaptModelsResponse(type, json) → string[]`——先用**按 type 的 Zod schema 校验**外部响应（API 边界、不可信输入），再归一为 model id 列表。

| type                       | 请求构造（buildModelsRequest）                                             | 响应形状 → 归一（adaptModelsResponse）                                                                                                    |
| -------------------------- | -------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------- |
| openai / openai-compatible | `GET {base}/models`，`Authorization: Bearer {key}`                         | `{ object:"list", data:[{ id, object:"model", … }] }` → `data.map(m => m.id)`                                                             |
| anthropic                  | `GET {base}/v1/models`，`x-api-key:{key}` + `anthropic-version:2023-06-01` | `{ data:[{ type:"model", id, display_name, … }], has_more, … }` → `data.map(m => m.id)`（仅取首页，不翻页）                               |
| google                     | `GET {base}/models?key={key}`                                              | `{ models:[{ name:"models/xxx", supportedGenerationMethods:[…], … }] }` → 过滤含 `generateContent` 的、再 `name.replace(/^models\//, "")` |

- **Zod 边界校验**（schema 放 `provider-models.ts`，属外部 API 形状、非 IPC 契约，不入 `@shared`）：
  - **openai / anthropic / google（严格）**：按已知形状校验顶层（如 `z.object({ data: z.array(z.object({ id: z.string() })) })` / google `z.object({ models: z.array(z.object({ name: z.string(), supportedGenerationMethods: z.array(z.string()).optional() })) })`）；`parse` 失败即抛**结构性错误**（透传给用户，**不静默返空当成功**）。
  - **openai-compatible（放宽 / best-effort）**：网关响应形状不定——用宽松 schema（item `.passthrough()`、字段 optional）+ 逐项 `safeParse` **跳过不合规项**；`data` 缺失/非数组则返 `[]`。能捞多少捞多少，**不硬失败**。
- `adaptModelsResponse` 各 type 喂真实形状 canned JSON 单测（google 前缀剥离 + generateContent 过滤、anthropic/openai `data[].id`、严格 type 的非法响应→抛、openai-compatible 的部分合规→捞出合规子集）。
- 错误映射（**遵从「绝不编造原因」记忆**）：HTTP 非 2xx → 尽力从响应体 JSON 提 `error.message` / `message`（透传真实文案）；提不到则退 HTTP 状态码标准语义（标「可能方向」，复用 ai-sdk-tester 同款 `HTTP_HINT`）；网络/解析异常 → 透传原始异常文案。映射逻辑放一个小函数 `mapModelsError(err|response, body)`，与 `ai-sdk-tester` 的原则一致（如有重复的 HTTP_HINT/JSON 提取，抽到 `src/main/secrets/provider-error.ts` 共用；否则各自最小实现）。

### 4.3 IPC（`src/main/ipc/settings-handlers.ts`）

- 新通道 `IPC.providersListModels = "providers:list-models"`。
- handler：`handle<ListModelsInput, ListModelsResult>(...)`——key = `input.apiKey ?? revealProviderKey(getDb(), enc, input.id!)`（两者皆无→`{ok:false, message:"No API key"}`）；调 `fetchProviderModels({type,baseUrl,apiKey}, net.fetch)`（glue 层直接传 Electron `net.fetch`，代理感知；headless 测试直接测 `fetchProviderModels` 喂 mock fetch）；try/catch 映射为 `ListModelsResult`。
- preload + `window.api.settings.providers.listModels` 暴露。

## 5. 渲染层：双栏设置面（`src/renderer/settings/`）

### 5.1 外壳

- 现 `SettingsPanel`（居中 Dialog）→ 改为**全窗覆盖**双栏面（仍由 `settings-store.open` 控制；reader/library 保持挂载在底层，**关闭不重载书**）。✕ / Esc 关闭。
- `settings-store` 加 `activeCategory: "models" | "appearance" | "reading"`（默认 `"models"`）+ setter；保留 `open/setOpen/testResult`。
- 布局：左栏垂直分类导航（模型 / 外观 / 阅读，active 高亮，Tailwind 工具类）；右栏渲染选中分类。拆分文件：`SettingsShell.tsx`（壳+左栏）、`ModelsSettings.tsx`、`AppearanceSettings.tsx`、`ReadingSettings.tsx`、`ProviderCard.tsx`、`ProviderForm.tsx`、`ModelEditor.tsx`、`AssistantModelPicker.tsx`（各文件单一职责）。

### 5.2 「模型」分类（`ModelsSettings.tsx`）

- **对话模型**（`AssistantModelPicker`）：provider 下拉（选项文案 `PROVIDER_TYPE_LABEL[type] · label`）+ model 下拉（选项 = 该 provider 的 `models`；若 `assistant.model` 不在其中，附加为「(当前) {model}」选项保证可显示）+ 测试连接（`providers.test({id, model})`）→ `assistant.update({providerId, model})`。
- **Providers 列表**：`ProviderCard` ×N——type 徽标（`PROVIDER_TYPE_LABEL`）+ label + baseUrl（有才显）+ 密钥掩码/状态（`key.status`：set 显 mask、undecryptable 显「本机无法解密」、none 显「未配置」）+「· N 个模型」；操作 编辑 / 测试 / 移除。「+ 添加 provider」内联展开 `ProviderForm`。
- **`ProviderForm`**（添加/编辑内联）：
  - 类型 `Select`（4 项，文案走 `PROVIDER_TYPE_LABEL`）。
  - 名称（可选）。
  - baseURL：`placeholder = DEFAULT_BASE_URL[type] ?? "https://你的网关/v1（必填）"`；留空存 null；openai-compatible 留空时阻止保存并提示必填。
  - API Key：有 key 时掩码 + 👁 reveal（`providers.reveal`）+「编辑」换新；新建为密码输入。
  - **`ModelEditor`**：已选 model 列表（每项 ✕ 移除）+「+ 手动添加模型名」输入 +「⤓ 拉取模型」（调 `providers.listModels`，用表单当前 type/baseUrl/apiKey 或 id；返回后渲染勾选列表，「添加所选」并入、去重）；失败显真实 message 并退手输。
  - 保存 → `providers.upsert`（含 models）；取消收起。

### 5.3 「外观」（`AppearanceSettings.tsx`）

- 颜色模式 ToggleGroup（light/system/dark）从旧 modal 迁来（复用 `useThemeStore`）。

### 5.4 「阅读」（`ReadingSettings.tsx`）

- 「开章自动生成本章摘要」开关从旧 modal 迁来（复用 `usePrefsStore`）。

### 5.5 新增 shadcn 原语

- `pnpx shadcn@latest add select -y`（Base UI Select；type 下拉 + provider 下拉 + model 下拉用）。装后 `postinstall` 自动 `db:rebuild:electron`；读生成文件确认 API（Base UI Select 的 value/onValueChange 形态），据实接线。

## 6. 错误处理

- 拉模型 / 测试连接：透传 provider 真实 message，提取不到才退 HTTP 语义并标「可能方向」，**绝不编造**（沿用 `honest-error-no-fabrication` 记忆与 ai-sdk-tester 既有模式）。
- key 不可解密（`undecryptable`）：UI 明示「本机无法解密」，编辑时要求重输 key。
- openai-compatible 缺 baseUrl：表单校验拦截（与既有 `upsertProviderInput` 的 refine 一致）。

## 7. 测试

- `src/shared/providers.test.ts`：`upsertProviderInput.models` 校验（数组/省略）；`listModelsInput`/`listModelsResult` 校验；`DEFAULT_BASE_URL` 与 `PROVIDER_TYPE_LABEL` 覆盖全部 4 个 type（无遗漏）。
- `src/main/providers/repository.test.ts`：upsert models（省略=保留、提供=替换、`[]`=清空）；`toDto` null→`[]`；往返。
- `seedDefaultProviders`（`:memory:`）：空表→播 3 个（type/label/models 正确、无 key、baseUrl null）；非空表→no-op（不重复、不动既有）。
- `src/main/providers/provider-models.test.ts`：`buildModelsRequest` 四 type 的 URL/header 构造（含 openai-compatible 缺 baseUrl→抛、base 默认值）；`adaptModelsResponse` 三家真实形状 canned JSON 归一（openai/anthropic `data[].id`、google 去 `models/` 前缀 + `generateContent` 过滤）+ **Zod 边界校验**（严格 type 非法响应→抛结构性错误；openai-compatible 部分合规→捞合规子集、`data` 缺失→`[]`）；`fetchProviderModels` 端到端（mock fetch）+ 错误映射（非 2xx 带 `error.message`→透传；网络 throw→透传；未知→HTTP 语义）。
- 渲染层双栏交互 / CRUD / 拉取勾选 / 对话模型选择：**人工 GUI smoke**（含「切设置不重载当前书」「拉取→勾选→保存→对话模型下拉出现新 model」「测试连接真实报错」）。

## 8. 涉及文件清单

**新增**

- `src/main/providers/provider-models.ts`（+ test）
- `src/main/providers/default-providers.ts`（`DEFAULT_PROVIDERS` + `seedDefaultProviders`，+ test）
- `src/renderer/settings/SettingsShell.tsx` / `ModelsSettings.tsx` / `AppearanceSettings.tsx` / `ReadingSettings.tsx` / `ProviderCard.tsx` / `ProviderForm.tsx` / `ModelEditor.tsx` / `AssistantModelPicker.tsx`
- `src/renderer/components/ui/select.tsx`（shadcn 生成）
- （可选）`src/main/secrets/provider-error.ts`（若抽公共 HTTP_HINT/JSON 提取）

**修改**

- `src/main/db/schema.ts`（providers.models 列）+ `pnpm db:generate` 迁移产物
- `src/shared/providers.ts`（models / DEFAULT_BASE_URL / PROVIDER_TYPE_LABEL / listModelsInput / listModelsResult）+ `providers.test.ts`
- `src/shared/ipc.ts`（`providersListModels` 通道）
- `src/main/providers/repository.ts`（toDto/upsert 加 models）+ `repository.test.ts`
- `src/main/ipc/settings-handlers.ts`（list-models handler）
- `src/main/db/instance.ts`（`initDb` 在 `runMigrations` 后调 `seedDefaultProviders`）
- `src/preload.ts`（`settings.providers.listModels`）
- `src/renderer/settings/SettingsPanel.tsx`（拆解/替换为 SettingsShell；旧 modal 移除）
- `src/renderer/store/settings-store.ts`（activeCategory）
- 旧 modal 里颜色模式 / 自动摘要的位置 → 迁至 Appearance/Reading（原 SettingsPanel 相应段移除）
- `docs/superpowers/ROADMAP.md`（合并时 RA5 → ✅；baseUrl backlog 行标完成）

## 9. 范围说明

中等偏大但单一内聚（provider/模型管理 + 设置 UI 重构）。后端增量小（一列 + 一个拉模型模块 + 一个 IPC）；主体在渲染层双栏 UI。模型解析/生成路径零改动。
