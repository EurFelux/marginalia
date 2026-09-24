# Assistant 头像设计（issue #82）

日期：2026-06-15
状态：设计中
关联：#82（Add assistant avatar shown in conversation (toggleable)）；衍生 cover 迁移 issue #83（见 §8）

## §0 背景与目标

Marginalia 的 AI 阅读伴侣已经有一套 personality 基座——**SOUL**（`name`，出厂默认 `"Lia"`；外加自由 markdown `persona`），用户可在「设置 → Agent」编辑，注入 system prompt。但对话里 assistant 的消息只是一个左对齐的灰气泡，**没有任何视觉身份**：没有头像、气泡旁不显示名字，名字仅出现在 AI 面板顶部 header。

本设计给 assistant 一个**头像（视觉身份）**，在对话中随回复显示，并可开关。这是「强化 personality」的第一步，重心是**视觉身份**，不动人设内容结构、不加行为层 personality。

**核心范式**：头像是**全局单例**——延续 SOUL「彻底删除 assistants 表、全局单一 agent」的精神，全 app 只有一个 assistant、一个头像。头像字节进**通用 `blob` 表**（本期新建的基础设施，未来 cover / notebook 配图都迁入），preferences 仅存一个 `avatarBlobId` 引用。

## §1 核心决策总览

| 决策点        | 结论                                                                                                       |
| ------------- | ---------------------------------------------------------------------------------------------------------- |
| 范围          | 仅 assistant 侧头像；user 消息不动                                                                         |
| 头像来源      | 用户上传自定义本地图片；未设置（`avatarBlobId = null`）时渲染层用内置默认头像                              |
| 上传方式      | 系统文件选择器（`dialog.showOpenDialog`），选本地图片                                                      |
| 存储          | 新建通用 `blob` 表（BLOB 原生）存字节；`preferences.avatarBlobId`（nullable）FK 引用                       |
| 加载协议      | 本期新建 `media://blob/{blobId}` 路由读 `blob` 表；cover 暂留 `cover://`（见 §8）                          |
| 缓存失效      | URL 含 `blobId`，换头像 id 变即 URL 变，天然刷新——无需 `?v` 版本号                                         |
| 显示开关      | 新增 boolean preference `showAgentAvatar`，**默认开启**                                                    |
| 名字          | 复用现有 `soul.name`，不新增字段                                                                           |
| 对话内样式    | 头像 + 名字；连续多条 assistant 消息**成组只在首条**显示                                                   |
| blob 生命周期 | 本期 blob 仅被头像单引用——pick / reset 时删旧 blob（孤儿 GC 简单）；book 删除连带 GC 留给 cover 迁移 issue |

## §2 数据模型

### 2.1 新表 `blob`（通用二进制资源池）

```
blob
├─ id         text PK (uuidv7)     -- 应用侧生成，项目惯例
├─ data       blob (buffer) NOT NULL
├─ mimeType   text NOT NULL        -- 上传时 magic-byte 嗅探一次存入；media handler 直接用
└─ createdAt  integer NOT NULL     -- 毫秒时间戳
```

- **通用基础设施**：本期首个使用者＝头像；书封面 `cover` 迁入、未来 notebook 配图等走独立任务（§8）。它不是「为 avatar 单建的表」。
- **存 `mimeType`**：blob 自描述，media handler 直接用、不必每次嗅探（cover 迁入时同样嗅探后存）。
- 修改 schema 后 `pnpm db:generate` 生成迁移（drizzle-orm 1.0-rc 子目录格式，勿手改）。

### 2.2 头像引用 `avatarBlobId`（标准 preference）

`avatarBlobId` 是个小 uuid 字符串引用（非大二进制），故是**堂堂正正的普通 preference**，走标准链路（参考 `autoSummarize` / `soul`）：

- `src/shared/preferences.ts`：`PREFERENCE_SCHEMAS` 加 `avatarBlobId: z.string().nullable()`；`setPreferenceInput` 加对应 arm（维持对称测试）。
- `src/renderer/store/prefs-store.ts`：state（初值 `null`）；**写入由主进程 agent IPC 落盘**，渲染层在 pick / reset 成功后**直接 setState 镜像**新值（不经 `persistPreference`，避免双写）。
- `src/renderer/store/hydrate-preferences.ts`：加一行 `if (snap.avatarBlobId !== undefined) …`（渲染层启动拿到当前引用以拼 URL）。

> 与 base64 方案对比：因为引用是小 uuid，进启动快照 / hydrate 零膨胀负担——上一版「隔离于单一源、不进快照、专门读写函数」的全部别扭在此消失。

