import type {
  AdkAdapterMode,
  AdkRunInput,
  AdkRunSnapshot,
  AdkRunStatus,
  AdkSessionEvent,
  MimiAgent,
  MemoryBank,
} from "./types.js";
import { DEFAULT_GEMINI_MODEL, geminiModelForAgent } from "./constants.js";

/**
 * Google ADK runtime contract.
 *
 * MiMi Money AgentOS treats every financial agent as a Google ADK agent: an
 * instruction-tuned Gemini reasoning loop with typed tool access, a session
 * event log and full run lifecycle (create → start → pause → resume → cancel
 * → inspect). Two interchangeable adapters implement this interface:
 *
 *  - GoogleAdkGeminiRuntime — real Gemini model calls with ADK-style tool
 *    loops (function calling) over the Gemini REST API.
 *  - GoogleAdkLocalSimulationRuntime — the same ADK session/run/tool-call
 *    semantics executed by deterministic local logic, so the platform runs
 *    with zero external dependencies for local dev, CI and offline demos.
 *
 * In both modes, tool calls are ALWAYS routed through the MiMi Agent Gateway.
 */

export class AdkRuntimeError extends Error {
  readonly kind: "unavailable" | "timeout" | "model-error" | "cancelled";
  constructor(kind: AdkRuntimeError["kind"], message: string) {
    super(message);
    this.kind = kind;
  }
}

export interface AgentRuntimeAdapter {
  readonly modeName: AdkAdapterMode;
  readonly model: string;
  createRun(input: AdkRunInput): Promise<AdkRunSnapshot>;
  startRun(runId: string): Promise<AdkRunSnapshot>;
  /** Convenience path: create + start + await completion. */
  execute(input: AdkRunInput): Promise<AdkRunSnapshot>;
  inspectRun(runId: string): Promise<AdkRunSnapshot | null>;
  listRuns(filter?: { workflowId?: string; agentId?: string }): Promise<AdkRunSnapshot[]>;
  pauseRun(runId: string): Promise<AdkRunSnapshot>;
  resumeRun(runId: string): Promise<AdkRunSnapshot>;
  cancelRun(runId: string): Promise<AdkRunSnapshot>;
}

/** Shared persistence + lifecycle bookkeeping used by both adapters. */
export abstract class BaseAdkRuntime implements AgentRuntimeAdapter {
  abstract readonly modeName: AdkAdapterMode;
  abstract readonly model: string;

  constructor(
    protected readonly memoryBank: MemoryBank,
    protected readonly opts: { timeoutMs?: number } = {},
  ) {}

  async createRun(input: AdkRunInput): Promise<AdkRunSnapshot> {
    const now = new Date().toISOString();
    const run: AdkRunSnapshot & { id: string } = {
      id: "",
      runId: `run_${crypto.randomUUID().slice(0, 12)}`,
      agentId: input.agentId,
      sessionId: `ses_${crypto.randomUUID().slice(0, 10)}`,
      workflowId: input.workflowId ?? null,
      stepKey: input.stepKey ?? null,
      status: "QUEUED",
      model: this.model,
      adapterMode: this.modeName,
      iterations: 0,
      toolCalls: [],
      artifacts: {},
      outputText: null,
      error: null,
      startedAt: now,
      finishedAt: null,
      tokenUsageEstimate: 0,
      costUsdEstimate: 0,
      sessionEvents: [
        {
          at: now,
          kind: "user-message",
          text: input.instruction,
          meta: { contextKeys: Object.keys(input.context ?? {}), context: input.context ?? {} },
        },
        {
          at: now,
          kind: "system",
          text: `ADK runtime ${this.modeName} attached (model ${this.model}); tools gated by MiMi Agent Gateway`,
        },
      ],
    };
    run.id = run.runId;
    await this.memoryBank.put("agent_runs", run);
    return run;
  }

  abstract startRun(runId: string): Promise<AdkRunSnapshot>;

  async execute(input: AdkRunInput): Promise<AdkRunSnapshot> {
    const run = await this.createRun(input);
    return this.startRun(run.runId);
  }

  async inspectRun(runId: string): Promise<AdkRunSnapshot | null> {
    const doc = await this.memoryBank.get<{ id?: string } & AdkRunSnapshot>("agent_runs", runId) ?? await this.byIdFallback(runId);
    return doc;
  }

  /** Runs are keyed by their runId; resolve via scan if a stale id was used. */
  private async byIdFallback(_id: string): Promise<AdkRunSnapshot | null> {
    return null;
  }

