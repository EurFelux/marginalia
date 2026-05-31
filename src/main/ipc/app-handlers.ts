import { app } from "electron";
import { z } from "zod";
import { IPC, pingInput, type AppGetInfoResult, type PingResult } from "@shared/ipc";
import { getDb } from "@main/db/instance";
import { getAppInfo, ping } from "@main/app-service";
import { handle } from "@main/ipc/registry";

export function registerAppHandlers(): void {
  handle<{ msg: string }, PingResult>(IPC.ping, pingInput, ping);

  handle<void, AppGetInfoResult>(IPC.appGetInfo, z.undefined() as unknown as z.ZodType<void>, () =>
    getAppInfo(getDb(), app.getVersion()),
  );
}
