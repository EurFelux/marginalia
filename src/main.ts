import { app, BrowserWindow, net, shell } from "electron";
import path from "node:path";
import started from "electron-squirrel-startup";
import { initDb, getDb } from "@main/db/instance";
import { initAppService } from "@main/app/app-service";
import { setModelFetch } from "@main/ai/model-factory";
import { getPreference } from "@main/preferences/repository";
import { initMainI18n } from "@main/i18n";
import { resolveInitialLanguage } from "@shared/i18n/language";
import { createLogger } from "@main/logger";
import { registerAppHandlers } from "@main/ipc/app-handlers";
import { registerLibraryHandlers } from "@main/ipc/library-handlers";
import { registerSettingsHandlers } from "@main/ipc/settings-handlers";
import { registerChatHandlers } from "@main/ipc/chat-handlers";
import { registerAiHandlers } from "@main/ipc/ai-handlers";
import { registerLogHandlers } from "@main/ipc/log-handlers";
import { registerAnnotationHandlers } from "@main/ipc/annotations-handlers";
import { registerBookNotesHandlers } from "@main/ipc/book-notes-handlers";
import { registerPreferenceHandlers } from "@main/ipc/preferences-handlers";
import { registerStatsHandlers } from "@main/ipc/stats-handlers";
import { registerBackupHandlers } from "@main/ipc/backup-handlers";
import { registerMemoryHandlers } from "@main/ipc/memory-handlers";
import { registerAgentHandlers } from "@main/ipc/agent-handlers";
import { initReadingClock, bindWindowToClock } from "@main/stats/clock-wiring";
import { registerCoverProtocol, registerCoverProtocolScheme } from "@main/library/cover-protocol";
import { registerMediaProtocol, registerMediaProtocolScheme } from "@main/media/media-protocol";
import { maybeSeedSampleBook } from "@main/onboarding/seed-sample";
import { appService } from "@main/app";

// dev 与 production 各用独立的 userData 目录（分库，避免两环境互相污染数据）。
// 必须在任何 app.getPath("userData") 调用前生效（instance.ts 在 app.ready 才首次读取）。
if (!app.isPackaged) {
  app.setName(`${app.getName()}-dev`); // marginalia → marginalia-dev
}

// AppService 注入：Electron 环境/能力的适配器实现止步于此（业务面向 appService 抽象）。
// 必须在 setName 之后（dataDir 跟随 dev/prod 隔离）、一切消费方之前；
// fail-fast——初始化失败直接崩，不带病运行，下游消费零判空零降级。
initAppService({
  dataDir: app.getPath("userData"),
  isDev: !app.isPackaged,
  openFolder: async (dir) => {
    await shell.openPath(dir); // 错误信息字符串在适配器层吞掉——打开文件夹失败不致命
  },
});

const appLog = createLogger("app");
const windowLog = createLogger("window");
const dbLog = createLogger("db");

// 主进程兜底错误钩子：未捕获异常/拒绝必须留痕（fail-fast 崩溃前的最后一笔日志）
const processLog = createLogger("process");
process.on("uncaughtException", (err) => {
  processLog.error("uncaught exception", err);
  process.exit(1); // 保持 fail-fast：留痕后照常崩溃，不带病运行
});
process.on("unhandledRejection", (reason) => {
  processLog.error("unhandled rejection", reason);
});

// Handle creating/removing shortcuts on Windows when installing/uninstalling.
if (started) {
  app.quit();
}

// cover:// 自定义协议：scheme 注册须在 app.ready 前。
registerCoverProtocolScheme();
registerMediaProtocolScheme(); // media:// scheme 注册须在 app.ready 前

function isExternalUrl(url: string): boolean {
  try {
    const protocol = new URL(url).protocol;
    return protocol === "http:" || protocol === "https:" || protocol === "mailto:";
  } catch {
    return false;
  }
}

