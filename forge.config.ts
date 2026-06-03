import type { ForgeConfig } from "@electron-forge/shared-types";
import { MakerSquirrel } from "@electron-forge/maker-squirrel";
import { MakerZIP } from "@electron-forge/maker-zip";
import { MakerDeb } from "@electron-forge/maker-deb";
import { MakerRpm } from "@electron-forge/maker-rpm";
import { VitePlugin } from "@electron-forge/plugin-vite";
import { AutoUnpackNativesPlugin } from "@electron-forge/plugin-auto-unpack-natives";
import { FusesPlugin } from "@electron-forge/plugin-fuses";
import { FuseV1Options, FuseVersion } from "@electron/fuses";

// better-sqlite3 是 native 模块、被 vite.main.config external（不能内联）；其余 prod 依赖的代码都被
// Vite bundle 进 .vite/，运行时只需 better-sqlite3 的实体包（require 链 → bindings → file-uri-to-path）。
const KEEP_NODE_MODULES = ["better-sqlite3", "bindings", "file-uri-to-path"];

const config: ForgeConfig = {
  packagerConfig: {
    asar: true,
    // 迁移 SQL 不经 Vite 打包；复制整个迁移目录进 resources/，生产启动经 process.resourcesPath 读取（见 instance.ts）。
    extraResource: ["./src/main/db/migrations"],
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
        (pkg) => file === `/node_modules/${pkg}` || file.startsWith(`/node_modules/${pkg}/`),
      );
    },
  },
  rebuildConfig: {},
  makers: [new MakerSquirrel({}), new MakerZIP({}, ["darwin"]), new MakerRpm({}), new MakerDeb({})],
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
      [FuseV1Options.EnableCookieEncryption]: true,
      [FuseV1Options.EnableNodeOptionsEnvironmentVariable]: false,
      [FuseV1Options.EnableNodeCliInspectArguments]: false,
      [FuseV1Options.EnableEmbeddedAsarIntegrityValidation]: true,
      [FuseV1Options.OnlyLoadAppFromAsar]: true,
    }),
  ],
};

export default config;