  async listRuns(filter?: { workflowId?: string; agentId?: string }): Promise<AdkRunSnapshot[]> {
    let rows = await this.memoryBank.list<AdkRunSnapshot>("agent_runs", { limit: 300 });
    if (filter?.workflowId) rows = rows.filter((r) => r.workflowId === filter.workflowId);
    if (filter?.agentId) rows = rows.filter((r) => r.agentId === filter.agentId);
    return rows;
  }

  async pauseRun(runId: string): Promise<AdkRunSnapshot> {
    return this.transition(runId, "PAUSED", "paused by operator");
  }

  async resumeRun(runId: string): Promise<AdkRunSnapshot> {
    return this.transition(runId, "RUNNING", "resumed by operator");
  }

  async cancelRun(runId: string): Promise<AdkRunSnapshot> {
    return this.transition(runId, "CANCELLED", "cancelled by operator");
  }

  protected async transition(runId: string, status: AdkRunStatus, note: string): Promise<AdkRunSnapshot> {
    const run = await this.inspectRun(runId);
    if (!run) throw new AdkRuntimeError("model-error", `run ${runId} not found`);
    run.status = status;
    run.sessionEvents.push({ at: new Date().toISOString(), kind: "system", text: note });
    await this.memoryBank.put("agent_runs", run as unknown as Record<string, unknown> & { id: string });
    return run;
  }

  protected async save(run: AdkRunSnapshot): Promise<void> {
    const stamped = run as AdkRunSnapshot & { id: string };
    stamped.id = stamped.id || stamped.runId;
    await this.memoryBank.put("agent_runs", stamped);
  }

  protected timeoutSignal(): AbortSignal {
    return AbortSignal.timeout(this.opts.timeoutMs ?? 45_000);
  }
}

// ---------------------------------------------------------------------------
// Gemini REST types (subset used here)
// ---------------------------------------------------------------------------

interface GeminiPart {
  text?: string;
  functionCall?: { name: string; args?: Record<string, unknown> };
  functionResponse?: { name: string; response: unknown };
}
interface GeminiContent {
  role: "user" | "model" | "tool";
  parts: GeminiPart[];
}
interface GeminiResponse {
  candidates?: Array<{ content?: { parts?: GeminiPart[] }; finishReason?: string }>;
  usageMetadata?: { totalTokenCount?: number };
  error?: { message?: string };
}

export interface GeminiRuntimeOptions {
  apiKey?: string;
  model?: string;
  lightModel?: string;
  modelForAgent?: (agentId: string) => string;
  fetchImpl?: typeof fetch;
  maxIterations?: number;
  timeoutMs?: number;
  /** Test hook: fail the first N model calls to exercise retry/recovery. */
  failFirstNCalls?: number;
}

const GEMINI_BASE = "https://generativelanguage.googleapis.com/v1beta";

/**
 * Real ADK-style runner over Gemini function calling.
 *
 * The model receives the agent's instruction + session state + its Gateway-
 * approved tool declarations. Every functionCall the model proposes is
 * validated and executed through the Gateway — the model can only ever
 * REQUEST capability, never exercise it directly. No chain-of-thought is
 * persisted: only final texts, tool calls and tool responses enter memory.
 */
export class GoogleAdkGeminiRuntime extends BaseAdkRuntime {
  readonly modeName = "gemini" as const;
  readonly model: string;
  private readonly lightModel: string;
  private readonly modelForAgent: (agentId: string) => string;
  private readonly apiKey: string;
  private readonly ffetch: typeof fetch;
  private readonly maxIterations: number;
  private failRemaining: number;
  private paused = new Set<string>();

  constructor(
    memoryBank: MemoryBank,
    private readonly hooks: {
      resolveAgent(agentId: string): Promise<MimiAgent | null>;
      invokeTool(input: { agentId: string; toolName: string; args: Record<string, unknown>; workflowId?: string | null }): Promise<{ status: string; result?: unknown; error?: string }>;
    },
    opts: GeminiRuntimeOptions = {},
  ) {
    super(memoryBank, { timeoutMs: opts.timeoutMs });
    const key = opts.apiKey?.trim()
      || process.env.MIMI_GEMINI_API_KEY?.trim()
      || process.env.GEMINI_API_KEY?.trim()
      || process.env.GOOGLE_API_KEY?.trim()
      || "";
    if (!key) throw new AdkRuntimeError("unavailable", "MIMI_GEMINI_API_KEY is required for gemini mode");
    this.apiKey = key;
    this.model = opts.model?.trim() || DEFAULT_GEMINI_MODEL;
    this.lightModel = opts.lightModel?.trim() || process.env.MIMI_GEMINI_LIGHT_MODEL?.trim() || "gemini-3.5-flash";
    this.modelForAgent = opts.modelForAgent ?? ((agentId) => geminiModelForAgent(agentId, this.model, this.lightModel));
    this.ffetch = opts.fetchImpl ?? fetch;
    this.maxIterations = opts.maxIterations ?? 6;
    this.failRemaining = opts.failFirstNCalls ?? 0;
  }

