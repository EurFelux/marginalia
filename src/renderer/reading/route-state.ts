import type { BookReadingState } from "@shared/reading-sessions";

export type BookDestination = "start" | "reader-active" | "reader-reference" | "report";

export function resolveBookDestination(
  readingState: BookReadingState,
  mode: "auto" | "reference",
): BookDestination {
  if (readingState === "not-started") return "start";
  if (readingState === "reading") return "reader-active";
  return mode === "reference" ? "reader-reference" : "report";
}
