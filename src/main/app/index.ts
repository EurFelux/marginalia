/** barrel：仅 re-export appService——消费方唯一入口。
 * initAppService 有意不进 barrel（生命周期钩子，仅 main.ts/测试深导入 app/app-service）。 */
export { appService } from "./app-service";
