#!/usr/bin/env node
// 从 CHANGELOG.md 抽取当前 package.json version 的段落,喂给 GitHub Release draft 的 notes。
// 用法: node scripts/release-notes.mjs [--dry-run]
// 防御:版本段缺失/为空、gh 失败(draft 不存在/未认证)都硬退出并透传真实错误;
// 绝不创建 release——forge publish 是唯一创建入口。
import { execFileSync } from "node:child_process";
import { readFileSync } from "node:fs";

const dryRun = process.argv.includes("--dry-run");
const { version } = JSON.parse(readFileSync("package.json", "utf8"));
const changelog = readFileSync("CHANGELOG.md", "utf8");

// 定位 "## <version>" 标题行,截到下一个 "## " 或 EOF
// 精确匹配(或后跟空格),防 "## 0.2.0" 误命中手编的 "## 0.2.01"/"## 0.2.0-beta"
const lines = changelog.split("\n");
const start = lines.findIndex((l) => l === `## ${version}` || l.startsWith(`## ${version} `));
if (start === -1) {
  console.error(
    `CHANGELOG.md has no section for version ${version} — run \`pnpm changeset version\` first`,
  );
  process.exit(1);
}
let end = lines.length;
for (let i = start + 1; i < lines.length; i++) {
  if (lines[i].startsWith("## ")) {
    end = i;
    break;
  }
}
const notes = lines
  .slice(start + 1, end)
  .join("\n")
  .trim();
if (!notes) {
  console.error(`CHANGELOG.md section for ${version} is empty`);
  process.exit(1);
}

if (dryRun) {
  console.log(`--- notes for v${version} ---\n${notes}`);
  process.exit(0);
}

try {
  execFileSync("gh", ["release", "edit", `v${version}`, "--notes-file", "-"], {
    input: notes,
    stdio: ["pipe", "inherit", "inherit"],
  });
} catch (e) {
  // gh 的真实报错已经 stderr inherit 直透;吞掉 node 的 stack 噪音,保留非零退出
  process.exit(e.status ?? 1);
}
console.log(`Notes updated on release v${version}`);
