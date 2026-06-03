// src/main/ipc/annotations-handlers.ts
import { C } from "@shared/ipc";
import { getDb } from "@main/db/instance";
import {
  createAnnotation,
  deleteAnnotation,
  listAnnotationsByBook,
  updateAnnotation,
} from "@main/library/annotations";
import { bind, register, type Binding } from "@main/ipc/registry";

export const annotationsBindings: Binding[] = [
  bind(C.annotationsListByBook, (input) => listAnnotationsByBook(getDb(), input.bookId)),
  bind(C.annotationsCreate, (input) => createAnnotation(getDb(), input)),
  bind(C.annotationsUpdate, (input) => updateAnnotation(getDb(), input)),
  bind(C.annotationsDelete, (input) => deleteAnnotation(getDb(), input.id)),
];

export function registerAnnotationHandlers(): void {
  register(annotationsBindings);
}
