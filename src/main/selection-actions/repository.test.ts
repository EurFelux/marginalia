import path from "node:path";
import { describe, expect, it } from "vitest";
import { createDb, runMigrations } from "@main/db/client";
import { selectionActions } from "@main/db/schema";
import {
  createSelectionAction,
  deleteSelectionAction,
  listSelectionActions,
  reorderSelectionActions,
  updateSelectionAction,
} from "@main/selection-actions/repository";
import { SELECTION_ACTION_MAX } from "@shared/selection-actions";

const MIGRATIONS = path.resolve(__dirname, "../db/migrations");
const NOW = 1_760_000_000_000;

function freshDb() {
  const db = createDb(":memory:");
  runMigrations(db, MIGRATIONS);
  return db;
}

const custom = (label: string) => ({
  label,
  icon: "swords" as const,
  prompt: `prompt for ${label}`,
  autoSend: false,
});

const ids = (db: ReturnType<typeof freshDb>) => listSelectionActions(db).map((a) => a.id);

describe("listSelectionActions", () => {
  it("returns the four built-in actions in factory order on an empty table", () => {
    const db = freshDb();
    expect(listSelectionActions(db)).toEqual([
      { kind: "builtin", id: "ask", prompt: null, enabled: true, autoSend: false },
      { kind: "builtin", id: "explain", prompt: null, enabled: true, autoSend: false },
      { kind: "builtin", id: "translate", prompt: null, enabled: true, autoSend: false },
      { kind: "builtin", id: "summarize", prompt: null, enabled: true, autoSend: false },
    ]);
  });

  it("orders stored rows by position and appends missing built-ins in factory order", () => {
    const db = freshDb();
    db.insert(selectionActions)
      .values([
        { id: "c1", kind: "custom", label: "A", icon: "swords", prompt: "p", position: 0 },
        { id: "translate", kind: "builtin", position: 1 },
      ])
      .run();
    expect(ids(db)).toEqual(["c1", "translate", "ask", "explain", "summarize"]);
  });

  it("skips malformed rows without dropping the others", () => {
    const db = freshDb();
    db.insert(selectionActions)
      .values([
        { id: "gone", kind: "builtin", position: 0 }, // 已不存在的内置 id
        { id: "c1", kind: "custom", label: "  ", icon: "swords", prompt: "p", position: 1 },
        { id: "c2", kind: "custom", label: "B", icon: "swords", prompt: "p", position: 2 },
      ])
      .run();
    expect(ids(db)).toEqual(["c2", "ask", "explain", "translate", "summarize"]);
  });

  it("still reads data that exceeds the current write limits", () => {
    const db = freshDb();
    const longLabel = "x".repeat(40);
    db.insert(selectionActions)
      .values({
        id: "c1",
        kind: "custom",
        label: longLabel,
        icon: "no-such-icon",
        prompt: "p",
        position: 0,
      })
      .run();
    const first = listSelectionActions(db)[0];
    expect(first).toMatchObject({ id: "c1", label: longLabel, icon: "no-such-icon" });
  });

  it("treats an empty stored built-in prompt as the default", () => {
    const db = freshDb();
    db.insert(selectionActions)
      .values({ id: "explain", kind: "builtin", prompt: "", position: 0 })
      .run();
    expect(listSelectionActions(db)[0]).toMatchObject({ id: "explain", prompt: null });
  });
});

describe("createSelectionAction", () => {
  it("places the first custom action after the four built-ins", () => {
    const db = freshDb();
    const created = createSelectionAction(db, custom("Rebut"), NOW);
    expect(created).toEqual({
      kind: "custom",
      id: created.id,
      label: "Rebut",
      icon: "swords",
      prompt: "prompt for Rebut",
      enabled: true,
      autoSend: false,
    });
    expect(ids(db)).toEqual(["ask", "explain", "translate", "summarize", created.id]);
  });

  it("appends after existing rows", () => {
    const db = freshDb();
    const a = createSelectionAction(db, custom("A"), NOW);
    const b = createSelectionAction(db, custom("B"), NOW);
    expect(ids(db).slice(-2)).toEqual([a.id, b.id]);
  });

  it("rejects creating beyond the maximum", () => {
    const db = freshDb();
    for (let i = 0; i < SELECTION_ACTION_MAX - 4; i++)
      createSelectionAction(db, custom(`a${i}`), NOW);
    expect(listSelectionActions(db)).toHaveLength(SELECTION_ACTION_MAX);
    expect(() => createSelectionAction(db, custom("one more"), NOW)).toThrow(/at most/);
    expect(listSelectionActions(db)).toHaveLength(SELECTION_ACTION_MAX);
  });
});

