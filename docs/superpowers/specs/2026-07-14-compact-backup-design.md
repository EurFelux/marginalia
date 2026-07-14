# 精简备份设计

日期：2026-07-14
状态：已与用户对齐（待书面规格复核）
关联：GitHub issue #104；既有完整备份 #28；云同步 #103（非本功能范围）

## 1. 背景与目标

Marginalia 现有手动备份会打包一致 SQLite 快照与 `userData/books/` 下的全部 EPUB/PDF 原文件。换设备时，用户常常只需要迁移应用数据；书籍原文件体积远大于数据库，导致整个备份包过重。

本功能新增一种**精简备份**：数据库内容与完整备份完全一致，只排除 `books/` 原文件目录。它仍然是“备份与恢复”，不是双向同步：恢复永远使用快照整体覆盖，不做逐表合并、冲突检测或 last-write-wins。

成功标准：

- 默认可一键导出不含 EPUB/PDF 原文件的精简包。
- 精简恢复完整替换当前数据库，但不移动、删除或覆盖目标设备现有 `books/`。
- 内容哈希相同的本地书籍文件在恢复后自动继续可用；缺失文件复用现有 fallback 与重新连接流程。
- 现有完整备份及其整体恢复行为保持可用。

## 2. 决策摘要

| 决策点     | 结论                                                                                                                                                 |
| ---------- | ---------------------------------------------------------------------------------------------------------------------------------------------------- |
| 精简范围   | **完整 SQLite 快照减去 `books/`**；设置、供应商配置、明文 API key、书籍元数据/封面、进度、标注、笔记、摘要、会话、记忆、统计与内部状态均随数据库保留 |
| 恢复语义   | **整体覆盖**，不合并。完整包覆盖 DB + `books/`；精简包只覆盖 DB，目标 `books/` 原样保留                                                              |
| 默认导出   | 精简备份为默认主操作；完整备份收进 split button 的下拉段                                                                                             |
| 导入入口   | 保留一个“还原备份”入口；inspect 后按 manifest 自动选择完整/精简确认文案与恢复路径                                                                    |
| 快照与格式 | 复用 better-sqlite3 在线 `.backup()` 与 zip；精简包只少一个 `books/` 条目，不另造 JSON 导出协议                                                      |
| 安全网     | 恢复前保留当前数据。完整恢复备份当前 DB + `books/`；精简恢复只备份当前 DB 三件套，因 `books/` 从未被触碰                                             |
| 恢复后接续 | 成功后 `app.relaunch()` + `app.exit(0)`，由正常启动流程打开新 DB、跑迁移并重建 renderer 状态                                                         |

## 3. 备份包协议

### 3.1 Manifest 演进

`BackupManifest` 新增：

```ts
kind: "full" | "compact";
```

`BACKUP_FORMAT_VERSION` 从 1 升到 2：

- 新导出的 v2 包必须携带 `kind`。
- 既有 v1 包没有 `kind`，新版本读取时规范化为 `kind: "full"`。
- `formatVersion > BACKUP_FORMAT_VERSION` 明确拒绝，避免未来格式被旧恢复逻辑误判。
- schemaHead 兼容判定继续负责“导出方 DB schema 是否可由当前 app 接受”；formatVersion 与 schemaHead 是两个独立门槛。

`BackupInspection` 返回规范化后的 manifest，因此 renderer 不需要处理 legacy 分支。

`backup:export` input 从空对象改为 `{ kind: "full" | "compact" }`；kind 由 renderer 的 split button 明确传入，主进程不维护隐式默认值。preload API 继续只暴露一个 `backup.export(input)`。

### 3.2 Zip 条目

完整备份（v2）：

```text
marginalia-backup-YYYYMMDD-HHMMSS.zip
├── manifest.json         # kind = "full"
├── marginalia.db
└── books/
```

精简备份（v2）：

```text
marginalia-compact-backup-YYYYMMDD-HHMMSS.zip
├── manifest.json         # kind = "compact"
└── marginalia.db
```

两种包都保留 `dbSha256`；`bookCount` 表示快照数据库内的书籍数，不表示包内文件数。`includesApiKeys` 对两种包均为 true。

## 4. 用户界面

### 4.1 导出：Split button（已确认方案 A）

设置 → 高级 → 备份与还原只显示**一个组合导出控件**：

- 左侧主按钮：下载图标 + “导出精简备份”；点击即打开精简包 save dialog。
- 右侧窄箭头：打开菜单；菜单仅有“导出完整备份”，副文案提示“包含所有 EPUB/PDF 原文件”。
- 两段视觉上组成一个按钮；键盘焦点与 aria-label 分开，主按钮和菜单触发器均可独立操作。
- 使用项目 shadcn/base-ui 风格封装 split button / menu；静态样式走 Tailwind，不写内联 CSS。

旁侧说明明确：精简备份适合设备间传递且不含书籍原文件；完整备份适合归档。API key 明文警告继续保留，并同时适用于两种包。

### 4.2 还原：单入口、按类型确认

保留单个“还原备份”按钮。选包并 inspect 后：

