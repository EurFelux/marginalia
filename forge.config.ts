import type { ForgeConfig } from "@electron-forge/shared-types";
import type { OsxSignOptions } from "@electron/packager";
import { MakerSquirrel } from "@electron-forge/maker-squirrel";
import { MakerZIP } from "@electron-forge/maker-zip";
import { MakerDMG } from "@electron-forge/maker-dmg";
import { MakerDeb } from "@electron-forge/maker-deb";
import { MakerRpm } from "@electron-forge/maker-rpm";
import { VitePlugin } from "@electron-forge/plugin-vite";
import { AutoUnpackNativesPlugin } from "@electron-forge/plugin-auto-unpack-natives";
import { FusesPlugin } from "@electron-forge/plugin-fuses";
import { PublisherGithub } from "@electron-forge/publisher-github";
import { FuseV1Options, FuseVersion } from "@electron/fuses";

// better-sqlite3 是 native 模块、被 vite.main.config external（不能内联）；其余 prod 依赖的代码都被
// Vite bundle 进 .vite/，运行时只需 better-sqlite3 的实体包（require 链 → bindings → file-uri-to-path）。
// pdf 支持：pdfjs-dist（主进程 legacy 解析）与 @napi-rs/canvas（NAPI 原生件）同被 external，
// 须随产物分发。@napi-rs 平台二进制是与主包平级的独立包（@napi-rs/canvas-<platform>-<arch>），
// startsWith 匹配带尾斜杠不命中它们，故逐个列出（当前仅打 macOS 包）。
const KEEP_NODE_MODULES = [
  "better-sqlite3",
  "bindings",
  "file-uri-to-path",
  "pdfjs-dist",
  "@napi-rs/canvas",
  "@napi-rs/canvas-darwin-arm64",
  "@napi-rs/canvas-darwin-x64",
];

// ad-hoc 重签名（零成本，无 Apple Developer 证书）：packager 改写 Info.plist/塞 asar 后，Electron
// 出厂签名的 seal 已失效；不重签的话，带 quarantine 的下载产物会被 Gatekeeper 直接判「已损坏」
// 且无放行入口。ad-hoc 重签让 seal 重新有效，Gatekeeper 文案变为「无法验证开发者」，用户可在
// 系统设置 → 隐私与安全性 放行（正规分发需 Developer ID 签名 + 公证，留待后续）。
// continueOnError 是 packager 运行时支持但输入类型漏收录的字段（dist/mac.js createSignOpts），
// 故用交叉类型而非 any。
const osxSign: OsxSignOptions & { continueOnError?: boolean } = {
  identity: "-", // codesign 的 ad-hoc 身份
  identityValidation: false, // "-" 不在 keychain 里，跳过查找（否则 findIdentities 报错）
  preAutoEntitlements: false, // 该步骤从 identity 名提取 TeamID，ad-hoc 无 TeamID 会 throw
  // osx-sign 默认开 hardened runtime（为公证准备），但其 library validation 要求库与主程序
  // 同 Team ID——ad-hoc 签名没有 Team ID，dyld 拒载自家 Electron Framework（"different
  // Team IDs"）启动即崩；ad-hoc 分发本就过不了公证，hardened 零收益，关掉。
  optionsForFile: () => ({ hardenedRuntime: false }),
  continueOnError: false, // packager 默认 true 会吞掉签名失败、静默产出坏产物
};

