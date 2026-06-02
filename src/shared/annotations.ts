// src/shared/annotations.ts
import { z } from "zod";

export const annotationStyle = z.enum(["yellow", "green", "blue", "pink", "purple", "underline"]);
export type AnnotationStyle = z.infer<typeof annotationStyle>;

export interface AnnotationDto {
  id: string;
  bookId: string;
  style: AnnotationStyle;
  note: string;
  selectedText: string;
  cfiRange: string;
  createdAt: number;
  updatedAt: number;
}

export const createAnnotationInput = z.object({
  bookId: z.string().min(1),
  style: annotationStyle,
  note: z.string(),
  selectedText: z.string().min(1),
  cfiRange: z.string().min(1),
});
export type CreateAnnotationInput = z.infer<typeof createAnnotationInput>;

export const updateAnnotationInput = z.object({
  id: z.string().min(1),
  patch: z
    .object({
      style: annotationStyle.optional(),
      note: z.string().optional(),
    })
    .refine((p) => p.style !== undefined || p.note !== undefined, {
      message: "patch must include at least one of: style, note",
    }),
});
export type UpdateAnnotationInput = z.infer<typeof updateAnnotationInput>;

export const annotationIdInput = z.object({ id: z.string().min(1) });
export type AnnotationIdInput = z.infer<typeof annotationIdInput>;
