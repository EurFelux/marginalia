# Unpacked EPUB Directory Import — Design

**Issue:** 待建（kanban backlog）
**Date:** 2026-06-11
**Source:** brainstorming 会话 2026-06-11（用户从 Apple Books 导出的 `.epub` 导入报 `EISDIR`）

## 1. 目标与非目标

**目标**：当用户导入的「书」在磁盘上其实是一个**未打包的 EPUB 目录**（OCF 解包形态：`mimetype` + `META-INF/container.xml` + 内容文件）时，自动在内存里把它打包成标准 EPUB zip 字节，再走现有 `importBook` 流程——用户拖入/选择后**无感成功**，不再撞 `EISDIR`。

**非目标**：

- **不**识别任何 Apple 私有标记（`com.apple.ibooks.epub` UTI / `com.apple.iBooks.*` xattr）——识别只认 EPUB 规范的通用标志 `META-INF/container.xml`，从而同时覆盖 Apple Books / Calibre / Sigil 工作目录 / 手动 `unzip` 等所有来源。
- **不**改文件选择器对话框。macOS 把 package 目录在 `openFile` 面板里当文件、可直接选中并返回目录路径；普通解包文件夹走拖拽导入（任意路径都汇入同一入口）。「让 openFile 面板能选普通文件夹」非目标。
- **不**处理「目录形态的 PDF」——PDF 不是 package/容器格式，目录化无意义。
- **不**主动 `brctl download` 强制 materialize dataless 占位文件——依赖内核在 `open()` 时透明下载；下载不到则诚实报错（见 §5）。

## 2. 背景与关键发现

EPUB 本质是 ZIP（OCF ZIP Container）。某些来源会把它**解包成同名目录**，再靠 macOS 的 **package 机制**让 Finder 显示成单个文件：

- **Apple Books 导出**：打 `com.apple.ibooks.epub` UTI，该 UTI `conforms to com.apple.package` → Finder 显示成单文件、双击直接打开，但 POSIX 层是 `S_IFDIR`。Node `readFile(dir)` → `EISDIR`（**E**rror **IS** a **DIR**ectory），即用户原始报错。
- **File Provider 占位符（本次实测发现）**：该目录带 `com.apple.fileprovider.fpfs#P` xattr，内容是 File Provider 托管的 **dataless placeholder**——`stat`/`readdir` 看得到元数据，真正 `open()` 时内核才阻塞下载；空间紧张或来源失联会被**驱逐（dematerialize）甚至整项消失**（本次会话中目录在数分钟内从「内容可列」→「文件 ENOENT」→「整个目录消失」）。

**对设计的约束**：递归读目录内容时，单个文件可能 ENOENT / 下载失败。`packEpubDir` **绝不能产出半成品 zip**——任一读失败必须整体抛清晰错误，让用户得到「这本没导进来 + 为什么 + 怎么办」，而非一本残缺的书。

## 3. 关键架构事实（实现据此）

- **导入链路全程「字节进」**：`libraryImport(filePath)`（`src/main/ipc/library-handlers.ts`）→ `readFile` 得 bytes → `importBook(db, { bytes, fileName })`（`src/main/library/repository.ts`）→ `detectFormat(bytes)`（魔数嗅探：`%PDF-`→pdf，`PK`→epub）→ `parseEpub(bytes)` → `writeBookFile(bytes)`（app 自留副本）。**下游只认 bytes，全部可原样复用**。
- **单一汇流入口**：拖拽导入与文件选择器都最终调 `libraryImport(filePath)`。故只需在此入口把「目录」转成「zip 字节」，**无需在多处接线**。
- **`detectFormat` 无需改**：`packEpubDir` 产出标准 zip（`PK\x03\x04` 头），魔数嗅探天然判为 epub。
- **fflate 已是直接依赖**（`package.json`，onboarding 样书引入）：`zipSync({ name: [bytes, { level: 0 }] | bytes })`，object key 即写入顺序、可逐条目设压缩级别。epub-parser 测试已用同款 `zipSync({ mimetype: [strToU8("application/epub+zip"), { level: 0 }], ... })`，本设计沿用该惯例。
- **`writeBookFile` 顺手规整**：存进 app 的是**打包好的标准 zip**，等于把这本「散装书」收成一份干净 epub 副本。

## 4. 设计：数据流与 `packEpubDir`

入口分支（`libraryImport`，仅此一处改动）：

```
libraryImport(filePath)
  └─ bytes = readBookBytes(filePath)          ← 新建，替换原 readFile+catch
       ├─ stat(filePath).isFile()      → readFile(filePath) 得 bytes（现有行为）
       ├─ stat(filePath).isDirectory() → packEpubDir(filePath) 得 zip bytes
       └─ 其它（不存在/特殊文件）       → 抛友好错误
  └─ importBook(db, { bytes, fileName: basename(filePath) })   ← 不变
  └─ writeBookFile(booksDir, id, format, bytes)                ← 不变
```