const createWindow = () => {
  // Create the browser window.
  const mainWindow = new BrowserWindow({
    width: 800,
    height: 600,
    webPreferences: {
      preload: path.join(__dirname, "preload.js"),
    },
  });

  // and load the index.html of the app.
  if (MAIN_WINDOW_VITE_DEV_SERVER_URL) {
    void mainWindow.loadURL(MAIN_WINDOW_VITE_DEV_SERVER_URL).catch((err: unknown) => {
      windowLog.error("loadURL failed", err);
    });
  } else {
    void mainWindow
      .loadFile(path.join(__dirname, `../renderer/${MAIN_WINDOW_VITE_NAME}/index.html`))
      .catch((err: unknown) => {
        windowLog.error("loadFile failed", err);
      });
  }

  mainWindow.webContents.setWindowOpenHandler(({ url }) => {
    if (isExternalUrl(url)) {
      void shell.openExternal(url);
      return { action: "deny" };
    }
    return { action: "deny" };
  });
  mainWindow.webContents.on("will-navigate", (event, url) => {
    const isAppUrl = MAIN_WINDOW_VITE_DEV_SERVER_URL
      ? url.startsWith(MAIN_WINDOW_VITE_DEV_SERVER_URL)
      : url.startsWith("file:");
    if (isAppUrl) return;
    event.preventDefault();
    if (isExternalUrl(url)) void shell.openExternal(url);
  });

  bindWindowToClock(mainWindow);

  // Open the DevTools.
  if (MAIN_WINDOW_VITE_DEV_SERVER_URL) {
    mainWindow.webContents.openDevTools();
  }
};

// This method will be called when Electron has finished
// initialization and is ready to create browser windows.
// Some APIs can only be used after this event occurs.
app.on("ready", async () => {
  // 会话开始标记：每次启动在日志里留一条锚点（排障时定位「这次启动」的边界）
  appLog.info(`marginalia ${app.getVersion()} started`);
  try {
    initDb();
  } catch (err) {
    dbLog.error("failed to initialize", err);
    app.quit();
    return;
  }
  // 主进程 i18n：读已存语言偏好（null → undefined 退系统 locale 匹配）
  // 首启语言解析一次，i18n 与样书播种共用（书与界面语言一致）
  const lang = resolveInitialLanguage(
    getPreference(getDb(), "language") ?? undefined,
    app.getLocale(),
  );
  initMainI18n(lang);
  // AI 出站请求默认走系统代理：Electron net.fetch 经 Chromium 网络栈，默认采用系统代理设置。
  // （部分地区直连 api.anthropic.com 会被 403「Request not allowed」按区域拦截，须经系统代理出网。）
  setModelFetch((input, init) => net.fetch(input instanceof URL ? input.toString() : input, init));
  registerCoverProtocol(); // cover:// handler 需 getDb()，故在 initDb 后
  registerMediaProtocol(); // media:// handler 需 getDb()，故在 initDb 后
  registerAppHandlers();
  registerLibraryHandlers();
  registerSettingsHandlers();
  registerChatHandlers();
  registerAnnotationHandlers();
  registerBookNotesHandlers();
  registerPreferenceHandlers();
  registerAgentHandlers();
  registerAiHandlers();
  registerLogHandlers();
  registerStatsHandlers();
  registerBackupHandlers();
  registerMemoryHandlers();
  initReadingClock();
  // 首启自动导入内置样书（幂等；建窗前完成，使首帧渲染时书已在库）
  await maybeSeedSampleBook(getDb(), lang, appService.getPath("booksDir"));
  createWindow();
});

// Quit when all windows are closed, except on macOS. There, it's common
// for applications and their menu bar to stay active until the user quits
// explicitly with Cmd + Q.
app.on("window-all-closed", () => {
  if (process.platform !== "darwin") {
    app.quit();
  }
});

app.on("activate", () => {
  // On OS X it's common to re-create a window in the app when the
  // dock icon is clicked and there are no other windows open.
  if (BrowserWindow.getAllWindows().length === 0) {
    createWindow();
  }
});

// In this file you can include the rest of your app's specific main process
// code. You can also put them in separate files and import them here.
