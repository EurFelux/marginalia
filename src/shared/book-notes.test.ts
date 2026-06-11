import { describe, expect, it } from "vitest";
import { createBookNoteInput, updateBookNoteInput } from "@shared/book-notes";

describe("book note input schemas", () => {
  it("accepts valid create input and trims content", () => {
    const r = createBookNoteInput.parse({ bookId: "b1", content: "  hello **md**  " });
    expect(r.content).toBe("hello **md**");
  });

  it("rejects empty and whitespace-only content on create", () => {
    expect(createBookNoteInput.safeParse({ bookId: "b1", content: "" }).success).toBe(false);
    expect(createBookNoteInput.safeParse({ bookId: "b1", content: "   \n " }).success).toBe(false);
  });

  it("rejects whitespace-only content on update patch", () => {
    expect(updateBookNoteInput.safeParse({ id: "n1", patch: { content: " " } }).success).toBe(
      false,
    );
  });
});
