import { describe, expect, it, vi } from "vitest";
import { InMemoryMemoryBank } from "./memory-bank.js";
import { FirestoreMemoryBank } from "./firestore-rest.js";
import { GoogleAdkGeminiRuntime } from "./adk-gemini-runtime.js";
import { seedMemoryBank } from "./seed.js";
import type { MimiWorkflow } from "./types.js";

describe("FirestoreMemoryBank REST codec", () => {
  function mockFetch(respond: (url: string, init: RequestInit | undefined) => Response): typeof fetch {
    return vi.fn(async (url: unknown, init?: RequestInit) => respond(String(url), init)) as unknown as typeof fetch;
  }

  it("encodes documents into Firestore fields and decodes them back", async () => {
    process.env.FIRESTORE_EMULATOR_HOST = "127.0.0.1:8080";
    let capturedBody: unknown = null;
    const fetchImpl = mockFetch((_url, init) => {
      if (init?.body) {
        capturedBody = JSON.parse(String(init.body));
        return new Response(JSON.stringify({ name: "projects/demo/databases/(default)/documents/workflows/wf_1" }), { status: 200 });
      }
      // GET → document not found yet
      return new Response("not found", { status: 404 });
    });
    const bank = new FirestoreMemoryBank({ projectId: "demo", fetchImpl });
    await bank.put("workflows", {
      id: "wf_1",
      status: "RUNNING",
      amountUsd: 250.5,
      flags: [true, false],
      nested: { ok: true },
      createdAt: "2026-01-01T00:00:00.000Z",
    } as never);
    expect(capturedBody).not.toBeNull();
    const fields = (capturedBody as { fields: Record<string, any> }).fields;
    expect(fields.status).toEqual({ stringValue: "RUNNING" });
    expect(fields.amountUsd).toEqual({ doubleValue: 250.5 });
    expect(fields.nested).toEqual({ mapValue: { fields: { ok: { booleanValue: true } } } });
    expect(Array.isArray(fields.flags.arrayValue.values)).toBe(true);
  });

  it("maps 404 to null on get", async () => {
    process.env.FIRESTORE_EMULATOR_HOST = "127.0.0.1:8080";
    const fetchImpl = mockFetch(() => new Response("not found", { status: 404 }));
    const bank = new FirestoreMemoryBank({ projectId: "demo", fetchImpl });
    expect(await bank.get("workflows", "missing")).toBeNull();
  });

  it("throws on unexpected errors so callers can react to Firestore failure", async () => {
    process.env.FIRESTORE_EMULATOR_HOST = "";
    delete process.env.FIRESTORE_EMULATOR_HOST;
    // No emulator + no metadata server reachable in CI → headers fall back and
    // the request itself fails; assert the error surfaces rather than being
    // silently swallowed.
    const fetchImpl = mockFetch(() => new Response("", { status: 500 }));
    const bank = new FirestoreMemoryBank({ projectId: "demo", fetchImpl });
    await expect(bank.get("workflows", "x")).rejects.toThrow(/firestore get failed: 500/);
  });
});

