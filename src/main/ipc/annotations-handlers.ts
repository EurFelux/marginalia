// src/main/ipc/annotations-handlers.ts
import { IPC } from "@shared/ipc";
import { bookIdInput } from "@shared/library";
import {
  annotationIdInput,
  createAnnotationInput,
  updateAnnotationInput,
  type AnnotationDto,
  type CreateAnnotationInput,
  type UpdateAnnotationInput,
} from "@shared/annotations";
import { getDb } from "@main/db/instance";
import {
  createAnnotation,
  deleteAnnotation,
  listAnnotationsByBook,
  updateAnnotation,
} from "@main/library/annotations";
import { handle } from "@main/ipc/registry";

export function registerAnnotationHandlers(): void {
  handle<{ bookId: string }, AnnotationDto[]>(IPC.annotationsListByBook, bookIdInput, (input) =>
    listAnnotationsByBook(getDb(), input.bookId),
  );

  handle<CreateAnnotationInput, AnnotationDto>(
    IPC.annotationsCreate,
    createAnnotationInput,
    (input) => createAnnotation(getDb(), input),
  );

  handle<UpdateAnnotationInput, AnnotationDto>(
    IPC.annotationsUpdate,
    updateAnnotationInput,
    (input) => updateAnnotation(getDb(), input),
  );

  handle<{ id: string }, void>(IPC.annotationsDelete, annotationIdInput, (input) =>
    deleteAnnotation(getDb(), input.id),
  );
}
