# 头像图片裁剪设计（issue #85）

日期：2026-06-15
状态：设计中
关联：#85（Add avatar image cropping on upload）；依赖 #82 / PR #84（assistant avatar）

## §0 背景与目标

#82 让用户上传 assistant 头像，但上传的图**原样存**——非正方形 / 没对准的图在圆形头像里很难看。本设计在上传时插入一个**裁剪环节**：用户框定 1:1 区域（圆形蒙版，所见即圆头像）、缩放拖拽，确认后只存裁剪结果。

用库 `react-easy-crop`（用户选定）：自带拖拽 + 缩放 + 固定比例 + 圆形蒙版；它只输出**裁剪区坐标** `croppedAreaPixels`，实际出图由我们用浏览器 `<canvas>` 完成。

## §1 核心决策总览

| 决策点       | 结论                                                                                               |
| ------------ | -------------------------------------------------------------------------------------------------- |
| 触发         | 「上传头像」改为渲染层 `<input type="file" accept="image/*">` 选图                                 |
| 原图入渲染层 | `FileReader.readAsDataURL` 读成 dataURL 喂裁剪器（裁剪必须在渲染层做）                             |
| 裁剪 UI      | 新 `AvatarCropDialog`（Base UI `dialog.tsx` + `react-easy-crop`）：圆形蒙版 / `aspect:1` / zoom    |
| 出图         | 浏览器 `<canvas>` 按 `croppedAreaPixels` 裁出，缩放到**最长边 ≤ 512px**，`toBlob("image/png")`     |
| 存储         | 裁剪后字节经新 IPC **`agent:set-avatar(Uint8Array)`** → 复用现有 `storeAvatar`（校验 + blob + GC） |
| 废弃         | 删 `agent:pick-avatar`（#82 的主进程 dialog 路径，必须先裁剪故不再用）；`storeAvatar` 业务不变     |
| 依赖         | `pnpm add react-easy-crop`（主应用）                                                               |

## §2 数据流

```
AgentSettings「上传头像」
  → 隐藏 <input type=file accept=image/*> 选图（Electron 弹原生选择器）
  → FileReader.readAsDataURL → dataURL
  → 打开 AvatarCropDialog（imageSrc=dataURL）
  → react-easy-crop：拖拽/缩放，onCropComplete 回传 croppedAreaPixels
  → 用户「确认」→ getCroppedBlob(dataURL, croppedAreaPixels) 经 <canvas> 出图（≤512px, png）
  → Uint8Array → window.api.agent.setAvatar(bytes)
  → 主进程 agent:set-avatar handler → storeAvatar(getDb(), bytes)
  → 返回 AvatarPickResult；渲染层 "set" → setAvatarBlobId(blobId)，关闭 Dialog
```

对比 #82：原本字节只在主进程（dialog 读 → 存）；裁剪要求字节在渲染层，故改为渲染层选图 + 裁剪 + 回存。

## §3 裁剪 UI 组件 `AvatarCropDialog.tsx`（新，渲染层）

- 复用 Base UI `dialog.tsx`（受控 `open`）。内容：`react-easy-crop` 的 `<Cropper>`（`image=imageSrc`、`aspect={1}`、`cropShape="round"`、`showGrid={false}`、`crop`/`zoom` 受控、`onCropChange`/`onZoomChange`/`onCropComplete`）。
- 缩放控件：原生 `<input type="range" min=1 max=3 step=0.01>`（Tailwind 样式，避免新增 slider 组件）。
- 底部「取消」「确认」（Base UI Button）。确认时调用 `getCroppedBlob` → `setAvatar`，期间按钮 disabled + busy 态。
- props：`open`、`imageSrc`、`onConfirm(bytes: Uint8Array)`、`onOpenChange`。
- 内部状态 `crop`/`zoom`/`croppedAreaPixels`/`busy` 用 `useState`（React Compiler 自动记忆，勿手写 memo）。

## §4 出图工具 `getCroppedBlob.ts`（新，渲染层纯逻辑）

`async function getCroppedBlob(imageSrc: string, area: { x; y; width; height }): Promise<Uint8Array>`：