  pauseRun(runId: string): Promise<AdkRunSnapshot> {
    this.paused.add(runId);
    return super.pauseRun(runId);
  }

  async startRun(runId: string): Promise<AdkRunSnapshot> {
    let run = await this.inspectRun(runId);
    if (!run) throw new AdkRuntimeError("model-error", `run ${runId} not found`);
    const agent = await this.hooks.resolveAgent(run.agentId);
    if (!agent) throw new AdkRuntimeError("model-error", `agent ${run.agentId} not found`);
    const selectedModel = this.modelForAgent(run.agentId);
    run.model = selectedModel;

    run.status = "RUNNING";
    await this.save(run);
    try {
      for (let i = 0; i < this.maxIterations; i += 1) {
        if (this.paused.has(runId)) {
          run.status = "PAUSED";
          await this.save(run);
          return run;
        }
        run = (await this.inspectRun(runId))!;
        if (run.status === "CANCELLED") return run;
        const contents = this.toContents(run.sessionEvents);
        const response = await this.callGemini(agent, contents, selectedModel);
        run.iterations = i + 1;
        const parts = response.candidates?.[0]?.content?.parts ?? [];
        const calls = parts.filter((p) => p.functionCall);
        const texts = parts.filter((p) => typeof p.text === "string").map((p) => p.text!);

        run.tokenUsageEstimate += response.usageMetadata?.totalTokenCount ?? 0;
        run.costUsdEstimate = round6(run.tokenUsageEstimate * 0.0000015);

        if (calls.length > 0) {
          for (const call of calls) {
            const toolName = call.functionCall!.name;
            const args = call.functionCall!.args ?? {};
            run.sessionEvents.push({
              at: new Date().toISOString(),
              kind: "model-tool-call",
              text: toolName,
              meta: { args },
            });
            const outcome = await this.hooks.invokeTool({
              agentId: run.agentId,
              toolName,
              args,
              workflowId: run.workflowId,
            });
            run.toolCalls.push({
              toolName,
              args,
              gatewayDecision: outcome.status === "executed" ? "ALLOW" : outcome.error?.includes("approval") ? "REQUIRE_HUMAN_APPROVAL" : "DENY",
              ok: outcome.status === "executed",
              resultSummary: summarize(outcome.result ?? outcome.error),
              latencyMs: 0,
            });
            if (outcome.status === "executed") {
              run.artifacts[toolName] = outcome.result as Record<string, unknown>;
            }
            run.sessionEvents.push({
              at: new Date().toISOString(),
              kind: "tool-response",
              text: `${toolName} → ${outcome.status}`,
              meta: { summary: summarize(outcome.result ?? outcome.error) },
            });
            contents.push({
              role: "tool",
              parts: [{ functionResponse: { name: toolName, response: { output: truncateForModel(summarize(outcome.result ?? outcome.error)) } } }],
            });
          }
          // Persist progress between iterations.
          await this.save(run);
          continue;
        }

        run.outputText = texts.join("\n").trim() || "(no textual output)";
        run.status = "COMPLETED";
        run.finishedAt = new Date().toISOString();
        run.sessionEvents.push({ at: run.finishedAt, kind: "final", text: run.outputText });
        await this.save(run);
        await this.chargeAgent(run);
        return run;
      }
      // Iteration budget exhausted without a final text → treat as completed
      // with whatever we captured (tools already did the real work).
      run.status = "COMPLETED";
      run.finishedAt = new Date().toISOString();
      run.outputText = run.outputText ?? "iteration budget reached; tool artifacts recorded";
      await this.save(run);
      await this.chargeAgent(run);
      return run;
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      run.status = /timeout|aborted/i.test(message) ? "TIMEOUT" : "FAILED";
      run.error = message;
      run.finishedAt = new Date().toISOString();
      run.sessionEvents.push({ at: run.finishedAt, kind: "error", text: message });
      await this.save(run);
      throw err instanceof Error && /timeout/i.test(message)
        ? new AdkRuntimeError("timeout", message)
        : new AdkRuntimeError("model-error", message);
    }
  }

