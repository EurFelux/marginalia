import { beforeEach, describe, expect, it, vi } from "vitest";
import { createReadingClock, type ReadingClock } from "@main/stats/clock";

const mocks = vi.hoisted(() => ({
  clock: {
    getReadingBook: vi.fn<() => string | null>(),
    setReadingBook: vi.fn(),
    tick: vi.fn(),
  },
  completeReading: vi.fn(),
  getActiveReadingSession: vi.fn(),
  getDb: vi.fn(),
  toReadingSessionSummary: vi.fn(),
}));

vi.mock("@main/db/instance", () => ({ getDb: mocks.getDb }));
vi.mock("@main/reading-sessions/repository", () => ({
  completeReading: mocks.completeReading,
  getActiveReadingSession: mocks.getActiveReadingSession,
  listReadingSessions: vi.fn(),
  startReading: vi.fn(),
  toReadingSessionSummary: mocks.toReadingSessionSummary,
}));
vi.mock("@main/reading-report/service", () => ({
  getReadingSessionDetail: vi.fn(),
  saveUserReadingReport: vi.fn(),
  startReadingReportGeneration: vi.fn(),
}));
vi.mock("@main/ai/send-deps", () => ({ makeReadingReportDeps: vi.fn() }));
vi.mock("@main/stats/clock-wiring", () => ({ getReadingClock: () => mocks.clock }));

import { readingSessionBindings } from "@main/ipc/reading-sessions-handlers";

const complete = readingSessionBindings.find(
  (binding) => binding.contract.channel === "reading-sessions:complete",
)!.fn as (input: { bookId: string }) => unknown;

let clock: ReadingClock;
let now: number;
let commits: { bookId: string; seconds: number }[];

describe("reading session completion clock ownership", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mocks.getDb.mockReturnValue({});
    mocks.getActiveReadingSession.mockReturnValue({ id: "session-b", bookId: "b" });
    mocks.completeReading.mockReturnValue({ id: "session-b", bookId: "b" });
    mocks.toReadingSessionSummary.mockReturnValue({ id: "session-b" });
    now = 0;
    commits = [];
    clock = createReadingClock({
      now: () => now,
      commit: (bookId, _atMs, seconds) => commits.push({ bookId, seconds }),
    });
    clock.setAwake(true);
    clock.setFocused(true);
    clock.setReadingBook("a");
    mocks.clock.getReadingBook.mockImplementation(() => clock.getReadingBook());
    mocks.clock.setReadingBook.mockImplementation((bookId) => clock.setReadingBook(bookId));
    mocks.clock.tick.mockImplementation(() => clock.tick());
  });

  it("does not stop book A when completing invalid book B", () => {
    mocks.getActiveReadingSession.mockReturnValue(undefined);

    expect(() => complete({ bookId: "b" })).toThrow(/no active reading session/);
    expect(mocks.clock.tick).not.toHaveBeenCalled();
    expect(mocks.clock.setReadingBook).not.toHaveBeenCalled();
    now += 20_000;
    clock.tick();
    expect(commits).toEqual([{ bookId: "a", seconds: 20 }]);
  });

  it("does not stop book A when completing active book B", () => {
    complete({ bookId: "b" });

    expect(mocks.clock.tick).not.toHaveBeenCalled();
    expect(mocks.clock.setReadingBook).not.toHaveBeenCalled();
    now += 20_000;
    clock.tick();
    expect(commits).toEqual([{ bookId: "a", seconds: 20 }]);
  });

  it("flushes book A before completing and then stops only book A", () => {
    complete({ bookId: "a" });

    expect(mocks.clock.tick).toHaveBeenCalledOnce();
    expect(mocks.completeReading).toHaveBeenCalledOnce();
    expect(mocks.clock.setReadingBook).toHaveBeenCalledWith(null);
    expect(mocks.clock.tick.mock.invocationCallOrder[0]).toBeLessThan(
      mocks.completeReading.mock.invocationCallOrder[0],
    );
    expect(mocks.completeReading.mock.invocationCallOrder[0]).toBeLessThan(
      mocks.clock.setReadingBook.mock.invocationCallOrder[0],
    );
  });
});
