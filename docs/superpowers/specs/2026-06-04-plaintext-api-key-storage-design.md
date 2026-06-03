# API key 明文落库（可备份恢复）· 设计文档

> 状态：已确认（用户 2026-06-04 拍板「接受明文」；`keyMask: string | null` 扁平化亦经用户提议确认）。

## 1. 背景与动机

API key 此前经 Electron `safeStorage`（OS 钥匙串）加密存于 `providers.api_key_encrypted`（BLOB）。实践中暴露出一串结构性问题：

1. **跨身份解不开**：safeStorage 的加密密钥按「应用代码签名身份」隔离。dev 跑 Electron 官方二进制、打包产物是 ad-hoc 自签——一方加密的密文另一方解不开（UI 显示「本机无法解密」）。
2. **坏签名连存都存不进**：本地打包产物签名无效（Forge+Fuses 签名顺序缺陷，`codesign --verify` 报 `invalid Info.plist`）时，macOS 拒绝钥匙串访问，`isEncryptionAvailable()` 返回 false，保存密钥直接报「系统安全存储不可用」。
3. **展示越界解密**：`keyState()` 为生成掩码预览对每条 provider 调 `decrypt()`，打开「设置 → 模型」即全量解密 → 触发钥匙串授权弹框，体验恶劣且观感可疑（app 一上来就要钥匙串密码）。
4. **备份不可恢复（决定性矛盾）**：safeStorage 的密钥存在钥匙串、不随 DB 走——**单靠 DB 备份永远无法恢复 key**。而「key 必须能从备份恢复」是用户硬约束（呼应 ROADMAP 数据备份与恢复项）。

第 4 条与 safeStorage 根本矛盾，故弃用钥匙串，**API key 改为明文落库**。

## 2. 决策与威胁模型

| 方案                          | 备份可恢复       | 摩擦             | 落库加密     | 结论                           |
| ----------------------------- | ---------------- | ---------------- | ------------ | ------------------------------ |
| safeStorage（现状）+ 内存缓存 | ❌ 不可恢复      | 生产签名后低     | ✅           | 与硬约束矛盾，出局             |
| 主密码派生密钥加密            | ✅（需记主密码） | 每次启动输主密码 | ✅           | 摩擦换了个地方，违背低摩擦取向 |
| 轻量混淆                      | ✅               | 零               | ❌（伪安全） | 密钥随密文走＝自欺，不做       |
| **明文存 DB（选定）**         | ✅ 直接恢复      | 零               | ❌           | **接受**                       |

**明确接受的代价**（决策记录）：DB 文件 / 备份一旦外泄（Time Machine、iCloud、误拷 userData、可读文件的恶意程序），API key 直接暴露。以你身份运行的活跃恶意程序在 safeStorage 方案下同样能读（登录态钥匙串已解锁），此项两方案无差。

**不放宽的边界**：明文仅存在于 SQLite 文件与主进程内存。IPC/渲染层契约不变——DTO 只携掩码，明文出主进程仅 `reveal` 显式一条路。

## 3. 设计

### 3.1 Schema 与迁移

- `providers`：删 `api_key_encrypted`（BLOB）→ 加 `api_key`（TEXT，可空）。改 `schema.ts` 后 `pnpm db:generate`。
- **旧密文不迁移**：本就普遍解不开（§1.1），且实际受影响用户≈开发者本人。迁移后既有 provider 的 key 为空，重输一次。
- ⚠️ 实现时核对生成的迁移 SQL：若 drizzle 走表重建而非 `ALTER TABLE … DROP COLUMN`，DROP 会撞 `assistants.providerId` 外键——`runMigrations` 事务外切 FK 的既有修复应能兜住，按例验证既有库升级。

### 3.2 主进程纯函数层（`providers/repository.ts`）