`packEpubDir(dirPath): Uint8Array`（纯 fs + fflate，无 Electron，可 headless 单测）：

1. **校验是合法 EPUB 目录**：`META-INF/container.xml` 不存在 → 抛「不是合法的 EPUB 目录（缺 `META-INF/container.xml`）」。
2. **递归收集**所有文件相对路径（跳过 `.DS_Store` 与点文件噪声；目录结构保留，路径分隔统一为 `/`）。
3. **逐个读字节**；**任一 `readFileSync` 失败**（ENOENT / EACCES / dataless 下载失败）→ 抛「无法读取 EPUB 目录内容（可能是 iCloud/Apple Books 尚未下载到本地的占位文件），请确保文件已下载到本地后重试」，**不继续打包**。
4. **构建 fflate 条目**：`mimetype` 作**第一个 key** 且 `{ level: 0 }`（OCF 硬要求：首条目、存储不压缩）；其余默认 deflate。
5. `return zipSync(entries)`。

**错误信息语言**：代码内 `throw new Error(...)` 的实际文案**用英文**，与主进程既有 `Cannot read book file at …` 一致（本 spec §4/§5 的中文短句仅表意图，非最终文案）。错误最终经 IPC registry catch-all 落盘并冒泡到渲染层。

## 5. 错误处理（三类，均诚实可操作）

| 情形                                         | 行为                                                                    |
| -------------------------------------------- | ----------------------------------------------------------------------- |
| 普通文件读失败                               | 沿用现有 `Cannot read book file at "<path>": <code>` 透传               |
| 目录但缺 `META-INF/container.xml`            | 抛「不是合法的 EPUB 目录」——区别于「读不到」，告诉用户这压根不是本 epub |
| 目录合法但内容读不到（dataless/驱逐/ENOENT） | 抛「无法读取 EPUB 目录内容…请下载后重试」，**绝不产出半成品 zip**       |

## 6. 模块与文件

| 文件                                     | 责任                                                                                                                                                                                                                                                                                                                                                                                                                                                                       | 动作   |
| ---------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------ |
| `src/main/library/import-source.ts`      | `packEpubDir(dirPath): Uint8Array`（§4）+ `readBookBytes(filePath): Promise<Uint8Array>`（stat 分支：文件→readFile、目录→packEpubDir、其它→报错）。纯 fs+fflate，不引 Electron。                                                                                                                                                                                                                                                                                           | Create |
| `src/main/library/import-source.test.ts` | headless（同 `book-files.test.ts` 用 `mkdtempSync` 造真实临时目录）：① 造含 `mimetype`/`META-INF/container.xml`/`OEBPS` 的目录 → `packEpubDir` → 断言产出 `PK` 头、`detectFormat` 判 epub、`parseEpub` 能解出元数据、mimetype 条目居首且未压缩；② 缺 container.xml 的目录 → 抛「不是合法 EPUB 目录」；③ 读失败路径（如内含**断裂 symlink** 触发 `readFileSync` ENOENT）→ 抛「无法读取」且不返回 zip；④ `readBookBytes` 对普通 zip 文件原样返回字节、对目录走 packEpubDir。 | Create |
| `src/main/ipc/library-handlers.ts`       | `libraryImport` 内把 `readFile(...).catch(...)` 替换为 `await readBookBytes(input.filePath)`；其余（importBook / writeBookFile / log / toDto）不变。                                                                                                                                                                                                                                                                                                                       | Modify |

## 7. 测试策略

- **主力 headless 单测**：`import-source.test.ts`（§6），覆盖正常打包往返 + 三类错误分支，全部用真实临时目录、不依赖 Electron / File Provider。
- **dataless 不可直造**：单测以「断裂 symlink → readFileSync ENOENT」确定性地覆盖「读失败 → 整体抛错、不产半成品」这条健壮性路径（等价于占位文件读不到）。
- **手动冒烟（可选）**：若手头有 Apple Books 导出的 package `.epub` 且内容已 materialize，`pnpm start` 后拖入应成功导入并能开书读正文（参照 importbook 冒烟须真开书读正文的既有约束）。

## 8. 验收标准

- 把一个未打包 EPUB 目录（含合法 OCF 结构）经导入入口送入，能成功导入、列入书库、可开书读正文。
- 缺 `META-INF/container.xml` 的目录、内容读不到的目录，分别得到对应的可读错误，且**不**产生残缺书行。
- 普通 `.epub` / `.pdf` 文件导入行为零回归。
- `pnpm test` 全绿、`pnpm typecheck` 无错。