describe("GoogleAdkGeminiRuntime", () => {
  it("throws a clear unavailable error without an API key", () => {
    const bank = new InMemoryMemoryBank();
    expect(
      () =>
        new GoogleAdkGeminiRuntime(bank, {
          resolveAgent: async () => null,
          invokeTool: async () => ({ status: "executed" }),
        }, { apiKey: "" }),
    ).toThrow(/MIMI_GEMINI_API_KEY/);
  });

  it("runs a full tool loop: model proposes calls, gateway executes, final text completes", async () => {
    const bank = new InMemoryMemoryBank();
    await seedMemoryBank(bank, { runtimeMode: "gemini" });
    const invocations: Array<{ toolName: string }> = [];
    const runtime = new GoogleAdkGeminiRuntime(
      bank,
      {
        resolveAgent: async (id) => bank.get<any>("agents", id),
        invokeTool: async (input) => {
          invocations.push({ toolName: input.toolName });
          return { status: "executed", result: { fraudRiskScore: 0.9 } };
        },
      },
      {
        apiKey: "test-key",
        maxIterations: 4,
        fetchImpl: (async (_url: string, init?: RequestInit) => {
          const body = JSON.parse(String(init?.body));
          const contents = body.contents as Array<{ role: string; parts: unknown[] }>;
          const hasToolResponse = contents.some((c) => c.role === "tool");
          if (!hasToolResponse) {
            return new Response(JSON.stringify({
              candidates: [{ content: { parts: [{ functionCall: { name: "analyze_wallet", args: { customerId: "cus_chidi", amountUsd: 48500 } } }] } }],
              usageMetadata: { totalTokenCount: 210 },
            }), { status: 200 });
          }
          return new Response(JSON.stringify({
            candidates: [{ content: { parts: [{ text: "Fraud analysis completed: risk 0.90." }] } }],
            usageMetadata: { totalTokenCount: 340 },
          }), { status: 200 });
        }) as unknown as typeof fetch,
      },
    );
    // Grant analyze_wallet to the agent under test.
    const agent = await bank.get<any>("agents", "fraud-agent");
    agent.permissions.push("analyze_wallet");
    await bank.put("agents", agent);

    const run = await runtime.execute({
      agentId: "fraud-agent",
      instruction: "Analyze wallet behaviour for $48,500.",
      context: { transactionId: "txn_x", customerId: "cus_chidi", amountUsd: 48500 },
      workflowId: "wf_gemini_test",
      stepKey: "fraud",
    });
    expect(invocations.map((i) => i.toolName)).toEqual(["analyze_wallet"]);
    expect(run.status).toBe("COMPLETED");
    expect(run.outputText).toContain("risk 0.90");
    expect(run.artifacts.analyze_wallet).toEqual({ fraudRiskScore: 0.9 });
    expect(run.tokenUsageEstimate).toBeGreaterThan(0);
    // Run persisted with id keying.
    const persisted = await bank.get<any>("agent_runs", run.runId);
    expect(persisted?.status).toBe("COMPLETED");
  });

  it("surfaces simulated Gemini outages as failures (retry/recovery path)", async () => {
    const bank = new InMemoryMemoryBank();
    await seedMemoryBank(bank, { runtimeMode: "gemini" });
    const runtime = new GoogleAdkGeminiRuntime(
      bank,
      {
        resolveAgent: async (id) => bank.get<any>("agents", id),
        invokeTool: async () => ({ status: "executed" }),
      },
      {
        apiKey: "test-key",
        failFirstNCalls: 2,
        fetchImpl: (async () => new Response("{}" , { status: 200 })) as unknown as typeof fetch,
      },
    );
    const run = await runtime.createRun({ agentId: "orchestrator", instruction: "test", context: {} });
    await expect(runtime.startRun(run.runId)).rejects.toThrow(/simulated gemini outage/);
    const snapshot = await runtime.inspectRun(run.runId);
    expect(snapshot!.status).toBe("FAILED");
  });
});

describe("InMemoryMemoryBank", () => {
  it("upserts with createdAt stability and update merges patches", async () => {
    const bank = new InMemoryMemoryBank();
    await bank.put("transactions", { id: "t1", status: "RECEIVED", createdAt: "2026-01-01T00:00:00Z" } as never);
    await bank.put("transactions", { id: "t1", status: "COMPLETED", createdAt: "9999-01-01T00:00:00Z" } as never);
    const doc = await bank.get<any>("transactions", "t1");
    expect(doc.createdAt).toBe("2026-01-01T00:00:00Z"); // createdAt stable across upserts
    expect(doc.status).toBe("COMPLETED");
    await bank.update("transactions", "t1", { memo: "done" } as never);
    expect((await bank.get<any>("transactions", "t1")).memo).toBe("done");
  });

  it("lists sorted by createdAt desc by default", async () => {
    const bank = new InMemoryMemoryBank();
    await bank.put("audit", { id: "a1", createdAt: "2026-01-03T00:00:00Z" } as never);
    await bank.put("audit", { id: "a2", createdAt: "2026-01-05T00:00:00Z" } as never);
    const rows = await bank.list<any>("audit");
    expect(rows[0].id).toBe("a2");
  });
});
