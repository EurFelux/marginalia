// src/main/ipc/book-notes-handlers.ts
import { C } from "@shared/ipc";
import { getDb } from "@main/db/instance";
import {
  createBookNote,
  deleteBookNote,
  listBookNotesByBook,
  updateBookNote,
} from "@main/library/book-notes";
import { bind, register, type Binding } from "@main/ipc/registry";

export const bookNotesBindings: Binding[] = [
  bind(C.bookNotesListByBook, (input) => listBookNotesByBook(getDb(), input.bookId)),
  bind(C.bookNotesCreate, (input) => createBookNote(getDb(), input)),
  bind(C.bookNotesUpdate, (input) => updateBookNote(getDb(), input)),
  bind(C.bookNotesDelete, (input) => deleteBookNote(getDb(), input.id)),
];

export function registerBookNotesHandlers(): void {
  register(bookNotesBindings);
}