- **完整包**：沿用破坏性确认，说明“将整体替换当前全部数据与书籍原文件；当前数据会先保存安全副本”。
- **精简包**：说明“将整体替换当前应用数据；本机现有书籍原文件不会被删除或覆盖。快照中缺少本地文件的书会显示重新连接界面”。
- 两者都展示备份类型、导出时间、app 版本与书籍数，并说明应用随后重启。

精简恢复仍是整体覆盖，因此确认按钮保持 destructive 语义；不得使用“合并”“同步”“较新数据获胜”等措辞。

## 5. 主进程流程

### 5.1 导出

现有 `exportBackup` 增加 `kind` 输入：

1. save dialog 默认文件名按 kind 区分。
2. better-sqlite3 `.backup()` 生成一致单文件快照。
3. 计算 `dbSha256` 并构建 v2 manifest。
4. `createBackupZip` 恒写 manifest + DB；仅 `kind === "full"` 时追加 `books/`。
5. 清理临时快照并返回路径。

时间戳由 `Temporal.Now.zonedDateTimeISO()` 生成，不新增 `Date` 用法。

### 5.2 Inspect

1. 读取并校验 manifest；v1 规范化为 full。
2. 拒绝未知/未来 formatVersion。
3. 运行既有 schemaHead 兼容判定。
4. 返回带规范化 `kind` 的 `BackupInspection`。

### 5.3 完整恢复

保留现有行为：解包到 staging → 校验 DB sha256 → 校验 DB 引用的每本书均有包内文件 → 关闭 live DB → 当前 DB + `books/` 移入 pre-restore → staged DB + `books/` 换入正式位置 → 重启。

### 5.4 精简恢复

1. 解包到 staging；校验 manifest、schemaHead、DB sha256，并以只读连接执行 `PRAGMA quick_check`，结果必须为 `ok`。
2. **不调用** `verifyBookFiles`：精简包按定义没有 `books/`。
3. 关闭 live DB，释放 WAL/文件锁。
4. 把当前 `marginalia.db`、`-wal`、`-shm` 移入 `pre-restore/<timestamp>/`。
5. 把 staged `marginalia.db` 换入 dataDir。
6. **不移动、不创建、不删除** dataDir 下现有 `books/`。
7. 重启；启动流程对恢复进来的旧 schema 自动跑迁移。

`applyRestore` 必须接收 `kind: BackupKind`，使“是否替换 books”由显式类型驱动；禁止用“staging 是否碰巧存在 books/”推断语义。

## 6. 恢复后的书籍文件行为

书籍 DB 主键是原文件内容哈希，`storedBookPath(booksDir, bookId, format)` 在设备间稳定。因此：

- 目标 `books/` 已有相同内容哈希文件：恢复后的书籍行可直接读取该文件。
- 目标缺少文件：`library:read-book-bytes` 返回既有 `{ ok: false, reason: "missing" }`，reader 显示现有重新连接 fallback。
- 目标 `books/` 有文件但恢复后的 DB 不再引用：文件成为不可见的 orphan。本功能不自动删除，以免精简恢复额外破坏本地文件；清理策略另议。

## 7. 错误处理与日志

- 坏 zip、缺 manifest/DB、manifest 非法、未来 formatVersion：inspect/restore 拒绝，当前数据不变。
- schemaHead 来自更新版本：拒绝恢复，当前数据不变。
- DB checksum 不符或 SQLite 无法打开：触发安全网前拒绝。
- 完整包缺书文件：继续按现有规则拒绝；精简包跳过此检查。
- 文件换入阶段失败：错误必须指出 pre-restore 安全副本位置；logger 使用 `backup` module，IPC catch-all 负责最终错误落盘，handler 不重复记录。
- 精简恢复相关日志不得声称 `books/` 已备份或替换。

## 8. 测试

### Shared / manifest

- v2 full 与 compact manifest 均通过。
- v1 manifest 被规范化为 full。
- 未来 formatVersion、v2 缺 kind、非法 kind 被拒绝。

### Archive / service

- compact zip 仅含 manifest + DB；full zip 仍含 books。
- 两种包 inspect 返回正确 kind、bookCount、schema/version 兼容结论。
- compact 包损坏 checksum 时在触碰 live 数据前拒绝。

### Restore integration

- compact roundtrip：目标 DB 被快照完整替换；目标 `books/` 中匹配文件和额外文件均保持字节不变；pre-restore 只包含旧 DB 三件套。
- compact 恢复到没有匹配文件的目标：DB 正常打开、书籍行存在，读取路径返回现有 missing fallback。
- full restore 回归：DB + books 仍整体替换，缺包内书文件仍拒绝。
- v1 full restore 回归。

### Renderer / contract

- split button 主段调用 compact export；菜单项调用 full export。
- inspect full/compact 选择对应确认文案。
- IPC contract、preload API 与 handler coverage 保持无漂移。
- i18n extract/lint 通过，中英文文案均覆盖。

## 9. 非目标

- 数据合并、双向同步、冲突检测、last-write-wins、云同步。
- 增量备份、定时备份、备份加密。
- API key 剔除开关（仍随数据库明文导出并明确警告）。
- orphan 书籍文件扫描或自动清理。
- 改变既有缺文件 fallback、重连校验或书籍内容哈希策略。
