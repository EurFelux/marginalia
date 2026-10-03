import { describe, expect, it, vi } from "vitest";
import { createReadingReportSubmission } from "@main/reading-report/submission";

vi.mock("@main/logger", () => ({
  createLogger: () => ({ warn: vi.fn(), debug: vi.fn(), error: vi.fn(), info: vi.fn() }),
}));

const toolOptions = { toolCallId: "submit", messages: [] } as never;

function setup(commit: (markdown: string) => void = () => {}) {
  const controller = new AbortController();
  const commitSpy = vi.fn(commit);
  const submission = createReadingReportSubmission({
    signal: controller.signal,
    commit: commitSpy,
  });
  const submit = (markdown: string) =>
    submission.tools.submitReport!.execute!({ markdown }, toolOptions) as Promise<unknown>;
  return { controller, commit: commitSpy, submission, submit };
}

describe("reading report submission", () => {
  it("commits the markdown once and tells the agent it is saved", async () => {
    const { commit, submission, submit } = setup();

    await expect(submit("# Report")).resolves.toMatchObject({ saved: true });
    expect(commit).toHaveBeenCalledWith("# Report");
    expect(submission.submitted()).toBe(true);

    await expect(submit("# Again")).resolves.toMatchObject({
      saved: false,
      error: expect.stringContaining("already been submitted"),
    });
    expect(commit).toHaveBeenCalledTimes(1);
  });

  it("rejects an empty report without committing", async () => {
    const { commit, submission, submit } = setup();

    await expect(submit("  \n ")).resolves.toMatchObject({
      saved: false,
      error: expect.stringContaining("empty"),
    });
    expect(commit).not.toHaveBeenCalled();
    expect(submission.submitted()).toBe(false);
  });

  it("reports a failed commit as not retryable and stays unsubmitted", async () => {
    const { submission, submit } = setup(() => {
      throw new Error("memory changed during reading report generation");
    });

    await expect(submit("# Report")).resolves.toMatchObject({
      saved: false,
      error: expect.stringMatching(/retrying will not help.*memory changed/),
    });
    expect(submission.submitted()).toBe(false);
  });

  it("throws instead of committing once the generation is aborted", async () => {
    const { controller, commit, submission, submit } = setup();
    controller.abort();

    await expect(submit("# Report")).rejects.toThrow();
    expect(commit).not.toHaveBeenCalled();
    expect(submission.submitted()).toBe(false);
  });
});
