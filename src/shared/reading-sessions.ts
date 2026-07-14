import { z } from "zod";

export const bookReadingStateSchema = z.enum(["not-started", "reading", "finished"]);
export type BookReadingState = z.infer<typeof bookReadingStateSchema>;

export const startReadingInput = z.discriminatedUnion("mode", [
  z.object({ mode: z.literal("continue"), bookId: z.string().min(1) }),
  z.object({ mode: z.literal("restart"), bookId: z.string().min(1) }),
]);
export type StartReadingInput = z.infer<typeof startReadingInput>;

export const completeReadingInput = z.object({ bookId: z.string().min(1) });
export const readingSessionIdInput = z.object({ sessionId: z.string().min(1) });
export const listReadingSessionsInput = z.object({ bookId: z.string().min(1) });
export const saveReadingReportInput = z.object({
  sessionId: z.string().min(1),
  content: z.string().trim().min(1),
});

const markdown = z.string().trim().min(1);
export const readingReportStateSchema = z.discriminatedUnion("status", [
  z.object({ status: z.literal("empty") }),
  z.object({ status: z.literal("generating") }),
  z.object({ status: z.literal("generation-failed") }),
  z.object({ status: z.literal("ready"), content: markdown }),
  z.object({ status: z.literal("regenerating"), content: markdown }),
  z.object({
    status: z.literal("regeneration-failed"),
    content: markdown,
  }),
]);
export type ReadingReportState = z.infer<typeof readingReportStateSchema>;

export const generateReadingReportResultSchema = z.discriminatedUnion("outcome", [
  z.object({ outcome: z.literal("accepted") }),
  z.object({ outcome: z.literal("insufficient-evidence") }),
  z.object({ outcome: z.literal("unavailable") }),
]);
export type GenerateReadingReportResult = z.infer<typeof generateReadingReportResultSchema>;

export const cancelReadingReportResultSchema = z.discriminatedUnion("outcome", [
  z.object({ outcome: z.literal("canceled") }),
  z.object({ outcome: z.literal("idle") }),
]);
export type CancelReadingReportResult = z.infer<typeof cancelReadingReportResultSchema>;

export interface ReadingSessionSummaryDto {
  id: string;
  bookId: string;
  startedAt: number;
  completedAt: number | null;
  activeSeconds: number;
  reportAvailable: boolean;
}

export interface ReadingSessionDetailDto {
  session: ReadingSessionSummaryDto;
  report: ReadingReportState;
}
