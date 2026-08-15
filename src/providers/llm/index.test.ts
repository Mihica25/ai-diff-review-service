import { runLlmProvider, LlmProviderError } from "./index";

const CONFIG = { apiKey: "test-key", model: "claude-sonnet-5" };
const originalFetch = globalThis.fetch;

function mockFetch(response: Partial<Response> & { json?: () => Promise<unknown> }): jest.Mock {
  const fn = jest.fn().mockResolvedValue({
    ok: true,
    status: 200,
    text: async () => "",
    ...response,
  });
  (globalThis as { fetch: unknown }).fetch = fn;
  return fn;
}

function mockFetchRejecting(err: Error): jest.Mock {
  const fn = jest.fn().mockRejectedValue(err);
  (globalThis as { fetch: unknown }).fetch = fn;
  return fn;
}

function toolUseResponse(findings: unknown[], stopReason = "tool_use"): unknown {
  return {
    stop_reason: stopReason,
    content: [{ type: "tool_use", name: "report_findings", input: { findings } }],
  };
}

const VALID_FINDING = {
  path: "a.ts",
  line: 1,
  severity: "high",
  category: "security",
  title: "eval usage",
  evidence: "eval(x)",
};

afterEach(() => {
  (globalThis as { fetch: unknown }).fetch = originalFetch;
});

describe("runLlmProvider", () => {
  it("maps a valid tool_use response into Finding[]", async () => {
    mockFetch({ json: async () => toolUseResponse([VALID_FINDING]) });

    const findings = await runLlmProvider("some diff", CONFIG);

    expect(findings).toEqual([
      {
        id: "LLM-EVAL-USAGE:a.ts:1",
        ruleId: "LLM-EVAL-USAGE",
        path: "a.ts",
        line: 1,
        severity: "high",
        category: "security",
        title: "eval usage",
        evidence: "eval(x)",
      },
    ]);
  });

  it("returns an empty array when the model reports no findings", async () => {
    mockFetch({ json: async () => toolUseResponse([]) });
    expect(await runLlmProvider("some diff", CONFIG)).toEqual([]);
  });

  it("drops one malformed finding without discarding the rest of the response", async () => {
    const badFinding = { ...VALID_FINDING, severity: "not-a-real-severity" };
    const goodFinding = { ...VALID_FINDING, path: "b.ts", line: 2, title: "second issue" };
    mockFetch({ json: async () => toolUseResponse([badFinding, goodFinding]) });

    const findings = await runLlmProvider("some diff", CONFIG);

    expect(findings).toHaveLength(1);
    expect(findings[0]?.path).toBe("b.ts");
  });

  it("throws LlmProviderError when the response was truncated at max_tokens", async () => {
    mockFetch({ json: async () => toolUseResponse([VALID_FINDING], "max_tokens") });
    await expect(runLlmProvider("some diff", CONFIG)).rejects.toThrow(LlmProviderError);
  });

  it("throws LlmProviderError on a non-2xx response", async () => {
    mockFetch({ ok: false, status: 500, text: async () => "internal error" });
    await expect(runLlmProvider("some diff", CONFIG)).rejects.toThrow(LlmProviderError);
  });

  it("throws LlmProviderError when the response body isn't valid JSON", async () => {
    mockFetch({
      json: async () => {
        throw new SyntaxError("Unexpected token");
      },
    });
    await expect(runLlmProvider("some diff", CONFIG)).rejects.toThrow(LlmProviderError);
  });

  it("throws LlmProviderError when there's no report_findings tool_use block", async () => {
    mockFetch({ json: async () => ({ stop_reason: "end_turn", content: [{ type: "text", text: "no tool call" }] }) });
    await expect(runLlmProvider("some diff", CONFIG)).rejects.toThrow(LlmProviderError);
  });

  it("throws LlmProviderError when the fetch call itself rejects", async () => {
    mockFetchRejecting(new Error("ECONNREFUSED"));
    await expect(runLlmProvider("some diff", CONFIG)).rejects.toThrow(LlmProviderError);
  });

  it("never leaks the API key into a thrown error message", async () => {
    mockFetchRejecting(new Error("ECONNREFUSED"));
    try {
      await runLlmProvider("some diff", { apiKey: "super-secret-key", model: "claude-sonnet-5" });
      fail("expected runLlmProvider to throw");
    } catch (err) {
      expect(err).toBeInstanceOf(LlmProviderError);
      expect((err as Error).message).not.toMatch(/super-secret-key/);
    }
  });
});