- `upsertProvider`：`input.apiKey` 直接落 `api_key` 列。删 `encryptor.isAvailable()` 检查与 `encrypt()`——「无法存储密钥：系统安全存储不可用」错误路径从此不可达。apiKey 两态语义不变（省略=保留，提供=替换）。
- `keyState()` 函数删除，`toDto` 内一行推导：`keyMask: row.apiKey == null ? null : maskKey(row.apiKey)`。
- `revealProviderKey` / `testProvider`：直接读 `api_key`；decrypt try-catch 与「本机无法解密」分支删除。
- `ai/assistant-model.ts`（`resolveAssistantModel`）：同上，直接取明文；`secureStorageUnavailableMachine` / `keyUndecryptableMachine` 失败原因删除。

### 3.3 共享契约（`shared/providers.ts`）

```ts
/** null = 未配置；非 null = 已配置，值为掩码预览（如 "sk-…1234"）。绝不含明文。 */
keyMask: string | null;
```

- `ProviderKeyState` 判别联合**整体删除**，`ProviderDto.key` → `ProviderDto.keyMask`。
- **沿革注记**：该联合系 [2026-06-03 类型设计债清理](2026-06-03-type-design-debt-cleanup-design.md) item 1 从三布尔收紧而来——当时三态（`none`/`set`/`undecryptable`），联合是对的。本次 `undecryptable` 随解密消亡，状态空间塌缩为两态且 set ⇔ mask 必有（明文在手、`maskKey` 必算得出），`string | null` 与联合信息量等价、非法状态同样不可表示（Zod `min(1)` 拒空串 key；`maskKey` 永不返回空串），判别字段沦为包装税，故降回扁平。

### 3.4 渲染层

`ProviderCard.tsx` / `ProviderForm.tsx`：`key.status === "set"` → `keyMask !== null`；`undecryptable` 分支删除（含「本机无法解密」文案）。

### 3.5 Encryptor 抽象退役

- 删 `secrets/encryptor.ts`、`secrets/safe-storage-encryptor.ts` 及测试 fake encryptor。
- `ipc/settings-handlers.ts`、`ai/send-deps.ts` 等注入点去掉 encryptor 参数。
- `secrets/tester.ts`（连接测试器）与加密无关，**保留**。

### 3.6 i18n 清理

删除不再可达的键：`errors.secureStorageUnavailable`、`errors.secureStorageUnavailableMachine`、`errors.keyUndecryptable`、`errors.keyUndecryptableMachine`、`settings.provider.keyUndecryptable`。按操作规约：`i18n:extract` 先于 `typecheck`；删键后以 grep 复核残留引用（`i18n:lint` 有漏报前科）。

### 3.7 错误模型收敛

密钥的环境性失败（钥匙串不可用 / 解不开）整类消失。`testProvider` / 发消息余下的失败均为真实网络 / 鉴权错误，照旧透传 provider 原文（错误信息不编造）。

## 4. 测试策略（TDD，纯函数 + `:memory:` DB）

- `upsertProvider`：存明文；省略 `apiKey` 保留旧值；新建无 key 为 null。
- `keyMask` 推导：null → null；短 key（≤8）→ `"••••"`；长 key → `"sk-…1234"` 形态。
- `revealProviderKey`：返回明文；无 key 抛 `providerHasNoApiKey`。
- `testProvider`：明文透传给 tester；无 key 返回 `noApiKeySet`。
- DTO 边界：`ProviderDto` 含 `keyMask` 不含 `apiKey`（锁 IPC 只传掩码）。
- `resolveAssistantModel`：直接以明文解析模型。

## 5. 影响与范围外

- **打包产物坏签名**（Forge+Fuses 签名顺序）：钥匙串退出存储路径后不再阻塞任何用户流程，降级为 backlog，分发/公证前修。
- **dev/prod 数据目录隔离**（7644b5c）：分库价值不变；其钥匙串命名空间收益自然作废，无害。
- **备份/恢复 roadmap**：key 随 DB 走，该项零额外工作。
- **升级体验**：迁移后既有 provider 需重输 key 一次（dev 与打包产物各一次）。
