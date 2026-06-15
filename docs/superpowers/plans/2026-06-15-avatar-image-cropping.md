# 头像图片裁剪 Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 上传头像时插入裁剪环节：渲染层选图 → `react-easy-crop` 圆形 1:1 裁剪 → 浏览器 canvas 出图（≤512px）→ 新 `agent:set-avatar` IPC 复用 `storeAvatar` 存。

**Architecture:** 图片字节移到渲染层处理：`AgentSettings` 用隐藏 `<input file>` 选图、`FileReader` 读 dataURL、`AvatarCropDialog`（Base UI Dialog + react-easy-crop）裁剪、`get-cropped-blob` 经浏览器 `<canvas>` 出 `Uint8Array`、`window.api.agent.setAvatar(bytes)` 存。废弃 #82 的主进程 dialog 路径 `agent:pick-avatar`；`storeAvatar`/`resetAvatar`/blob/协议/显示全部不变。

**Tech Stack:** React 19 + react-easy-crop / Base UI Dialog / 浏览器 canvas / Electron IPC（Zod）/ TypeScript 6 / vitest 4。

设计依据：`docs/superpowers/specs/2026-06-15-avatar-image-cropping-design.md`。基于 PR #84 的 avatar 代码（`feat/avatar-crop` 分支）。

---

## File Structure

**新建：**

- `src/renderer/ai/get-cropped-blob.ts` — 浏览器 canvas 出图工具（dataURL + 裁剪区 → Uint8Array）
- `src/renderer/ai/AvatarCropDialog.tsx` — 裁剪弹窗（Base UI Dialog + react-easy-crop + zoom range）

**修改：**

- `package.json` / lockfile — 加 `react-easy-crop`
- `src/shared/ipc.ts` — 加 `agentSetAvatar`，删 `agentPickAvatar`
- `src/main/ipc/agent-handlers.ts` — 加 set binding，删 pick binding + 清理 imports
- `src/preload-api.ts` — 加 `agent.setAvatar`，删 `agent.pickAvatar`
- `src/renderer/settings/AgentSettings.tsx` — 上传改为 input file + 裁剪弹窗 + setAvatar
- i18n locales（extract 生成 + en 补全）

---

## Task 1: 安装 react-easy-crop

**Files:** `package.json`, `pnpm-lock.yaml`

- [ ] **Step 1: 安装依赖**

Run: `pnpm add react-easy-crop`
Expected: 写入 `package.json` dependencies；postinstall 自动把 better-sqlite3 重编回 Electron ABI（见 CLAUDE.md 坑）。

- [ ] **Step 2: 验证 better-sqlite3 ABI 未坏 + 类型可解析**

Run: `pnpm test src/main/media/blob-store.test.ts`
Expected: PASS（证明 better-sqlite3 仍是 Electron ABI；若失败手动 `pnpm db:rebuild:electron`）。

- [ ] **Step 3: Commit**

```bash
git add package.json pnpm-lock.yaml
git commit -m "chore: add react-easy-crop dependency (#85)"
```

---

## Task 2: 出图工具 `get-cropped-blob.ts`

**Files:**

- Create: `src/renderer/ai/get-cropped-blob.ts`

无单测：依赖浏览器 `Image`/`<canvas>`，vitest（Electron node 运行时，无 DOM/canvas）无法无头测——靠 Task 7 冒烟。逻辑保持极简。

- [ ] **Step 1: 实现**

`src/renderer/ai/get-cropped-blob.ts`:

```ts
/** 裁剪区（react-easy-crop 的 croppedAreaPixels：源图像素坐标）。 */
export interface CropArea {
  x: number;
  y: number;
  width: number;
  height: number;
}

/** 头像输出最长边上限（px），控制 blob 体积。 */
export const AVATAR_OUTPUT_MAX = 512;

function loadImage(src: string): Promise<HTMLImageElement> {
  return new Promise((resolve, reject) => {
    const img = new Image();
    img.onload = () => resolve(img);
    img.onerror = () => reject(new Error("image load failed"));
    img.src = src;
  });
}

/** 按裁剪区从 dataURL 出图，缩放到最长边 ≤ AVATAR_OUTPUT_MAX，返回 png 字节。 */
export async function getCroppedBlob(imageSrc: string, area: CropArea): Promise<Uint8Array> {
  const img = await loadImage(imageSrc);
  const scale = Math.min(1, AVATAR_OUTPUT_MAX / Math.max(area.width, area.height));
  const dstW = Math.max(1, Math.round(area.width * scale));
  const dstH = Math.max(1, Math.round(area.height * scale));
  const canvas = document.createElement("canvas");
  canvas.width = dstW;
  canvas.height = dstH;
  const ctx = canvas.getContext("2d");
  if (!ctx) throw new Error("canvas 2d context unavailable");
  ctx.drawImage(img, area.x, area.y, area.width, area.height, 0, 0, dstW, dstH);
  const blob = await new Promise<Blob | null>((resolve) => canvas.toBlob(resolve, "image/png"));
  if (!blob) throw new Error("canvas toBlob returned null");
  return new Uint8Array(await blob.arrayBuffer());
}
```

- [ ] **Step 2: typecheck**

Run: `pnpm typecheck`
Expected: PASS。

- [ ] **Step 3: Commit**

```bash
git add src/renderer/ai/get-cropped-blob.ts
git commit -m "feat(ai): add canvas crop-to-blob helper (#85)"
```

---

## Task 3: 新增 `agent:set-avatar` IPC（保留 pick，下个任务再删）

**Files:**

- Modify: `src/shared/ipc.ts`
- Modify: `src/main/ipc/agent-handlers.ts`
- Modify: `src/preload-api.ts`

- [ ] **Step 1: ipc.ts 加契约**

`src/shared/ipc.ts`，在 `agentResetAvatar` 那行（`agent:reset-avatar`）之后加：

```ts
  agentSetAvatar: def("agent:set-avatar", "invoke", z.instanceof(Uint8Array), out<AvatarPickResult>()),
```

（`AvatarPickResult` 已 import。`z.instanceof(Uint8Array)` 校验入参，参考 `libraryReadBookBytes` 用 `Uint8Array`。）

- [ ] **Step 2: agent-handlers 加 set binding**

`src/main/ipc/agent-handlers.ts`，在 `agentBindings` 数组里 `bind(C.agentResetAvatar, …)` 之后加：

```ts
  bind(C.agentSetAvatar, (bytes) => storeAvatar(getDb(), bytes)),
```

（`storeAvatar` 已 import；它已含 too-large/unsupported 校验 + blob 写入 + 旧 blob GC，直接复用。）

- [ ] **Step 3: preload 暴露 setAvatar**

`src/preload-api.ts` 的 `agent` 段，在 `resetAvatar: inv(C.agentResetAvatar),` 之后加：

```ts
      setAvatar: inv(C.agentSetAvatar),
```

- [ ] **Step 4: typecheck + 全量测试**

Run: `pnpm typecheck && pnpm test`
Expected: PASS（pick 仍在，无消费者破坏；`bindings-coverage` 遍历 `agentBindings`，新 set binding 自动覆盖）。

- [ ] **Step 5: Commit**

```bash
git add src/shared/ipc.ts src/main/ipc/agent-handlers.ts src/preload-api.ts
git commit -m "feat(ipc): add agent:set-avatar channel (#85)"
```

---

## Task 4: 裁剪弹窗 `AvatarCropDialog.tsx`

**Files:**

- Create: `src/renderer/ai/AvatarCropDialog.tsx`

- [ ] **Step 1: 实现**

`src/renderer/ai/AvatarCropDialog.tsx`:

```tsx
import { useState } from "react";
import Cropper, { type Area } from "react-easy-crop";
import { useTranslation } from "react-i18next";
import {
  Dialog,
  DialogContent,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@renderer/components/ui/dialog";
import { Button } from "@renderer/components/ui/button";
import { getCroppedBlob } from "@renderer/ai/get-cropped-blob";
import { createLogger } from "@renderer/logger";

const log = createLogger("avatar");

/** 头像裁剪弹窗：圆形蒙版 1:1 + 缩放；确认时出图回调 onConfirm(bytes)。 */
export function AvatarCropDialog({
  open,
  imageSrc,
  onConfirm,
  onOpenChange,
}: {
  open: boolean;
  imageSrc: string | null;
  onConfirm: (bytes: Uint8Array) => Promise<void> | void;
  onOpenChange: (open: boolean) => void;
}) {
  const { t } = useTranslation();
  const [crop, setCrop] = useState({ x: 0, y: 0 });
  const [zoom, setZoom] = useState(1);
  const [area, setArea] = useState<Area | null>(null);
  const [busy, setBusy] = useState(false);

  const confirm = async () => {
    if (!imageSrc || !area) return;
    setBusy(true);
    try {
      const bytes = await getCroppedBlob(imageSrc, area);
      await onConfirm(bytes);
      onOpenChange(false);
    } catch (err) {
      log.warn("crop failed", err);
    } finally {
      setBusy(false);
    }
  };

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="sm:max-w-md">
        <DialogHeader>
          <DialogTitle>{t("settings.agent.avatarCropTitle", "裁剪头像")}</DialogTitle>
        </DialogHeader>
        <div className="relative h-64 w-full overflow-hidden rounded-md bg-muted">
          {imageSrc && (
            <Cropper
              image={imageSrc}
              crop={crop}
              zoom={zoom}
              aspect={1}
              cropShape="round"
              showGrid={false}
              onCropChange={setCrop}
              onZoomChange={setZoom}
              onCropComplete={(_area, areaPixels) => setArea(areaPixels)}
            />
          )}
        </div>
        <input
          type="range"
          min={1}
          max={3}
          step={0.01}
          value={zoom}
          onChange={(e) => setZoom(Number(e.target.value))}
          aria-label={t("settings.agent.avatarZoom", "缩放")}
          className="w-full accent-primary"
        />
        <DialogFooter>
          <Button variant="outline" onClick={() => onOpenChange(false)} disabled={busy}>
            {t("common.cancel", "取消")}
          </Button>
          <Button onClick={confirm} disabled={busy || !area}>
            {t("common.save", "保存")}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
```

> React Compiler 启用：勿手写 useCallback/useMemo。Cropper 容器必须 `relative` + 定高（`h-64`），否则 react-easy-crop 无法定位。

- [ ] **Step 2: typecheck**

Run: `pnpm typecheck`
Expected: PASS。

- [ ] **Step 3: Commit**

```bash
git add src/renderer/ai/AvatarCropDialog.tsx
git commit -m "feat(ai): add AvatarCropDialog (react-easy-crop) (#85)"
```

---

## Task 5: AgentSettings 接线（input file + 裁剪弹窗 + setAvatar）

**Files:**

- Modify: `src/renderer/settings/AgentSettings.tsx`

- [ ] **Step 1: 改 imports + 上传逻辑**

`src/renderer/settings/AgentSettings.tsx`：

顶部 import 加：

```tsx
import { useRef } from "react";
import { AvatarCropDialog } from "@renderer/ai/AvatarCropDialog";
```

（`useState` 已 import；把 `import { useState }` 改为 `import { useRef, useState }`。）

把现有 `onPickAvatar`（第 25-32 行整段）替换为：

```tsx
const fileInputRef = useRef<HTMLInputElement>(null);
const [cropSrc, setCropSrc] = useState<string | null>(null);

const onUploadClick = () => fileInputRef.current?.click();

const onFilePicked = (e: React.ChangeEvent<HTMLInputElement>) => {
  const file = e.target.files?.[0];
  e.target.value = ""; // 允许再次选同一文件
  if (!file) return;
  const reader = new FileReader();
  reader.onload = () => setCropSrc(typeof reader.result === "string" ? reader.result : null);
  reader.onerror = () => toast.error(t("settings.agent.avatarReadFailed", "无法读取图片"));
  reader.readAsDataURL(file);
};

const onCropConfirm = async (bytes: Uint8Array) => {
  const r = await window.api.agent.setAvatar(bytes);
  if (r.status === "set") setAvatarBlobId(r.blobId);
  else if (r.status === "too-large")
    toast.error(t("settings.agent.avatarTooLarge", "图片太大，请选择 2 MB 以内的图片"));
  else if (r.status === "unsupported")
    toast.error(t("settings.agent.avatarUnsupported", "不支持的图片格式"));
};
```

