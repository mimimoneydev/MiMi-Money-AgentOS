import { useQuery } from "@tanstack/react-query";
import { Link, useParams } from "@/lib/router";
import { mimiApi } from "@/api/mimi";
import { useMimiLive, PageHeader, Panel, StatusBadge, formatWhen } from "./shared";
import { ArrowLeft } from "lucide-react";

/** Agent Inspector — full identity card for one ADK workforce member. */
export function MimiAgentInspector() {
  useMimiLive();
  const { agentId = "" } = useParams();
  const { data: agent } = useQuery({
    queryKey: ["mimi", "agent", agentId],
    queryFn: () => mimiApi.agent(agentId),
    refetchInterval: 4_000,
  });

  if (!agent) {
    return <div className="p-6 text-sm text-muted-foreground">Loading agent…</div>;
  }

  const successRate = agent.stats.runsTotal === 0 ? null : Math.round((agent.stats.runsSucceeded / agent.stats.runsTotal) * 100);
  const budgetPct = Math.min(100, Math.round((agent.budget.spentUsd / Math.max(agent.budget.monthlyLimitUsd, 0.000001)) * 100));

  return (
    <div>
      <Link to="/mimi/agents" className="mb-3 inline-flex items-center gap-1 text-xs font-medium text-muted-foreground hover:text-foreground">
        <ArrowLeft className="size-3.5" /> All agents
      </Link>
      <PageHeader
        title={agent.name}
        subtitle={`${agent.title} — ${agent.roleSummary}`}
        actions={<StatusBadge status={agent.status} />}
      />

      <div className="grid gap-4 xl:grid-cols-3">
        <Panel title="Identity & org" className="xl:col-span-1">
          <dl className="space-y-2 text-sm">
            <Row label="Agent ID" value={<span className="font-mono text-xs">{agent.id}</span>} />
            <Row label="Department" value={agent.departmentId} />
            <Row label="Manager" value={agent.managerId ?? "— (board)"} />
            <Row label="Current task" value={agent.currentTask ?? "idle"} />
            <Row label="Heartbeat" value={formatWhen(agent.heartbeatAt)} />
          </dl>
          <h3 className="mt-4 mb-1.5 text-xs font-semibold tracking-wide text-muted-foreground uppercase">Capabilities</h3>
          <ul className="flex flex-wrap gap-1.5">
            {agent.capabilities.map((c) => (
              <li key={c} className="rounded border border-mimi-grid bg-mimi-surface px-1.5 py-0.5 font-mono text-(length:--text-compact) text-foreground">{c}</li>
            ))}
          </ul>
          <h3 className="mt-4 mb-1.5 text-xs font-semibold tracking-wide text-muted-foreground uppercase">Memory scope</h3>
          <ul className="flex flex-wrap gap-1.5">
            {agent.memoryScope.map((c) => (
              <li key={c} className="rounded border border-border bg-muted px-1.5 py-0.5 font-mono text-(length:--text-compact) text-muted-foreground">{c}</li>
            ))}
          </ul>
        </Panel>

        <Panel title="Runtime" subtitle="Google ADK + Gemini via the MiMi Gateway" className="xl:col-span-1">
          <dl className="space-y-2 text-sm">
            <Row label="Framework" value={`${agent.runtime.adapter} (${agent.runtime.mode})`} />
            <Row label="Gemini model" value={<span className="font-mono text-xs">{agent.runtime.model}</span>} />
            <Row label="Cloud Run service" value={<span className="font-mono text-xs">{agent.runtime.cloudRunService}</span>} />
            <Row label="Region" value={agent.runtime.region} />
            <Row
              label="Success rate"
              value={
                successRate == null ? "no runs yet" : (
                  <span className="tabular-nums">
                    {successRate}% <span className="text-xs text-muted-foreground">({agent.stats.runsSucceeded}/{agent.stats.runsTotal})</span>
                  </span>
                )
              }
            />
            {agent.stats.lastError ? <Row label="Last error" value={<span className="text-xs text-mimi-danger">{agent.stats.lastError}</span>} /> : null}
          </dl>
          <h3 className="mt-4 mb-1.5 text-xs font-semibold tracking-wide text-muted-foreground uppercase">
            Budget — {agent.budget.hardStop ? "hard stop enabled" : "advisory"}
          </h3>
          <div className="h-2 overflow-hidden rounded-full bg-muted">
            <div
              className={`h-full rounded-full ${budgetPct > 90 ? "bg-mimi-danger" : budgetPct > 60 ? "bg-mimi-warning" : "bg-mimi-positive"}`}
              style={{ width: `${Math.max(budgetPct, 1)}%` }}
            />
          </div>
          <div className="mt-1 flex justify-between text-xs text-muted-foreground tabular-nums">
            <span>${agent.budget.spentUsd.toFixed(4)} spent</span>
            <span>cap ${agent.budget.monthlyLimitUsd.toFixed(0)}/mo</span>
          </div>
        </Panel>

        <Panel title="Gateway permissions" subtitle="Tools this agent may request (policy still applies)" className="xl:col-span-1">
          <ul className="space-y-1.5">
            {agent.permissions.map((p) => {
              const tool = agent.toolCatalog.find((t) => t.name === p);
              return (
                <li key={p} className="flex items-center justify-between rounded-md border border-border px-2.5 py-1.5">
                  <span className="font-mono text-xs text-foreground">{p}</span>
                  {tool ? <span className="text-(length:--text-compact) text-muted-foreground">{tool.capabilityClass}</span> : null}
                </li>
              );
            })}
          </ul>
        </Panel>
      </div>

      <Panel title="Recent ADK runs" subtitle="Session events, tool calls and outcomes" className="mt-4">
        {(agent.recentRuns ?? []).length === 0 ? (
          <p className="text-sm text-muted-foreground">No runs recorded yet for this agent.</p>
        ) : (
          <ul className="space-y-2">
            {agent.recentRuns.map((run) => (
              <li key={run.runId} className="rounded-md border border-border p-3">
                <div className="flex flex-wrap items-center gap-2">
                  <span className="font-mono text-xs text-muted-foreground">{run.runId}</span>
                  <StatusBadge status={run.status} />
                  <span className="text-xs text-muted-foreground">
                    {run.adapterMode} · {run.iterations} iterations · {run.toolCalls.length} tool calls · started {formatWhen(run.startedAt)}
                  </span>
                </div>
                {run.outputText ? <p className="mt-1 line-clamp-2 text-sm text-foreground">{run.outputText}</p> : null}
                {run.error ? <p className="mt-1 text-xs text-mimi-danger">{run.error}</p> : null}
                {run.toolCalls.length > 0 ? (
                  <div className="mt-1.5 flex flex-wrap gap-1">
                    {run.toolCalls.map((tc, i) => (
                      <span key={`${tc.toolName}-${i}`} className="rounded border border-border bg-muted px-1.5 py-0.5 font-mono text-(length:--text-compact) text-muted-foreground">
                        {tc.toolName} → {tc.ok ? "ok" : tc.gatewayDecision}
                      </span>
                    ))}
                  </div>
                ) : null}
              </li>
            ))}
          </ul>
        )}
      </Panel>
    </div>
  );
}

