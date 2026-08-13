import type { Pool } from "pg";
import { processJob } from "./index";
import type { JobRow } from "../db/jobs";
import * as jobsDb from "../db/jobs";
import * as providers from "../providers";

jest.mock("../db/jobs", () => ({
  ...jest.requireActual("../db/jobs"),
  markJobDone: jest.fn(),
  markJobFailed: jest.fn(),
}));

jest.mock("../providers", () => ({
  ...jest.requireActual("../providers"),
  runProvider: jest.fn(),
}));

const fakePool = {} as Pool;

function makeJob(overrides: Partial<JobRow> = {}): JobRow {
  return {
    id: "job-1",
    status: "running",
    diff: "diff-text",
    options: { provider: "mock", maxFindings: 100 },
    findings: null,
    usageInputBytes: 10,
    usageChunks: 1,
    usageCacheHit: false,
    errorCode: null,
    errorMessage: null,
    ...overrides,
  };
}

beforeEach(() => {
  jest.clearAllMocks();
  (jobsDb.markJobDone as jest.Mock).mockResolvedValue(undefined);
  (jobsDb.markJobFailed as jest.Mock).mockResolvedValue(undefined);
});

describe("processJob error handling", () => {
  it("passes through the message for a known-safe error (ProviderNotImplementedError)", async () => {
    (providers.runProvider as jest.Mock).mockImplementation(() => {
      throw new providers.ProviderNotImplementedError("llm provider not yet implemented");
    });

    await processJob(fakePool, makeJob());

    expect(jobsDb.markJobFailed).toHaveBeenCalledWith(
      fakePool,
      "job-1",
      "internal",
      "llm provider not yet implemented",
    );
  });

  it("replaces an unexpected error's message with a generic one, never leaking raw details", async () => {
    (providers.runProvider as jest.Mock).mockImplementation(() => {
      throw new Error('password authentication failed for user "app"');
    });

    await processJob(fakePool, makeJob());

    const call = (jobsDb.markJobFailed as jest.Mock).mock.calls[0];
    expect(call[3]).toBe("Internal error while processing this job");
    expect(call[3]).not.toMatch(/password/i);
  });

  it("never rejects, even if both markJobDone and markJobFailed fail", async () => {
    (providers.runProvider as jest.Mock).mockImplementation(() => {
      throw new Error("boom");
    });
    (jobsDb.markJobFailed as jest.Mock).mockRejectedValue(new Error("db is also down"));

    await expect(processJob(fakePool, makeJob())).resolves.toBeUndefined();
  });

  it("does not call markJobFailed when the job completes successfully", async () => {
    (providers.runProvider as jest.Mock).mockReturnValue([]);

    await processJob(fakePool, makeJob());

    expect(jobsDb.markJobDone).toHaveBeenCalled();
    expect(jobsDb.markJobFailed).not.toHaveBeenCalled();
  });
});