- [ ] **Step 2: 改上传按钮 + 加隐藏 input + 裁剪弹窗**

把头像区块里的「上传头像」按钮 `onClick={onPickAvatar}` 改为 `onClick={onUploadClick}`。

在该 `<Button …上传头像…>` 之后（仍在按钮 `<div className="flex gap-2">` 内或其后）加隐藏 input；并在头像区块 `</div>` 结束前加裁剪弹窗：

```tsx
        <input
          ref={fileInputRef}
          type="file"
          accept="image/*"
          className="hidden"
          onChange={onFilePicked}
        />
        <AvatarCropDialog
          open={cropSrc !== null}
          imageSrc={cropSrc}
          onConfirm={onCropConfirm}
          onOpenChange={(o) => {
            if (!o) setCropSrc(null);
          }}
        />
```

- [ ] **Step 3: typecheck**

Run: `pnpm typecheck`
Expected: PASS（`window.api.agent.setAvatar` 已存在；`pickAvatar` 仍存在但不再被调用——下个任务删）。

- [ ] **Step 4: Commit**

```bash
git add src/renderer/settings/AgentSettings.tsx
git commit -m "feat(settings): crop avatar on upload via input + AvatarCropDialog (#85)"
```

---

## Task 6: 删除废弃的 `agent:pick-avatar`

**Files:**

- Modify: `src/shared/ipc.ts`
- Modify: `src/main/ipc/agent-handlers.ts`
- Modify: `src/preload-api.ts`

- [ ] **Step 1: 删 ipc 契约**

`src/shared/ipc.ts`：删除 `agentPickAvatar: def("agent:pick-avatar", …)` 整行。

- [ ] **Step 2: 删 handler binding + 清理 imports**

`src/main/ipc/agent-handlers.ts`：

- 删除 `bind(C.agentPickAvatar, …)` 整个 binding（第 13-29 行那段）。
- 清理因此不再使用的 import：`readFile`（node:fs/promises）、`BrowserWindow`、`dialog`（electron）、`createLogger` + `const log`（pick 删后无 log 调用）、`AvatarPickResult` type（set binding 不显式标注、由 storeAvatar 推导）。删后文件应只剩 `C`、`getDb`、`storeAvatar`/`resetAvatar`、`bind/register/Binding` 的 import + set/reset 两个 binding + `registerAgentHandlers`。

- [ ] **Step 3: 删 preload**

`src/preload-api.ts`：删 `pickAvatar: inv(C.agentPickAvatar),` 整行。

- [ ] **Step 4: typecheck + 全量测试 + lint**

Run: `pnpm typecheck && pnpm test && pnpm lint`
Expected: PASS（无 `agentPickAvatar` 残留引用；oxlint 无 unused import 报错；`bindings-coverage` 仍过——agentBindings 现含 set+reset）。

- [ ] **Step 5: Commit**

```bash
git add src/shared/ipc.ts src/main/ipc/agent-handlers.ts src/preload-api.ts
git commit -m "refactor(ipc): remove obsolete agent:pick-avatar dialog path (#85)"
```

---

## Task 7: i18n + 全量校验 + 冒烟

**Files:** i18n locales（生成）

- [ ] **Step 1: 抽取 i18n key**

Run: `pnpm i18n:extract`
Expected: 新 key（`settings.agent.avatarCropTitle` / `avatarZoom` / `avatarReadFailed`）写入 zh-CN；其余既有 key 不动。

- [ ] **Step 2: 补全 en.ts 英文**

`src/shared/i18n/locales/en.ts`：把新增的三个 key 填英文（extract 默认留空——见 #84 的坑）：

```ts
  "settings.agent.avatarCropTitle": "Crop avatar",
  "settings.agent.avatarReadFailed": "Couldn't read the image",
  "settings.agent.avatarZoom": "Zoom",
```

（放在 `settings.agent.*` 既有键的字母序位置；不要再跑 `i18n:extract`，以免覆盖回空。）

