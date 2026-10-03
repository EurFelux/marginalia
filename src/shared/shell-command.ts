// src/shared/shell-command.ts —— 命令分析：分词、简单/复合判定、拆段、建议前缀
// （spec 2026-10-03-bash-skills-permissions-design §5.2–§5.4）。纯函数，主进程判定与渲染层审批操作栏共用。
import { parse, quote, type ParseEntry } from "shell-quote";

export interface CommandAnalysis {
  /** 单条命令、只由普通词与引号组成。只有简单命令能被「允许」规则放行。 */
  simple: boolean;
  /** 简单命令的词序列；复合命令为 null。 */
  tokens: string[] | null;
  /** 按控制符切出的各段词序列（尽力而为），供拒绝规则逐段检查。 */
  segments: string[][];
  /** 建议的规则前缀（已规范化）；复合命令为 null。 */
  suggestedPrefix: string | null;
}

/**
 * 原文里出现即不算简单命令的字符。shell-quote 会把换行当空白、把反引号当普通字符、
 * 把双引号里的 `$(…)` 当普通字符串——而 shell 照样执行它们，所以必须先在原文上排除。
 */
const UNSAFE_RAW = /[\n\r`$]/;

/** 拆段用的控制符；重定向等其余运算符不拆段，但同样使命令不再简单。 */
const SEGMENT_OPS = new Set([";", ";;", "&&", "||", "|", "|&", "&", "(", ")", "<(", ">("]);

/** 拒绝规则检查时跳过段首的环境变量赋值（`FOO=1 rm -rf x` 也要被 `rm` 拦下）。 */
const ASSIGNMENT = /^[A-Za-z_][A-Za-z0-9_]*=/;

// 保留 `$NAME` 原样：不让 shell-quote 把变量展开成空串而改变词序列。
const keepVar = (key: string) => `$${key}`;

function entryText(entry: ParseEntry): string | null {
  if (typeof entry === "string") return entry;
  if ("op" in entry && entry.op === "glob") return entry.pattern;
  return null;
}

/** 按控制符切段（尽力而为）：反引号与换行先当成分隔，好让其中的命令也成为段首。 */
function splitSegments(command: string): string[][] {
  const segments: string[][] = [];
  for (const line of command.replace(/`/g, " ; ").split(/\r?\n/)) {
    let current: string[] = [];
    for (const entry of parse(line, keepVar)) {
      const text = entryText(entry);
      if (text !== null) {
        current.push(text);
      } else if (typeof entry === "object" && "op" in entry && SEGMENT_OPS.has(entry.op)) {
        if (current.length > 0) segments.push(current);
        current = [];
      }
    }
    if (current.length > 0) segments.push(current);
  }
  return segments.map(skipAssignments);
}

function skipAssignments(segment: string[]): string[] {
  const start = segment.findIndex((t) => !ASSIGNMENT.test(t));
  return start === -1 ? segment : segment.slice(start);
}

function simpleTokens(command: string): string[] | null {
  if (UNSAFE_RAW.test(command)) return null;
  const tokens: string[] = [];
  for (const entry of parse(command, keepVar)) {
    const text = entryText(entry);
    if (text === null) return null; // 任何运算符、注释
    tokens.push(text);
  }
  return tokens.length > 0 ? tokens : null;
}

/** 词序列 → 规范化前缀文本（每个词按 shell 引用规则转义，单空格连接）。 */
export function formatPattern(tokens: string[]): string {
  return quote(tokens);
}

/** 命令名 + 紧随其后的第一个词（仅当它不以 `-` 开头），否则只取命令名。 */
export function suggestPrefix(tokens: string[]): string {
  const [head, next] = tokens;
  return formatPattern(next !== undefined && !next.startsWith("-") ? [head!, next] : [head!]);
}

export function analyzeCommand(command: string): CommandAnalysis {
  const tokens = simpleTokens(command);
  return {
    simple: tokens !== null,
    tokens,
    segments: tokens ? [skipAssignments(tokens)] : splitSegments(command),
    suggestedPrefix: tokens ? suggestPrefix(tokens) : null,
  };
}

/** 规则前缀文本 → 词序列；不是简单词序列（含运算符、`$` 等）返回 null。 */
export function parsePattern(pattern: string): string[] | null {
  return simpleTokens(pattern.trim());
}

export function isTokenPrefix(prefix: string[], tokens: string[]): boolean {
  return (
    prefix.length > 0 && prefix.length <= tokens.length && prefix.every((t, i) => t === tokens[i])
  );
}