const config: ForgeConfig = {
  packagerConfig: {
    asar: true,
    // 不带扩展名：Packager 按平台自动补 .icns（macOS）/.ico（Windows）。当前仅生成了 .icns（见
    // scripts/make-icons.sh，源 assets/icon.svg）；Windows/Linux 分发时再补 .ico/.png 与 maker 配置。
    icon: "./assets/icons/icon",
    // 迁移 SQL 不经 Vite 打包；复制整个迁移目录进 resources/，生产启动经 process.resourcesPath 读取（见 instance.ts）。
    extraResource: ["./src/main/db/migrations"],
    osxSign,
    // Forge Vite plugin 默认令 ignore 排除「除 .vite/ 外一切」（含整个 node_modules），会丢掉被
    // external 的 better-sqlite3。它检测到 ignore 已是函数便不覆盖（见 plugin-vite resolveForgeConfig）。
    // 这里保留 .vite/ 与 native 运行时子树，其余 node_modules 文件一律忽略（其代码已 bundle 进 .vite，
    // 实体源码对运行无用）——避免把 ~300 个 prod dep 的完整源码塞进 asar（实测 15M vs 放行全量的 334M）。
    // native 的 .node 再由 plugin-auto-unpack-natives 解包出 asar 才能 dlopen。
    ignore: (file: string): boolean => {
      if (!file) return false;
      if (file.startsWith("/.vite")) return false;
      if (file === "/node_modules") return false;
      return !KEEP_NODE_MODULES.some(
        (pkg) =>
          file === `/node_modules/${pkg}` ||
          file.startsWith(`/node_modules/${pkg}/`) ||
          // packager 自顶向下遍历：scope 目录（如 /node_modules/@napi-rs）是白名单项的
          // 祖先，不放行则整个子树被剪枝、子包永远轮不到匹配（@napi-rs/canvas 实测中招）。
          `/node_modules/${pkg}`.startsWith(`${file}/`),
      );
    },
  },
  rebuildConfig: {},
  makers: [
    new MakerSquirrel({}),
    // macOS 分发主形态：DMG（默认 ULFO 压缩格式，仅能在 macOS 上构建）；ZIP 保留作备用/自动更新源。
    new MakerDMG({}),
    new MakerZIP({}, ["darwin"]),
    new MakerRpm({}),
    new MakerDeb({}),
  ],
  publishers: [
    // 发布到 GitHub Release：draft 先上传草稿（网页补 notes 后手动发布），0.x 阶段一律标 prerelease。
    // token 经 GITHUB_TOKEN 注入（见 package.json 的 release script，从 gh keyring 现取不落盘）。
    new PublisherGithub({
      repository: { owner: "EurFelux", name: "marginalia" },
      prerelease: true,
      draft: true,
    }),
  ],
  plugins: [
    new VitePlugin({
      // `build` can specify multiple entry builds, which can be Main process, Preload scripts, Worker process, etc.
      // If you are familiar with Vite configuration, it will look really familiar.
      build: [
        {
          // `entry` is just an alias for `build.lib.entry` in the corresponding file of `config`.
          entry: "src/main.ts",
          config: "vite.main.config.ts",
          target: "main",
        },
        {
          entry: "src/preload.ts",
          config: "vite.preload.config.ts",
          target: "preload",
        },
      ],
      renderer: [
        {
          name: "main_window",
          config: "vite.renderer.config.ts",
        },
      ],
    }),
    // 把含 *.node 的 native 模块从 asar 解包到 app.asar.unpacked，使 better_sqlite3.node 可 dlopen。
    new AutoUnpackNativesPlugin({}),
    // Fuses are used to enable/disable various Electron functionality
    // at package time, before code signing the application
    new FusesPlugin({
      version: FuseVersion.V1,
      [FuseV1Options.RunAsNode]: false,
      // 必须关闭（模板默认 true 的残留）：开启时 Chromium 启动即初始化 Safe Storage（macOS 钥匙串），
      // 而 ad-hoc 签名每次构建都变 → 钥匙串 ACL 不认 → 每个新版本首启弹密码授权，且授权阻塞窗口内
      // 首次 loadFile 以 ERR_FAILED 白屏（重开即好）。本 app 无 cookie 加密需求（无登录态；API key
      // 明文落库，钥匙串已整体退役，见 2026-06-04 plaintext spec）。
      [FuseV1Options.EnableCookieEncryption]: false,
      [FuseV1Options.EnableNodeOptionsEnvironmentVariable]: false,
      [FuseV1Options.EnableNodeCliInspectArguments]: false,
      [FuseV1Options.EnableEmbeddedAsarIntegrityValidation]: true,
      [FuseV1Options.OnlyLoadAppFromAsar]: true,
    }),
  ],
};

export default config;
