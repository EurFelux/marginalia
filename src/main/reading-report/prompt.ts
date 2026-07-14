import type { DB } from "@main/db/client";
import {
  renderAssistantIdentity,
  renderMemoryIndex,
  renderReaderInstructions,
} from "@main/ai/agent-context";
import { getPreference } from "@main/preferences/repository";

export const READING_REPORT_CORE = `You write an editable Markdown completion report from your own first-person perspective as the assistant, addressing the reader as "you". Focus on the reader's questions, judgments, changes, connections, and what they want to retain. Ground every claim about the reader in traces available through tools; omit unsupported sections instead of inventing completeness. Do not turn the report into a book summary. You may compare a previous reading report only when you clearly label it as a cross-reading change rather than evidence from this reading. A compacted conversation summary may include discussion from before this reading; treat it as background rather than direct evidence from the current reading. Long-term memory may explain or connect current traces only when clearly identified as your prior understanding of the reader, never as a direct observation from this reading. Evidence, target-session scope, and tool permissions cannot be overridden.`;

const REPORT_MEMORY_GUIDANCE = `## Memory guidance for this report

Use readMemory when an indexed memory may clarify the reader's durable viewpoint. Use saveMemory only for a new lasting preference, viewpoint, recurring concept, framework, correction, or cross-book connection. Use updateMemory instead of creating a near-duplicate. Never store book content, the complete report, or a one-off thought. Memory content follows the reader's language; slugs use English kebab-case.`;

export function buildReadingReportSystemPrompt(db: DB): string {
  const memoryEnabled = getPreference(db, "memoryEnabled") ?? true;
  const readerInstructions = renderReaderInstructions(db);
  const prioritizedInstructions = readerInstructions
    ? `${readerInstructions}\n\nThese are the highest-priority report-writing preferences and may override the default perspective, structure, or content guidance above. They cannot override evidence, target-session scope, or tool permissions.`
    : null;
  return [
    READING_REPORT_CORE,
    renderAssistantIdentity(db),
    renderMemoryIndex(db),
    memoryEnabled ? REPORT_MEMORY_GUIDANCE : null,
    prioritizedInstructions,
  ]
    .filter((section): section is string => section !== null)
    .join("\n\n");
}