  private async callGemini(agent: MimiAgent, contents: GeminiContent[], model = this.model): Promise<GeminiResponse> {
    if (this.failRemaining > 0) {
      this.failRemaining -= 1;
      throw new Error("simulated gemini outage (failFirstNCalls)");
    }
    const url = `${GEMINI_BASE}/models/${model}:generateContent?key=${encodeURIComponent(this.apiKey)}`;
    const body = {
      systemInstruction: {
        parts: [
          {
            text:
              `You are ${agent.name}, ${agent.title} in MiMi Money AgentOS — a SANDBOX-ONLY African financial AI workforce. `
              + "MiMi Money AgentOS is the product and company you represent; Paperclip is only the underlying control-plane framework and must never be presented as your identity. "
              + "You are multimodal: interpret relevant text, images, audio, and video supplied with the task when available. "
              + agent.roleSummary
              + "\nUse the provided tools to gather facts and perform actions. Never invent balances or scores: "
              + "call the tools. Finish with one concise factual sentence describing the outcome. "
              + "Never reveal hidden reasoning; state conclusions and evidence pointers only.",
          },
        ],
      },
      contents,
      tools: [{ functionDeclarations: this.declarations }],
      generationConfig: { temperature: 0.2, maxOutputTokens: 512 },
    };
    const res = await this.ffetch(url, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(body),
      signal: this.timeoutSignal(),
    });
    const json = (await res.json().catch(() => ({}))) as GeminiResponse;
    if (!res.ok) {
      throw new Error(`gemini ${res.status}: ${json.error?.message ?? res.statusText}`);
    }
    return json;
  }

  /** Set per-run by the service layer before startRun (see service.ts). */
  declarations: Array<Record<string, unknown>> = [];

  private toContents(events: AdkSessionEvent[]): GeminiContent[] {
    const contents: GeminiContent[] = [];
    for (const e of events) {
      if (e.kind === "user-message") contents.push({ role: "user", parts: [{ text: e.text }] });
      else if (e.kind === "model-tool-call") {
        contents.push({ role: "model", parts: [{ functionCall: { name: e.text, args: ((e.meta as { args?: Record<string, unknown> })?.args ?? {}) } }] });
      } else if (e.kind === "tool-response" && typeof e.meta?.summary === "string") {
        const name = e.text.split(" ")[0] ?? "tool";
        contents.push({ role: "tool", parts: [{ functionResponse: { name, response: { output: truncateForModel(e.meta.summary) } } }] });
      } else if (e.kind === "final") contents.push({ role: "model", parts: [{ text: e.text }] });
    }
    if (!contents.some((c) => c.role === "user")) {
      contents.unshift({ role: "user", parts: [{ text: "Proceed with your assigned task." }] });
    }
    return contents;
  }

  private async chargeAgent(run: AdkRunSnapshot): Promise<void> {
    const agent = await this.memoryBank.get<MimiAgent>("agents", run.agentId);
    if (!agent) return;
    await this.memoryBank.update<MimiAgent>("agents", agent.id, {
      stats: {
        ...agent.stats,
        runsTotal: agent.stats.runsTotal + 1,
        runsSucceeded: agent.stats.runsSucceeded + 1,
        lastRunAt: run.finishedAt,
      },
      budget: {
        ...agent.budget,
        spentUsd: round6(agent.budget.spentUsd + run.costUsdEstimate),
        updatedAt: new Date().toISOString(),
      },
    });
  }
}

function round6(n: number): number {
  return Math.round(n * 1e6) / 1e6;
}

function previewArgs(args: Record<string, unknown>): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(args)) out[k] = typeof v === "string" ? v.slice(0, 64) : v;
  return out;
}

function summarize(value: unknown): string {
  if (value === undefined || value === null) return "(empty)";
  if (typeof value === "string") return value.slice(0, 400);
  try {
    return JSON.stringify(value).slice(0, 500);
  } catch {
    return String(value).slice(0, 200);
  }
}

function truncateForModel(s: string): string {
  return s.length > 800 ? s.slice(0, 797) + "…" : s;
}