- `new Image()` 载 `imageSrc`（await onload）。
- `<canvas>` 尺寸 = 裁剪区缩放到最长边 ≤ 512（保持 1:1，故 512×512 或更小）。
- `ctx.drawImage(img, area.x, area.y, area.width, area.height, 0, 0, dstW, dstH)`。
- `canvas.toBlob(blob => …, "image/png")` → `blob.arrayBuffer()` → `Uint8Array`。

## §5 IPC 改动

- **新增** `C.agentSetAvatar = def("agent:set-avatar", "invoke", z.instanceof(Uint8Array), out<AvatarPickResult>())`（参考 `libraryReadBookBytes` 用 `Uint8Array`）。
- **删除** `C.agentPickAvatar` + `agent-handlers` 的 pick binding + `preload-api` 的 `agent.pickAvatar`。
- `agent-handlers` 新 binding：`bind(C.agentSetAvatar, (bytes) => storeAvatar(getDb(), bytes))`（同步；`storeAvatar` 已含 too-large/unsupported 校验 + blob 写入 + 旧 blob GC，原样复用）。
- `preload-api`：`agent.setAvatar: inv(C.agentSetAvatar)`。
- 更新 `bindings-coverage` / `preferences`(无关) 等漂移测试中对 agent 通道的引用（pick→set）。
- `AvatarPickResult` 复用（`set`/`too-large`/`unsupported`；裁剪路径没有 `cancelled`——取消在 Dialog 层处理、不调 IPC，所以 set-avatar 实际只返回前三者，但类型复用无碍）。

## §6 AgentSettings 改动

- 「上传头像」按钮 → 触发隐藏 `<input ref>` 的 `.click()`；`onChange` 读文件 → `FileReader.readAsDataURL` → 存 `imageSrc` state + 开 `AvatarCropDialog`。
- `AvatarCropDialog.onConfirm(bytes)` → `window.api.agent.setAvatar(bytes)`：`"set"` → `setAvatarBlobId(blobId)`，`"too-large"`/`"unsupported"` → toast，然后关 Dialog。
- 「恢复默认」（`agent:reset-avatar`）、「对话中显示头像」开关：**不变**。
- input 选完后清空 `value`（同一文件可再次选触发 onChange）。

## §7 边界与错误处理

- **取消裁剪**：关 Dialog、不调 IPC、头像不变。
- **非图片 / 读取失败**：`FileReader` onerror 或 `Image` onload 失败 → toast「无法读取图片」，不开/关 Dialog。
- **裁剪后仍超限**：≤512px png 通常很小；万一超 `storeAvatar` 的 2MB 仍由其校验拦截 → `"too-large"` toast。
- **超大原图**：`accept=image/*` 不限源大小；极大图渲染层加载可能短暂卡顿——本期不加源大小硬限（裁剪输出已限），留作后续。
- 文案走 i18n（`t()` + 默认中文 + 英文补全 en.ts，避免 #84 遇到的 extract 留空坑）。

## §8 测试策略

- `storeAvatar`（接收字节、校验、GC）已在 #82 测试覆盖——set-avatar 直接复用，无需重测业务。
- `agent:set-avatar` handler 薄（仅 `storeAvatar` 转发）；`bindings-coverage` 漂移测试覆盖通道存在。
- **`getCroppedBlob` / `AvatarCropDialog` 依赖浏览器 `Image`/`<canvas>`/DOM**，vitest（Electron node 运行时，无 DOM/canvas）难无头测——靠**手动冒烟**：选图 → 裁剪器显示 → 缩放拖拽 → 确认 → 头像更新为裁剪结果；取消不改；非图片报错 toast。
- 诚实记录：本特性核心是渲染层 canvas/UI，自动化覆盖有限，冒烟是主要验证手段。

## §9 不在本期范围

- 裁剪输出格式 / 质量可调（固定 png ≤512）。
- 源图大小硬限制 / 上传前压缩。
- 旋转、滤镜、多次裁剪历史。
- 对已存头像的再裁剪（只在上传时裁；要改重新上传）。

## §10 分支与依赖说明

本特性依赖 #82 的 avatar 代码（`storeAvatar`、`AvatarPickResult`、`AgentSettings`、agent IPC）。实现分支 `feat/avatar-crop` 基于 PR #84 的 HEAD；**#84 合并后该分支 rebase onto main**（avatar commits 被 main 吸收，裁剪 PR 收敛为仅裁剪 diff）。
