interface Fence {
  marker: "`" | "~";
  length: number;
  start: number;
}

interface ProtectedRange {
  start: number;
  end: number;
}

interface BacktickRun {
  length: number;
  nextStart?: number;
}

const fencePattern = /^( {0,3})(`{3,}|~{3,})(.*)$/;
const closingFenceWhitespacePattern = /^[\t \r]*$/;

function countRun(markdown: string, index: number, character: string): number {
  let end = index;
  while (markdown[end] === character) end += 1;
  return end - index;
}

function findFencedCodeRanges(markdown: string): ProtectedRange[] {
  const ranges: ProtectedRange[] = [];
  let fence: Fence | null = null;
  let lineStart = 0;

  while (lineStart < markdown.length) {
    const newlineIndex = markdown.indexOf("\n", lineStart);
    const lineEnd = newlineIndex === -1 ? markdown.length : newlineIndex;
    const line = markdown.slice(lineStart, lineEnd);
    const match = fencePattern.exec(line);

    if (fence) {
      const marker = match?.[2];
      if (
        marker?.[0] === fence.marker &&
        marker.length >= fence.length &&
        closingFenceWhitespacePattern.test(match?.[3] ?? "")
      ) {
        ranges.push({
          start: fence.start,
          end: newlineIndex === -1 ? markdown.length : newlineIndex + 1,
        });
        fence = null;
      }
    } else if (match) {
      const marker = match[2];
      const markerCharacter = marker[0] as Fence["marker"];
      const validInfoString = markerCharacter === "~" || !match[3].includes("`");
      if (validInfoString) {
        fence = {
          marker: markerCharacter,
          length: marker.length,
          start: lineStart,
        };
      }
    }

    if (newlineIndex === -1) break;
    lineStart = newlineIndex + 1;
  }

  if (fence) ranges.push({ start: fence.start, end: markdown.length });
  return ranges;
}

function indexBacktickRuns(
  markdown: string,
  protectedRanges: ProtectedRange[],
): Map<number, BacktickRun> {
  const runs = new Map<number, BacktickRun>();
  const lastRunByLength = new Map<number, BacktickRun>();
  let rangeIndex = 0;
  let index = 0;

  while (index < markdown.length) {
    const protectedRange = protectedRanges[rangeIndex];
    if (protectedRange?.start === index) {
      index = protectedRange.end;
      rangeIndex += 1;
      lastRunByLength.clear();
      continue;
    }

    if (markdown[index] === "`") {
      const length = countRun(markdown, index, "`");
      const run: BacktickRun = { length };
      const previousRun = lastRunByLength.get(length);
      if (previousRun) previousRun.nextStart = index;
      lastRunByLength.set(length, run);
      runs.set(index, run);
      index += length;
      continue;
    }

    index += 1;
  }

  return runs;
}

function isActiveDelimiter(markdown: string, index: number): boolean {
  let precedingSlashes = 0;
  for (let cursor = index - 1; cursor >= 0 && markdown[cursor] === "\\"; cursor -= 1) {
    precedingSlashes += 1;
  }
  return precedingSlashes % 2 === 0;
}

export function normalizeMathDelimiters(markdown: string): string {
  const protectedRanges = findFencedCodeRanges(markdown);
  const backtickRuns = indexBacktickRuns(markdown, protectedRanges);
  let protectedRangeIndex = 0;
  let mathClose: ")" | "]" | null = null;
  let result = "";
  let index = 0;

  while (index < markdown.length) {
    const protectedRange = protectedRanges[protectedRangeIndex];
    if (protectedRange?.start === index) {
      result += markdown.slice(protectedRange.start, protectedRange.end);
      index = protectedRange.end;
      protectedRangeIndex += 1;
      mathClose = null;
      continue;
    }

    if (mathClose) {
      if (
        markdown[index] === "\\" &&
        markdown[index + 1] === mathClose &&
        isActiveDelimiter(markdown, index)
      ) {
        result += mathClose === ")" ? "$" : "\n$$\n";
        mathClose = null;
        index += 2;
        continue;
      }

      result += markdown[index];
      index += 1;
      continue;
    }

    const backtickRun = backtickRuns.get(index);
    if (backtickRun && isActiveDelimiter(markdown, index)) {
      if (backtickRun.nextStart !== undefined) {
        const codeEnd = backtickRun.nextStart + backtickRun.length;
        result += markdown.slice(index, codeEnd);
        index = codeEnd;
      } else {
        result += markdown.slice(index, index + backtickRun.length);
        index += backtickRun.length;
      }
      continue;
    }

    if (
      markdown[index] === "\\" &&
      (markdown[index + 1] === "(" || markdown[index + 1] === "[") &&
      isActiveDelimiter(markdown, index)
    ) {
      const opener = markdown[index + 1];
      result += opener === "(" ? "$" : "\n$$\n";
      mathClose = opener === "(" ? ")" : "]";
      index += 2;
      continue;
    }

    result += markdown[index];
    index += 1;
  }

  return result;
}