- [ ] **Step 3: 全量校验**

Run: `pnpm typecheck && pnpm lint && pnpm test && pnpm format:check`
Expected: 全 PASS（format 若 fail 跑 `pnpm format`，注意 memory `oxfmt-regex-unicode-mangling`）。
Run: `pnpm i18n:lint`
Expected: 仅既有的 4 个 pre-existing 无关报错（ErrorBoundary/StreakCard/PdfReader），无新增。

- [ ] **Step 4: 真机冒烟（手动，pnpm start）**

启动 `pnpm start`，验证：

1. 设置 → 助手 → 上传头像：弹原生文件选择器 → 选一张非正方形图。
2. 裁剪弹窗出现：圆形蒙版、拖拽移动、缩放 slider 生效。
3. 「保存」→ 头像更新为裁剪后的圆形结果；对话内头像同步更新。
4. 「取消」→ 头像不变。
5. 选非图片 / 损坏文件 → toast「无法读取图片」。
6. 「恢复默认」仍正常回落默认头像。

- [ ] **Step 5: 记录冒烟结果**（写入 commit 或 PR 描述；异常则回对应 Task 修复）

- [ ] **Step 6: Commit**

```bash
git add src/shared/i18n/locales
git commit -m "i18n: add avatar crop strings (#85)"
```

---

## Task 8: 开 PR

依赖：PR #84（avatar）需先合并到 main。

- [ ] **Step 1: #84 合并后，rebase 本分支到最新 main**

```bash
git fetch origin
git rebase origin/main
```

解决可能的冲突（avatar commits 已在 main，多被 git 识别为等价而 drop；若 `preferences.test.ts` 等冲突，按并集解，参考上次）。rebase 后 `git log --oneline origin/main..HEAD` 应只剩裁剪 commits。

- [ ] **Step 2: changeset**

新建 `.changeset/avatar-cropping.md`：

```markdown
---
"marginalia": minor
---

Crop the assistant avatar when uploading: pick an image, frame it with a round 1:1 crop (zoom + drag), and only the cropped result is saved.
```

Commit：`git add .changeset/avatar-cropping.md && git commit -m "chore: add changeset for avatar cropping (#85)"`

- [ ] **Step 3: push + 开 PR**

```bash
git push -u origin feat/avatar-crop
gh pr create --repo EurFelux/marginalia --base main \
  --title "feat: crop avatar image on upload (#85)" \
  --body "Implements #85. Upload now opens a react-easy-crop dialog (round 1:1, zoom/drag); cropped output (≤512px png) is stored via the new agent:set-avatar IPC reusing storeAvatar. The main-process agent:pick-avatar dialog path is removed. Depends on #82 (PR #84).

Spec: docs/superpowers/specs/2026-06-15-avatar-image-cropping-design.md

🤖 Generated with [Claude Code](https://claude.com/claude-code)"
```

- [ ] **Step 4: kanban** — 把 #85 挪到 In review（option `df73e18b`，参考 kanban skill）。

---

## Self-Review 结果

- **Spec 覆盖**：§1 触发/input→T5；原图入渲染层(FileReader)→T5；裁剪 UI→T4；出图 canvas ≤512→T2；set-avatar IPC→T3；废弃 pick→T6；依赖→T1；§6 AgentSettings→T5；§7 边界(取消/读失败/校验)→T4+T5+复用 storeAvatar；§8 测试(冒烟为主)→T7；§10 分支 rebase→T8。无遗漏。
- **类型一致**：`getCroppedBlob(imageSrc, area: CropArea): Promise<Uint8Array>`、`Area`（react-easy-crop）→ `CropArea` 结构兼容（x/y/width/height）、`agentSetAvatar` input `Uint8Array` / output `AvatarPickResult`、`onConfirm(bytes: Uint8Array)` 贯穿一致。
- **占位符**：无 TBD；所有组件/工具给了完整代码；i18n 给了具体英文。
- **顺序**：T3 加 set（不删 pick）→ T5 改 AgentSettings 用 set → T6 删 pick，每步 typecheck 绿，无中间断裂。