### 2.3 显示开关 `showAgentAvatar`（标准 preference）

走标准 preferences 链路：

- `PREFERENCE_SCHEMAS` 加 `showAgentAvatar: z.boolean()`；`setPreferenceInput` 加 arm。
- `src/main/ipc/preferences-handlers.ts`：switch 加 `case "showAgentAvatar"`（穷尽守卫，见 memory `preferences-set-switch-exhaustiveness`）。
- `prefs-store.ts`：state + 初值 `true` + `setShowAgentAvatar` action（`persistPreference` 后 `set`）。
- `hydrate-preferences.ts`：加一行 hydrate。
- 默认 **开启**。

### 2.4 名字：复用 `soul.name`

对话内头像旁的名字直接读现有 `soul.name`（prefs-store 已有），无新字段、无新链路。SOUL 改名时对话内名字随之更新。

## §3 主进程

### 3.1 `media://blob/{blobId}` 协议（本期新建）

新建 `media://` 协议，本期实现 **`blob` 路由**：

```
media://blob/{blobId}   → blob 表 row → Response(data, { content-type: mimeType })
```

- 注册（仿现有 `cover://`）：`src/main.ts` `registerSchemesAsPrivileged`（`media`，privileges `standard + secure + supportFetchAPI`）+ `protocol.handle("media", …)`。
- handler 解析 host=`blob` → `blobResponseFor(db, id)`；未知 host / blobId 不存在 → 404 Response。
- 实现可参考 `cover-protocol.ts` / `cover-bytes.ts` 的结构（Response 构造、错误兜底）。

> **cover 暂留 `cover://` 不动**（零封面回归）。`cover://` → `media://blob/` 的切换 + `books.cover` 数据迁移统一在 cover 迁移 issue（§8）完成，届时 `media://` 的资源类型路由收敛为单一 `blob/`、`cover://` 退役。本期 `media://` 与 `cover://` 短暂并存是有意的过渡态。

### 3.2 `blobResponseFor(db, blobId)`（新，纯函数）

- 注入 db；查 `blob` row → 命中返回 `Response(data, { content-type: row.mimeType })`；未命中 → 404。
- 头像、以及未来所有 blob 资源共用它——无需头像专属的读取函数。

### 3.3 IPC（仿 `libraryPickBook`）

`src/shared/ipc.ts` 新增契约，`src/main/ipc/agent-handlers.ts`（注入 db + dialog + 文件读取）：

- **`agent:pick-avatar`**（invoke，input `z.void()`，output `{ status: "set"; blobId: string } | { status: "cancelled" | "too-large" | "unsupported" }`）：
  弹 `dialog.showOpenDialog`（filters png/jpg/jpeg/webp/gif）→ 取消 `"cancelled"` → 读文件字节 → 校验大小（§5）超限 `"too-large"`、magic-byte 复核类型失败 `"unsupported"` → 嗅探 mime →（事务内）建 `blob` row（uuidv7 / data / mime）+ 读旧 `avatarBlobId` + `setPreference(db, "avatarBlobId", newId)` + 删旧 blob row（若有）→ `{ status: "set", blobId: newId }`。
- **`agent:reset-avatar`**（invoke，input `z.void()`，output `z.void()`）：
  读 `avatarBlobId` →（事务内）`setPreference(db, "avatarBlobId", null)` + 删该 blob row → void。

业务逻辑拆纯函数（注入 db / 读文件 / dialog），handler 仅注入 Electron 依赖，保持无头可测。`avatarBlobId` 虽是合法 preference、其 arm 在 `setPreferenceInput` 中，但实际写入恒经此处 agent IPC（需配套建 / 删 blob），不经 `preferences:set`。

### 3.4 内置默认头像（渲染层静态 asset）

`avatarBlobId == null` 时**渲染层直接用打包的静态 asset**（不占 blob 表、不走 IPC / 协议）。形象气质契合 Lia（温暖、好奇的阅读伴侣），简洁矢量风。具体美术与打包路径见 §9。

## §4 渲染层

### 4.1 `AssistantAvatar.tsx`

- `const src = avatarBlobId ? `media://blob/${avatarBlobId}` : defaultAvatarUrl`；`<img>` 圆形（`rounded-full object-cover`），尺寸由 prop 控制（对话内小、设置预览大）。
- **无需 `?v` 版本号**：换头像 → `avatarBlobId` 变 → URL 变 → 浏览器自然重新加载；reset → 回落 `defaultAvatarUrl`。
- `onError` 兜一层（纯色圆 + 名字首字母），防协议异常。

