import type { AdkRunSnapshot, MemoryBank, MimiAgent } from "./types.js";
import { AdkRuntimeError, BaseAdkRuntime } from "./adk-gemini-runtime.js";
import { geminiModelForAgent } from "./constants.js";

/**
 * GoogleAdkRemoteRuntime — AgentRuntimeAdapter that delegates execution to a
 * real Google ADK Python service (`services/mimi-adk-runtime`) running the
 * official `google-adk` package with Gemini models.
 *
 * Contract (POST {baseUrl}/runs):
 *   body:  { runId, agentId, instruction, context, workflowId, stepKey,
 *            gatewayToolCallUrl, gatewayToken?, model? }
 *   200:   { run: AdkRunSnapshot }
 *
 * The Python side executes an actual google.adk Runner (LlmAgent + Gemini
 * function calling). Its tools call privileged capability BACK through the
 * MiMi Agent Gateway HTTP surface, so identity → RBAC → policy → audit
 * enforcement stays identical no matter which adapter executed the run.
 */
export class GoogleAdkRemoteRuntime extends BaseAdkRuntime {
  readonly modeName = "remote" as const;
  readonly model: string;
  private readonly lightModel: string;
  private readonly baseUrl: string;
  private readonly ffetch: typeof fetch;
  private readonly timeoutMs: number;
  /** Injected by the service layer before each startRun (see service.ts). */
  gatewayToolCallUrl: string | null = null;
  gatewayToken: string | null = null;

  constructor(
    memoryBank: MemoryBank,
    opts: {
      baseUrl?: string;
      model?: string;
      fetchImpl?: typeof fetch;
      timeoutMs?: number;
    } = {},
  ) {
    super(memoryBank, { timeoutMs: opts.timeoutMs });
    const url = opts.baseUrl?.trim() || process.env.MIMI_ADK_RUNTIME_URL?.trim() || "";
    if (!url) throw new AdkRuntimeError("unavailable", "MIMI_ADK_RUNTIME_URL is required for remote ADK mode");
    this.baseUrl = url.replace(/\/$/, "");
    this.model = opts.model?.trim() || process.env.MIMI_GEMINI_MODEL?.trim() || "gemini-3.6-flash";
    this.lightModel = process.env.MIMI_GEMINI_LIGHT_MODEL?.trim() || "gemini-3.5-flash";
    this.ffetch = opts.fetchImpl ?? fetch;
    this.timeoutMs = opts.timeoutMs ?? 60_000;
  }

  async startRun(runId: string): Promise<AdkRunSnapshot> {
    let run = await this.inspectRun(runId);
    if (!run) throw new AdkRuntimeError("model-error", `run ${runId} not found`);
    const selectedModel = geminiModelForAgent(run.agentId, this.model, this.lightModel);
    run.model = selectedModel;
    run.status = "RUNNING";
    await this.save(run);
    try {
      const res = await this.ffetch(`${this.baseUrl}/runs`, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          ...(this.gatewayToken ? { Authorization: `Bearer ${this.gatewayToken}` } : {}),
        },
        body: JSON.stringify({
          runId: run.runId,
          agentId: run.agentId,
          instruction: this.instructionOf(run),
          context: this.contextOf(run),
          workflowId: run.workflowId,
          stepKey: run.stepKey,
          gatewayToolCallUrl: this.gatewayToolCallUrl,
          model: selectedModel,
        }),
        signal: AbortSignal.timeout(this.timeoutMs),
      });
      const json = (await res.json().catch(() => ({}))) as { run?: AdkRunSnapshot; error?: string };
      if (!res.ok || !json.run) {
        throw new Error(json.error ?? `remote ADK service ${res.status}`);
      }
      // Persist the authoritative snapshot from the ADK service, keeping the
      // control-plane-assigned runId canonical.
      const merged: AdkRunSnapshot & { id: string } = {
        ...json.run,
        runId: run.runId,
        id: run.runId,
        workflowId: run.workflowId,
        stepKey: run.stepKey,
        adapterMode: "remote",
        model: selectedModel,
      };
      await this.save(merged);
      await this.chargeAgent(merged);
      return merged;
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      const fresh = await this.inspectRun(runId);
      if (fresh) {
        fresh.status = /timeout|aborted/i.test(message) ? "TIMEOUT" : "FAILED";
        fresh.error = message;
        fresh.finishedAt = new Date().toISOString();
        fresh.sessionEvents.push({ at: fresh.finishedAt, kind: "error", text: message });
        await this.save(fresh);
      }
      throw new AdkRuntimeError(/timeout/i.test(message) ? "timeout" : "model-error", message);
    }
  }

  private instructionOf(run: AdkRunSnapshot): string {
    const first = run.sessionEvents.find((e) => e.kind === "user-message");
    return first?.text ?? "Proceed with your assigned task.";
  }

  private contextOf(run: AdkRunSnapshot): Record<string, unknown> {
    const first = run.sessionEvents.find((e) => e.kind === "user-message");
    return ((first?.meta as { context?: Record<string, unknown> })?.context ?? {}) as Record<string, unknown>;
  }

  private async chargeAgent(run: AdkRunSnapshot): Promise<void> {
    if (run.status !== "COMPLETED") return;
    const agent = await this.memoryBank.get<MimiAgent>("agents", run.agentId);
    if (!agent) return;
    const round6 = (n: number) => Math.round(n * 1e6) / 1e6;
    await this.memoryBank.update<MimiAgent>("agents", agent.id, {
      stats: {
        ...agent.stats,
        runsTotal: agent.stats.runsTotal + 1,
        runsSucceeded: agent.stats.runsSucceeded + 1,
        lastRunAt: run.finishedAt,
      },
      budget: {
        ...agent.budget,
        spentUsd: round6(agent.budget.spentUsd + (run.costUsdEstimate || 0)),
        updatedAt: new Date().toISOString(),
      },
      heartbeatAt: new Date().toISOString(),
    });
  }
}
