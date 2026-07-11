#!/usr/bin/env node
/**
 * 临时性能实验脚本：向 dev DB 的某个 conversation 批量灌入合成消息。
 *
 * 运行方式（必须用项目内的 Electron 二进制，因为 better-sqlite3 编的是 Electron ABI 145）：
 *   ELECTRON_RUN_AS_NODE=1 ./node_modules/.bin/electron scripts/seed-long-conversation.mjs --count 200
 *   （不要用 pnpx electron——它会解析到不同版本，ABI 不匹配。）
 *
 * 默认会新建一个 library（bookId IS NULL）会话；如要追加到已有会话：
 *   ELECTRON_RUN_AS_NODE=1 pnpx electron scripts/seed-long-conversation.mjs --count 50 --conversation <uuid>
 *
 * 删除测试数据：直接 rm ~/Library/Application\ Support/marginalia-dev/marginalia.db* 即可（dev 库可随意折腾）。
 */
import Database from "better-sqlite3";
import { v7 as uuidv7 } from "uuid";
import os from "node:os";
import path from "node:path";

const HOME = os.homedir();
const IS_MAC = process.platform === "darwin";
const IS_WIN = process.platform === "win32";

function devDataDir() {
  if (IS_MAC) return path.join(HOME, "Library", "Application Support", "marginalia-dev");
  if (IS_WIN) return path.join(HOME, "AppData", "Roaming", "marginalia-dev");
  // Linux + fallback
  const xdg = process.env.XDG_CONFIG_HOME;
  if (xdg) return path.join(xdg, "marginalia-dev");
  return path.join(HOME, ".config", "marginalia-dev");
}

const DB_PATH = path.join(devDataDir(), "marginalia.db");

const args = process.argv.slice(2);
function flag(name, fallback) {
  const i = args.indexOf(name);
  return i !== -1 ? args[i + 1] : fallback;
}
function hasFlag(name) {
  return args.includes(name);
}

const count = Number(flag("--count", "200"));
const conversationId = flag("--conversation", null);
const complexity = flag("--complexity", "mixed"); // short | long | code | mixed
const clear = hasFlag("--clear"); // 清空目标会话已有消息（重新灌）

if (!Number.isFinite(count) || count <= 0) {
  console.error("--count 必须是正整数");
  process.exit(1);
}

console.log(`DB: ${DB_PATH}`);
console.log(
  `Seeding ${count} messages (complexity=${complexity}, conversation=${conversationId ?? "new"})`,
);

const db = new Database(DB_PATH);
db.pragma("journal_mode = WAL");
db.pragma("foreign_keys = ON");

function nowMs() {
  return Date.now();
}

const SHORT_USER = [
  "这本书讲了什么？",
  "能再详细说说吗？",
  "我不太明白这段。",
  "作者想表达什么？",
  "这和前面一章有什么联系？",
  "帮我总结一下核心观点。",
  "有没有相反的例子？",
];

const SHORT_ASSISTANT = [
  "好的，我来梳理一下。",
  "这一段的关键在于……",
  "我们可以从三个层面理解。",
  "作者其实是在回应某种批评。",
  "让我用一个例子说明。",
];

const LONG_PARAGRAPHS = [
  `虚拟化列表的性能收益来自「只渲染视口内元素」这一核心思想。当 DOM 节点数量从数百降到十几个时，浏览器在滚动、重排、重绘上的开销会大幅下降。然而，虚拟化并非银弹：对于高度不固定的列表项，需要维护一个测量缓存；对于包含复杂子树（如代码高亮、数学公式）的项，测量和回收的成本可能抵消甚至超过收益。因此，在决定引入虚拟化之前，最好先量化当前实现的瓶颈所在。`,
  `长对话场景下的卡顿通常表现为三类症状：输入框响应延迟、滚动掉帧、以及新消息插入时的白屏或闪烁。输入延迟往往与 React 的重新渲染范围有关；滚动掉帧可能与大量绝对定位或复杂 CSS 有关；而新消息插入时的抖动则常与自动滚动到底部的行为、以及消息内容的异步加载（如图片、代码块高亮）有关。诊断时需要分别测量，而不是简单地把所有问题都归因于「消息太多」。`,
  `在 Electron 41 的渲染进程中，Chromium 的合成器线程负责将页面内容分层并送至 GPU。当主线程被长任务阻塞时，合成器仍可能继续显示旧帧，但无法处理新的输入事件。这意味着即使滚动看起来「不卡」，用户的点击或按键也可能被延迟处理。PerformanceObserver 的 longtask 条目是检测这类问题的有效工具，阈值通常为 50ms。`,
];

