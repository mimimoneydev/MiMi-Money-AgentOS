import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { mimiApi } from "@/api/mimi";
import { useMimiLive, PageHeader, Panel, Metric, StatusBadge, formatWhen } from "./shared";

/** Agent budgets with hard-stop enforcement. */
export function MimiBudgets() {
  useMimiLive();
  const queryClient = useQueryClient();
  const { data } = useQuery({ queryKey: ["mimi", "budgets"], queryFn: () => mimiApi.budgets(), refetchInterval: 5_000 });
  const reset = useMutation({
    mutationFn: (agentId: string) => mimiApi.resetBudget(agentId),
    onSuccess: () => void queryClient.invalidateQueries({ queryKey: ["mimi"] }),
  });

  return (
    <div>
      <PageHeader
        title="Budgets"
        subtitle="Monthly model/runtime spend per agent. Hard stop pauses the agent at the cap — MiMi Money AgentOS cost governance."
      />
      <div className="grid gap-3 md:grid-cols-2 xl:grid-cols-3">
        {(data?.budgets ?? []).map((b) => (
          <Panel key={b.id}>
            <div className="flex items-center justify-between gap-2">
              <span className="font-semibold text-foreground">{b.name}</span>
              <StatusBadge status={b.status} />
            </div>
            <div className="mt-2 h-2 overflow-hidden rounded-full bg-muted">
              <div
                className={`h-full rounded-full ${b.utilizationPct > 90 ? "bg-mimi-danger" : b.utilizationPct > 60 ? "bg-mimi-warning" : "bg-mimi-positive"}`}
                style={{ width: `${Math.max(b.utilizationPct, 1)}%` }}
              />
            </div>
            <div className="mt-1.5 flex items-baseline justify-between text-xs tabular-nums text-muted-foreground">
              <span>${b.budget.spentUsd.toFixed(4)} / ${b.budget.monthlyLimitUsd.toFixed(0)}</span>
              <span>{b.utilizationPct}%</span>
            </div>
            <div className="mt-2 flex items-center justify-between text-xs text-muted-foreground">
              <span>runs {b.stats.runsTotal} · ok {b.stats.runsSucceeded}{b.stats.runsFailed ? ` · failed ${b.stats.runsFailed}` : ""}</span>
              <button
                type="button"
                onClick={() => reset.mutate(b.id)}
                className="rounded border border-border px-2 py-0.5 hover:border-mimi-accent hover:text-mimi-accent-strong"
              >
                Reset spend
              </button>
            </div>
          </Panel>
        ))}
      </div>
    </div>
  );
}

