# 正文字体切换设计

2026-06-04 · 状态:设计对话已确认,spec 待评审

## 背景与目标

正文目前完全继承 ePub 自带字体——`prefs-to-css.ts` 只生成字号/行距/栏宽规则,不碰 `font-family`。本功能允许用户在阅读偏好中切换正文字体,重点服务中文阅读场景(打包中文阅读字体),同时保留「原书默认」的零干预档位。

**需求决策**(brainstorming 已确认):

- 字体来源:**精选预设字体**(不做系统字体枚举、不做自由输入)
- 打包中文字体:**霞鹜文楷 LXGW WenKai、思源宋体 Noto Serif SC、思源黑体 Noto Sans SC** 三款全打包
- 作用范围:**全局偏好**,加入现有 `readerPrefs`,与字号/行距/栏宽一致
- 资源方案:**@fontsource 切片包 + vite `?inline` 注入 iframe**(方案 A;放弃自管全量 TTF 与在线 CDN)

## 数据模型与持久化

`src/shared/preferences.ts` 的 `readerPrefsSchema` 新增枚举字段:

```ts
export const readerFontFamily = z.enum(["default", "wenkai", "serif", "sans"]);
// readerPrefsSchema 中:
fontFamily: readerFontFamily.default("default"),
```

- **`.default("default")` 是升级兼容的关键**:老用户落盘的旧 readerPrefs JSON 没有该字段,有 default 才能 parse 通过,不会连带重置字号/行距/栏宽。
- `setPreferenceInput` 的 `readerPrefs` arm 复用同一 schema,**无需新 IPC 通道**;「store → persist → DB → hydrate」流水线零改动。
- 渲染层 `PREFS_INITIAL` 补 `fontFamily: "default"`。

## 字体栈映射与 CSS 生成

`prefsToCss()` 按档位输出(或不输出)font-family 规则:

| 档位          | 字体栈                                                      | 说明                                         |
| ------------- | ----------------------------------------------------------- | -------------------------------------------- |
| `default`     | (不输出规则)                                                | 零干预,维持现状,**默认值**                   |
| `wenkai` 文楷 | `"LXGW WenKai", "Songti SC", serif`                         | 文楷自带拉丁字形,中西混排风格统一            |
| `serif` 宋体  | `"Fraunces Variable", "Noto Serif SC", Georgia, serif`      | 西文走 Fraunces、中文走思源宋,与壳层衬线呼应 |
| `sans` 黑体   | `"Manrope Variable", "Noto Sans SC", system-ui, sans-serif` | 西文 Manrope + 中文思源黑                    |

覆盖策略(仅在非 `default` 档输出):

```css
body,
body * {
  font-family: <栈> !important;
}
body :is(code, pre, samp, kbd),
body :is(code, pre) * {
  font-family: ui-monospace, SFMono-Regular, Menlo, monospace !important;
}
```

- ePub 常在元素上直接设 `font-family`,故需 `body *` + `!important` 全覆盖(与现有 lineHeight 覆盖同理)。
- **code/pre 例外恢复等宽**,避免代码块被正文字体破坏。
- 已知 trade-off:使用 icon font 的 ePub 在强制字体下图标会变豆腐——默认档不干预,用户主动换字体才有此风险,主流阅读器(Apple Books 等)同此处理。

## 字体资源加载

新增依赖:`@fontsource/lxgw-wenkai`、`@fontsource/noto-serif-sc`、`@fontsource/noto-sans-sc`(各引 400 + 700 两个 weight;serif 档另补 Fraunces 的 italic CSS——正文 `<em>` 常见,可变包默认只含 normal style)。

新建 `src/renderer/reader/reader-fonts.ts` 作为字体档位单一源:

- 每档元数据:i18n label key、CSS 字体栈、所需 `?inline` @font-face CSS 块。
- **只拼接当前选中档的 @font-face 进 `styleCss`**——中文切片 CSS 文本约百 KB,每个 section iframe 的 srcdoc 都内联一份,不能四档全塞;`default` 档一个字节都不加。
- 主文档(ReaderPrefs 浮窗的字体预览)同样 import 对应 fontsource CSS。

@fontsource 中文包按 unicode-range 切成上百个小 woff2,浏览器只下载文本实际命中字形所在的切片——声明数百条 @font-face 几乎零成本,实现按需加载(全量 TTF 方案做不到)。

## UI(ReaderPrefs 浮窗)

在现有「字号/行距/栏宽」三行下方加「字体」一行:4 个分段按钮,**每个按钮用自家字体渲染 label**(所见即所得预览)。label 走 i18next(原书默认 / 文楷 / 宋体 / 黑体)。交互复用 `updatePrefs({ fontFamily })`,无新状态管理。

## 测试与重排

- `prefsToCss` 纯函数 vitest:各档输出正确 font-family 规则、code/pre 例外存在、`default` 档不含 font-family。
- schema 回归测试:**不带 fontFamily 的旧 JSON parse 成功且得 `"default"`**。
- 换字体后的高度重测天然兼容:SectionFrame 已有 `fonts.ready` 等待 + ResizeObserver debounce 重测;styleCss 变化触发 srcdoc 重建,与现有改字号行为一致。
- UI 冒烟:dev 启动验证 + 打包冒烟(按既有惯例须含真启动)。

## 风险与验证点

1. **srcdoc iframe 的字体 URL 解析**(最大风险):`?inline` CSS 中 vite rebase 后的 `url()` 在 srcdoc iframe(base 继承父文档)下,dev(`http://localhost`)与 prod(`file://` + asar)两种环境都要能解析加载。实现计划须先安排 spike 验证,再做全量。
2. **安装包体积**:三款中文字体 × 两 weight 的切片全集进产物,预计增量 **30-45MB**(打包三款中文字体的固有代价,已接受)。
3. **打包白名单**:字体文件经 vite 管线落在 `.vite/renderer/assets/`,在 `packagerConfig.ignore` 白名单的 `.vite/` 放行范围内,无需新增条目;打包冒烟时确认字体实际加载。