const CODE_BLOCKS = [
  `\`\`\`ts\nfunction measure<T>(fn: () => T): { result: T; ms: number } {\n  const start = performance.now();\n  const result = fn();\n  return { result, ms: performance.now() - start };\n}\n\`\`\``,
  `\`\`\`python\ndef chunked(items, size):\n    for i in range(0, len(items), size):\n        yield items[i:i + size]\n\nfor batch in chunked(range(1000), 100):\n    process(batch)\n\`\`\``,
  `\`\`\`css\n.message-list {\n  display: flex;\n  flex-direction: column;\n  gap: 1rem;\n  overflow-y: auto;\n  contain: layout style paint;\n}\n\`\`\``,
];

function pick(arr) {
  return arr[Math.floor(Math.random() * arr.length)];
}

function buildAssistantText() {
  switch (complexity) {
    case "short":
      return pick(SHORT_ASSISTANT);
    case "long":
      return pick(LONG_PARAGRAPHS) + "\n\n" + pick(LONG_PARAGRAPHS);
    case "code":
      return "这里是一个示例：\n\n" + pick(CODE_BLOCKS) + "\n\n" + pick(SHORT_ASSISTANT);
    case "mixed":
    default: {
      const roll = Math.random();
      if (roll < 0.4) return pick(SHORT_ASSISTANT);
      if (roll < 0.7) return pick(LONG_PARAGRAPHS);
      return "参考实现：\n\n" + pick(CODE_BLOCKS) + "\n\n" + pick(SHORT_ASSISTANT);
    }
  }
}

function buildParts(text) {
  return [{ type: "text", text }];
}

let targetConversationId = conversationId;

if (!targetConversationId) {
  const createdAt = nowMs();
  targetConversationId = uuidv7();
  db.prepare(
    `INSERT INTO conversations (id, book_id, title, context_summary, summarized_through_seq, memory_through_seq, created_at, updated_at)
     VALUES (?, NULL, ?, NULL, NULL, NULL, ?, ?)`,
  ).run(targetConversationId, `perf-test-${count}-${complexity}`, createdAt, createdAt);
  console.log(`Created conversation ${targetConversationId}`);
} else {
  const row = db.prepare("SELECT id FROM conversations WHERE id = ?").get(targetConversationId);
  if (!row) {
    console.error(`Conversation ${targetConversationId} not found`);
    process.exit(1);
  }
  console.log(`Using existing conversation ${targetConversationId}`);
}

if (clear) {
  const result = db
    .prepare("DELETE FROM messages WHERE conversation_id = ?")
    .run(targetConversationId);
  console.log(`Cleared ${result.changes} existing messages`);
}

const insert = db.prepare(
  `INSERT INTO messages (id, conversation_id, role, parts, metadata, status, seq, created_at)
   VALUES (?, ?, ?, ?, NULL, 'complete', ?, ?)`,
);

const startSeq =
  (db
    .prepare("SELECT COALESCE(MAX(seq), 0) AS seq FROM messages WHERE conversation_id = ?")
    .get(targetConversationId)?.seq ?? 0) + 1;

const insertMany = db.transaction((items) => {
  for (const item of items) insert.run(item);
});

const batch = [];
const baseTime = nowMs();
for (let i = 0; i < count; i++) {
  const seq = startSeq + i;
  const isUser = i % 2 === 0;
  const role = isUser ? "user" : "assistant";
  const text = isUser ? pick(SHORT_USER) : buildAssistantText();
  const id = uuidv7();
  // 时间戳递增 1s，保持顺序自然
  const createdAt = baseTime + i * 1000;
  batch.push([id, targetConversationId, role, JSON.stringify(buildParts(text)), seq, createdAt]);
}

insertMany(batch);
console.log(`Inserted ${batch.length} messages into conversation ${targetConversationId}`);

db.close();