function Row(props: { label: string; value: React.ReactNode }) {
  return (
    <div className="flex items-baseline justify-between gap-3 border-b border-border pb-1.5 last:border-none">
      <dt className="shrink-0 text-xs text-muted-foreground">{props.label}</dt>
      <dd className="min-w-0 truncate text-right font-medium text-foreground">{props.value}</dd>
    </div>
  );
}

/** Agents list — grid of all ten workforce members. */
export function MimiAgents() {
  useMimiLive();
  const { data } = useQuery({ queryKey: ["mimi", "fleet"], queryFn: () => mimiApi.fleet(), refetchInterval: 5_000 });
  return (
    <div>
      <PageHeader title="Agents" subtitle="Every agent is a Google ADK runtime with Gateway-gated tools." />
      <div className="grid gap-3 md:grid-cols-2 xl:grid-cols-3">
        {(data?.agents ?? []).map((a) => {
          const successRate = a.stats.runsTotal === 0 ? null : Math.round((a.stats.runsSucceeded / a.stats.runsTotal) * 100);
          return (
            <Link
              key={a.id}
              to={`/mimi/agents/${a.id}`}
              className="group rounded-lg border border-border bg-card p-4 transition-colors hover:border-mimi-accent"
            >
              <div className="flex items-center justify-between gap-2">
                <span className="truncate font-semibold text-foreground group-hover:text-mimi-accent-strong">{a.name}</span>
                <StatusBadge status={a.status} />
              </div>
              <p className="mt-1 line-clamp-2 text-xs text-muted-foreground">{a.roleSummary}</p>
              <div className="mt-2 flex items-center justify-between text-xs text-muted-foreground">
                <span>{a.runtime.model}</span>
                <span>{successRate == null ? "—" : `${successRate}%`} · hb {formatWhen(a.heartbeatAt)}</span>
              </div>
            </Link>
          );
        })}
      </div>
    </div>
  );
}