/** System health — subsystem posture for the whole stack. */
export function MimiSystem() {
  useMimiLive();
  const queryClient = useQueryClient();
  const { data: s } = useQuery({ queryKey: ["mimi", "system"], queryFn: () => mimiApi.system(), refetchInterval: 5_000 });
  const recover = useMutation({
    mutationFn: () => mimiApi.recover(),
    onSuccess: () => void queryClient.invalidateQueries({ queryKey: ["mimi"] }),
  });

  return (
    <div>
      <PageHeader
        title="System"
        subtitle="Zero/near-zero-cost architecture: Cloud Run + Pub/Sub + Firestore + Gemini/ADK. No GKE, no Cloud SQL."
        actions={
          <button
            type="button"
            onClick={() => recover.mutate()}
            className="rounded-md border border-border px-3 py-1.5 text-xs font-medium hover:border-mimi-accent"
          >
            Run recovery pass
          </button>
        }
      />

      <div className="grid grid-cols-2 gap-3 lg:grid-cols-4">
        <Metric label="Pub/Sub transport" value={s?.pubsub.configured ? (s.pubsub.emulator ? "Emulator" : "GCP") : "In-process"} hint={`${s?.pubsub.published ?? 0} published`} />
        <Metric label="Duplicates suppressed" value={s?.pubsub.duplicatesSuppressed ?? 0} hint="idempotency working" tone={(s?.pubsub.duplicatesSuppressed ?? 0) > 0 ? "positive" : "default"} />
        <Metric label="Retries" value={s?.pubsub.retries ?? 0} hint={`DLQ ${s?.pubsub.deadLetters ?? 0}`} tone={(s?.pubsub.deadLetters ?? 0) > 0 ? "danger" : "positive"} />
        <Metric label="Fleet" value={`${s?.fleet.total ?? 0} agents`} hint={s?.fleet.paused ? `${s.fleet.paused} paused` : "none paused"} tone={s?.fleet.paused ? "warning" : "positive"} />
      </div>

      {recover.data ? (
        <p className="mt-3 rounded-md border border-mimi-info bg-mimi-info/10 px-3 py-2 text-sm text-mimi-info">
          Recovery pass re-drove {recover.data.recovered} in-flight workflow(s) from persisted Memory Bank state.
        </p>
      ) : null}

      <div className="mt-4 grid gap-4 xl:grid-cols-2">
        <Panel title="Stack wiring" subtitle="What is running where">
          <dl className="space-y-2 text-sm">
            <SysRow k="Control plane" v={s?.controlPlane.name} note={s?.controlPlane.capabilities.join(" · ")} />
            <SysRow k="Intelligence" v={`${s?.intelligence.provider} — multimodal`} note={`${s?.intelligence.missionCriticalModel} mission-critical · ${s?.intelligence.lightweightModel} lightweight · ${s?.intelligence.modalities?.join(", ")} · API key ${s?.intelligence.apiKeyConfigured ? "configured" : "not set (local simulation mode)"}`} />
            <SysRow k="Agent runtime" v={`Google ADK (${s?.runtime.mode})`} note={`${s?.runtime.framework} via ${s?.runtime.adapter} · Cloud Run template ${s?.runtime.cloudRunServiceTemplate} · ${s?.runtime.region}`} />
            <SysRow k="Gateway" v={`${s?.gateway.toolsRegistered} tools registered`} note={s?.gateway.pipeline.join(" → ")} />
            <SysRow k="Memory Bank" v={s?.memoryBank.mode} note={s?.memoryBank.projectId ? `project ${s.memoryBank.projectId}` : "embedded store (set FIRESTORE_EMULATOR_HOST or GOOGLE_CLOUD_PROJECT to switch)"} />
            <SysRow k="Pub/Sub" v={s?.pubsub.configured ? `${s.pubsub.projectId}${s.pubsub.emulator ? " (emulator)" : ""}` : "in-process transport"} note={`${s?.pubsub.topics.length ?? 0} topics wired`} />
          </dl>
        </Panel>

        <Panel title="Topics" subtitle="The nervous system of MiMi Money AgentOS">
          <ul className="flex flex-wrap gap-1.5">
            {(s?.pubsub.topics ?? []).map((t) => (
              <li key={t} className="rounded-md border border-mimi-grid bg-mimi-surface px-2 py-1 font-mono text-(length:--text-compact)">{t}</li>
            ))}
          </ul>
          <h3 className="mt-4 mb-2 text-xs font-semibold tracking-wide text-muted-foreground uppercase">Dead-letter queue</h3>
          {(s?.deadLetterQueue ?? []).length === 0 ? (
            <p className="text-sm text-mimi-positive">Empty — every event delivered.</p>
          ) : (
            <ul className="space-y-1.5">
              {s?.deadLetterQueue.map((d) => (
                <li key={d.id} className="rounded-md border border-mimi-danger/40 px-2.5 py-1.5 text-xs">
                  <span className="font-semibold text-foreground">{d.type}</span>{" "}
                  <span className="text-muted-foreground">{d.topic} · {d.attempts} attempts</span>
                  <div className="text-mimi-danger">{d.reason}</div>
                </li>
              ))}
            </ul>
          )}
          <p className="mt-4 rounded-md border border-border bg-muted px-3 py-2 text-xs text-muted-foreground">{s?.demoBanner}</p>
        </Panel>
      </div>
    </div>
  );
}

function SysRow(props: { k: string; v?: string; note?: string }) {
  return (
    <div className="border-b border-border pb-2 last:border-none">
      <div className="flex items-baseline justify-between gap-3">
        <dt className="text-xs text-muted-foreground">{props.k}</dt>
        <dd className="font-medium text-foreground">{props.v ?? "—"}</dd>
      </div>
      {props.note ? <p className="mt-0.5 line-clamp-2 text-(length:--text-nano) text-muted-foreground">{props.note}</p> : null}
    </div>
  );
}
