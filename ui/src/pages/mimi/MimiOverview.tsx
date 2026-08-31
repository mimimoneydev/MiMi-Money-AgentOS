import { useState } from "react";
import { useQuery } from "@tanstack/react-query";
import { Link } from "@/lib/router";
import { mimiApi } from "@/api/mimi";
import { useMimiLive } from "./shared";
import { Metric, PageHeader, Panel, DemoBadge, StatusBadge, formatUsd, formatWhen } from "./shared";
import { Zap, ShieldAlert, Scale, RadioTower } from "lucide-react";

/**
 * MiMi Money AgentOS command overview — live counts straight from the backend:
 * agent fleet health, workflow throughput, human review load, transaction
 * metrics, fraud/compliance alerts and the rolling event feed.
 */
export function MimiOverview() {
  useMimiLive();
  const [flash, setFlash] = useState<string | null>(null);
  const { data: overview } = useQuery({ queryKey: ["mimi", "overview"], queryFn: () => mimiApi.overview(), refetchInterval: 5_000 });
  const { data: system } = useQuery({ queryKey: ["mimi", "system"], queryFn: () => mimiApi.system() });

  const trigger = async (kind: "low" | "high") => {
    const result = kind === "low" ? await mimiApi.simulateLow() : await mimiApi.simulateHigh();
    setFlash(result.message);
    setTimeout(() => setFlash(null), 6_000);
  };

  return (
    <div>
      <PageHeader
        title="Overview"
        subtitle="Live African financial AI workforce — every number comes from real backend state."
        actions={<DemoBadge />}
      />

      <div className="mb-4 flex flex-wrap items-center gap-3 rounded-lg border border-mimi-accent bg-mimi-accent-soft p-4">
        <div className="flex-1">
          <div className="text-sm font-semibold text-foreground">Run the money demo</div>
          <div className="text-xs text-muted-foreground">
            Triggers the real pipeline: Pub/Sub → ADK agents → Gateway → Policy Engine → Firestore Memory Bank.
          </div>
        </div>
        <button
          type="button"
          onClick={() => void trigger("low")}
          className="inline-flex items-center gap-2 rounded-md border border-mimi-positive bg-mimi-positive/15 px-3 py-2 text-sm font-semibold text-mimi-positive transition-colors hover:bg-mimi-positive/25"
        >
          <Zap className="size-4" />
          SIMULATE $250 LOW-RISK PAYMENT
        </button>
        <button
          type="button"
          onClick={() => void trigger("high")}
          className="inline-flex items-center gap-2 rounded-md border border-mimi-danger bg-mimi-danger/15 px-3 py-2 text-sm font-semibold text-mimi-danger transition-colors hover:bg-mimi-danger/25"
        >
          <ShieldAlert className="size-4" />
          SIMULATE $48,500 HIGH-RISK PAYMENT
        </button>
      </div>

      {flash ? (
        <div className="mb-4 rounded-md border border-mimi-info bg-mimi-info/10 px-4 py-2 text-sm text-mimi-info">{flash}</div>
      ) : null}

      <div className="grid grid-cols-2 gap-3 lg:grid-cols-4">
        <Metric label="Agents live" value={overview?.agents.total ?? "—"} hint={`${overview?.agents.healthyPct ?? 100}% healthy`} tone="positive" />
        <Metric
          label="Running workflows"
          value={overview?.workflows.running ?? "—"}
          hint={`${overview?.workflows.waitingForHuman ?? 0} waiting for human`}
          tone={overview && overview.workflows.waitingForHuman > 0 ? "warning" : "default"}
        />
        <Metric
          label="Pending reviews"
          value={overview?.reviews.pending ?? "—"}
          hint={`${overview?.reviews.decidedToday ?? 0} decided today`}
          tone={overview && overview.reviews.pending > 0 ? "warning" : "default"}
        />
        <Metric label="Autonomous actions" value={overview?.autonomousActions ?? "—"} hint="gateway-approved tool executions" />
        <Metric label="Volume (24h)" value={formatUsd(overview?.transactions.todayVolumeUsd ?? 0)} hint={`${overview?.transactions.todayCount ?? 0} payments simulated`} />
        <Metric label="Settled total" value={formatUsd(overview?.transactions.settledTotalUsd ?? 0)} hint="sandbox ledger" tone="positive" />
        <Metric
          label="Fraud / compliance alerts"
          value={`${overview?.alerts.fraudOpen ?? 0} / ${overview?.alerts.complianceOpen ?? 0}`}
          hint="open cases"
          tone={overview && overview.alerts.fraudOpen + overview.alerts.complianceOpen > 0 ? "danger" : "positive"}
        />
        <Metric label="Event throughput" value={`${overview?.eventThroughputPerMin ?? 0}/min`} hint={`DLQ ${overview?.alerts.dlq ?? 0} · ${system?.pubsub.published ?? 0} published`} />
      </div>

      <div className="mt-4 grid gap-4 xl:grid-cols-2">
        <Panel
          title="Agent fleet status"
          subtitle="MiMi Money AgentOS org chart with heartbeats"
          actions={
            <Link to="/mimi/fleet" className="text-xs font-medium text-mimi-accent-strong hover:underline">
              Open fleet →
            </Link>
          }
        >
          <div className="flex flex-wrap gap-2">
            {Object.entries(overview?.agents.byStatus ?? {}).map(([status, count]) => (
              <span key={status} className="inline-flex items-center gap-1.5 rounded-md border border-border px-2 py-1 text-xs">
                <StatusBadge status={status} /> <span className="tabular-nums text-muted-foreground">×{count}</span>
              </span>
            ))}
          </div>
          <ul className="mt-3 space-y-1.5">
            {(overview?.recentEvents ?? []).slice(0, 6).map((e, i) => (
              <li key={`${e.at}-${i}`} className="flex items-baseline gap-2 text-xs">
                <span className="font-mono text-muted-foreground">{formatWhen(e.at)}</span>
                <span className="font-medium text-foreground">{e.source}</span>
                <span className="text-muted-foreground">{e.type}</span>
                <span className="truncate text-muted-foreground">— {e.summary}</span>
              </li>
            ))}
          </ul>
        </Panel>

        <Panel title="System posture" subtitle="Zero/near-zero-cost Google stack, sandbox only">
          <div className="grid gap-2 sm:grid-cols-2">
            <PostureRow icon={<RadioTower className="size-4" />} label="Pub/Sub backbone" value={system?.pubsub.configured ? (system.pubsub.emulator ? `emulator · ${system.pubsub.projectId}` : `gcp · ${system.pubsub.projectId}`) : "in-process transport"} ok />
            <PostureRow icon={<Scale className="size-4" />} label="Memory Bank" value={system?.memoryBank.mode === "in-memory" ? "embedded store" : `${system?.memoryBank.mode}${system?.memoryBank.projectId ? ` · ${system.memoryBank.projectId}` : ""}`} ok />
            <PostureRow label="Intelligence" value={`${system?.intelligence.provider ?? "Gemini"} · ${system?.intelligence.model ?? "—"}`} ok />
            <PostureRow label="Agent runtime" value={`Google ADK · ${system?.runtime.mode === "gemini" ? "gemini mode" : "local simulation"}`} ok />
            <PostureRow label="Gateway pipeline" value={`${system?.gateway.toolsRegistered ?? 0} tools · ${system?.gateway.pipeline.length ?? 9}-stage authorization`} ok />
            <PostureRow label="Control plane" value="MiMi Money AgentOS (tasks, approvals, budgets, activity)" ok />
          </div>
          <p className="mt-3 rounded-md border border-border bg-muted px-3 py-2 text-xs text-muted-foreground">
            {system?.demoBanner ?? "DEMO / SANDBOX MODE — no real funds are ever moved"}
          </p>
        </Panel>
      </div>
    </div>
  );
}

function PostureRow(props: { icon?: React.ReactNode; label: string; value: string; ok?: boolean }) {
  return (
    <div className="flex items-start gap-2 rounded-md border border-border bg-background px-3 py-2">
      <span className="mt-0.5 text-mimi-accent-strong">{props.icon}</span>
      <div className="min-w-0">
        <div className="text-xs font-medium text-foreground">{props.label}</div>
        <div className="truncate text-xs text-muted-foreground">{props.value}</div>
      </div>
      {props.ok ? <span className="ml-auto mt-1 size-1.5 rounded-full bg-mimi-positive" aria-label="healthy" /> : null}
    </div>
  );
}