### 4.2 `MessageList.tsx` 改造

- `AssistantBubble`：`showAgentAvatar` 开启时，**成组首条** assistant 消息左侧渲染「头像 + `soul.name`」；同组后续缩进对齐、不重复头像。
- **成组判断**：当前 assistant 消息的前一条不是 assistant（或它是列表首条）即为该组首条。
- 开关关闭 → 完全回到现状（无头像、无名字、无缩进）。user 气泡不变。

### 4.3 设置 → Agent 分类（`AgentSettings.tsx`）

挨着 SOUL 名字 / persona，新增头像区块：

- 头像预览（`AssistantAvatar` 大尺寸）。
- 「上传头像」按钮 → `window.api.agent.pickAvatar()`；`"set"` → setState `avatarBlobId = blobId`，`"too-large"` / `"unsupported"` → toast，`"cancelled"` → no-op。
- 「恢复默认」按钮 → `window.api.agent.resetAvatar()` → setState `avatarBlobId = null`。
- 「对话中显示头像」开关（`Checkbox` 绑 `showAgentAvatar`）。

## §5 边界与错误处理

- **上传类型**：限 png / jpg / jpeg / webp / gif（dialog filters + 读后 magic-byte 复核）。
- **上传大小**：上限 **2 MB**；超限**不写库**，渲染层 **toast** 提示（memory `no-os-dialogs-use-toast-alertdialog`：不弹 OS 框）。
- **dialog 取消**：no-op（IPC 返回 `"cancelled"`）。
- **blob 孤儿 GC（本期）**：blob 仅被 `avatarBlobId` 单引用——pick 换图删旧 blob、reset 删 blob，事务内完成，无悬空引用、无孤儿。（book 删除连带 cover blob 的 GC 属 cover 迁移 issue。）
- **图片缺失 / 协议异常**：`blobResponseFor` 未命中 → 404；渲染层 `onError` 兜底。
- **优雅吞错处留 warn**：协议 handler 读字节失败、IPC 文件读失败等软失败 `log.warn`（CLAUDE.md 日志规范）。
- 文案走 i18n（`t()` + 默认中文），`pnpm i18n:extract` 同步。

## §6 测试策略（vitest，主进程纯函数）

- `blobResponseFor`：命中 → 返回 data + 正确 mimeType；未命中 → 404。
- `media://blob` 路由分发：合法 blobId → 命中；未知 host / 缺失 id → 404。
- `pick-avatar` 纯函数：合法图片 → 建 blob + 设 `avatarBlobId` + 删旧 blob + 返回 `{status:"set", blobId}`；超大小 → `"too-large"` 不写库；类型不符 → `"unsupported"`；dialog 取消 → `"cancelled"`。
- **孤儿验证**：连续两次 pick → 仅最新 blob 存在，旧 blob 已删；reset 后 blob 删尽、`avatarBlobId == null`。
- preference `avatarBlobId` / `showAgentAvatar` 落盘 + hydrate（以 sqlite 为准核验）。

## §7 回归风险

- **本期不碰 cover**（不动 `cover://`、不动 `books.cover`）——封面零回归。
- 仅新增 `blob` 表 + `media://` 协议 + 两个 preference + agent IPC + 渲染层组件；回归面集中在「新功能自身」。
- 新建 `media://` 协议需冒烟：上传头像后对话内、设置预览均能加载；reset 回落默认 asset。

## §8 不在本期范围（衍生独立 issue）

- **cover 迁移到 `blob` 表（#83，依赖本期 blob 表）**：`books.cover` BLOB 迁入 `blob` 表 + books 加 `coverBlobId` FK + 封面加载切到 `media://blob/{coverBlobId}` + `cover://` 协议退役 + book 删除连带 blob GC + 数据迁移 + 封面回归冒烟。完成后「别的表不再存 blob、全走 FK」的统一终态达成。
- user 侧头像（仅 assistant）。
- 预设头像库 / 头像随情绪场景切换。
- 结构化人设（语气 / 风格 / 口癖 / 开场白）、预设人格包、行为层 personality——「强化 personality」的 B/C 方向另议。
- 头像图片压缩 / 裁剪 UI。
- `media://` 承载音频等非图片媒体。

## §9 待实现阶段细化（不阻塞 spec）

- 默认头像的具体美术形象与渲染层打包路径。
- 对话内头像精确尺寸 / 间距 / 与名字的排版微调。
- 头像在 AI 面板 header 是否也替换（当前仅文字名）——可选增强，非本期硬需求。