describe("updateSelectionAction", () => {
  it("sets and clears a built-in prompt (null = default)", () => {
    const db = freshDb();
    const set = updateSelectionAction(
      db,
      { kind: "builtin", id: "translate", patch: { prompt: "Translate into Japanese." } },
      NOW,
    );
    expect(set).toMatchObject({ id: "translate", prompt: "Translate into Japanese." });
    const cleared = updateSelectionAction(
      db,
      { kind: "builtin", id: "translate", patch: { prompt: null } },
      NOW,
    );
    expect(cleared).toMatchObject({ id: "translate", prompt: null });
  });

  it("lets Ask take a prompt and auto-send like any other built-in", () => {
    const db = freshDb();
    const ask = updateSelectionAction(
      db,
      { kind: "builtin", id: "ask", patch: { prompt: "What does this mean?", autoSend: true } },
      NOW,
    );
    expect(ask).toEqual({
      kind: "builtin",
      id: "ask",
      prompt: "What does this mean?",
      enabled: true,
      autoSend: true,
    });
  });

  it("keeps the order when a built-in is first written", () => {
    const db = freshDb();
    updateSelectionAction(db, { kind: "builtin", id: "summarize", patch: { enabled: false } }, NOW);
    expect(ids(db)).toEqual(["ask", "explain", "translate", "summarize"]);
    expect(listSelectionActions(db)[3]).toMatchObject({ enabled: false });
  });

  it("updates the editable fields of a custom action", () => {
    const db = freshDb();
    const a = createSelectionAction(db, custom("A"), NOW);
    const updated = updateSelectionAction(
      db,
      { kind: "custom", id: a.id, patch: { label: "B", icon: "brain", autoSend: true } },
      NOW,
    );
    expect(updated).toMatchObject({ label: "B", icon: "brain", prompt: a.prompt, autoSend: true });
  });

  it("rejects a kind that does not match the stored action", () => {
    const db = freshDb();
    expect(() =>
      updateSelectionAction(db, { kind: "custom", id: "explain", patch: { label: "X" } }, NOW),
    ).toThrow(/not found/);
  });

  it("rejects an unknown custom id", () => {
    const db = freshDb();
    expect(() =>
      updateSelectionAction(db, { kind: "custom", id: "nope", patch: { enabled: false } }, NOW),
    ).toThrow(/not found/);
  });
});

describe("deleteSelectionAction", () => {
  it("deletes a custom action and leaves the rest in order", () => {
    const db = freshDb();
    const a = createSelectionAction(db, custom("A"), NOW);
    const b = createSelectionAction(db, custom("B"), NOW);
    deleteSelectionAction(db, a.id);
    expect(ids(db)).toEqual(["ask", "explain", "translate", "summarize", b.id]);
  });

  it("refuses to delete a built-in action", () => {
    const db = freshDb();
    expect(() => deleteSelectionAction(db, "explain")).toThrow(/built-in/);
    expect(ids(db)).toContain("explain");
  });

  it("refuses to delete an unknown id", () => {
    const db = freshDb();
    expect(() => deleteSelectionAction(db, "nope")).toThrow(/not found/);
  });
});

describe("reorderSelectionActions", () => {
  it("rewrites the order to the given permutation", () => {
    const db = freshDb();
    const a = createSelectionAction(db, custom("A"), NOW);
    const next = [a.id, "summarize", "ask", "explain", "translate"];
    expect(reorderSelectionActions(db, next, NOW).map((x) => x.id)).toEqual(next);
    expect(ids(db)).toEqual(next);
    const positions = db
      .select({ id: selectionActions.id, position: selectionActions.position })
      .from(selectionActions)
      .all()
      .sort((x, y) => x.position - y.position)
      .map((r) => r.position);
    expect(positions).toEqual([0, 1, 2, 3, 4]);
  });

  it("works on an empty table (built-ins not yet stored)", () => {
    const db = freshDb();
    const next = ["summarize", "translate", "explain", "ask"];
    reorderSelectionActions(db, next, NOW);
    expect(ids(db)).toEqual(next);
  });

  it("rejects anything that is not a permutation of the current list", () => {
    const db = freshDb();
    const bad = [
      ["ask", "explain", "translate"], // 缺 id
      ["ask", "explain", "translate", "summarize", "extra"], // 多 id
      ["ask", "ask", "translate", "summarize"], // 重复 id
    ];
    for (const order of bad) {
      expect(() => reorderSelectionActions(db, order, NOW)).toThrow(/permutation/);
    }
    expect(ids(db)).toEqual(["ask", "explain", "translate", "summarize"]);
  });
});

describe("selection_actions CHECK constraints", () => {
  it("rejects rows whose shape does not match their kind", () => {
    const db = freshDb();
    expect(() =>
      db
        .insert(selectionActions)
        .values({ id: "explain", kind: "builtin", label: "X", position: 0 })
        .run(),
    ).toThrow();
    expect(() =>
      db
        .insert(selectionActions)
        .values({ id: "c1", kind: "custom", label: "X", icon: "swords", position: 0 })
        .run(),
    ).toThrow();
  });
});
