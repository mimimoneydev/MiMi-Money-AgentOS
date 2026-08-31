import { useQuery } from "@tanstack/react-query";
import { Link } from "@/lib/router";
import { mimiApi, type MimiAgent } from "@/api/mimi";
import { useMimiLive, PageHeader, Panel, StatusBadge, formatWhen } from "./shared";
import { Bot } from "lucide-react";

/** Departments of the MiMi financial AI organization. */
const DEPARTMENTS: Record<string, { name: string; mission: string }> = {
  "payments-ops": { name: "Payments Operations", mission: "Move value across African corridors safely and audited." },
  "risk-fraud": { name: "Risk & Fraud Intelligence", mission: "Stop fraud before value leaves the building." },
  "compliance-regulatory": { name: "Compliance & Regulatory", mission: "Keep every flow inside KYC/AML obligations." },
  "finance-treasury": { name: "Finance & Treasury", mission: "Reconcile, settle and report every sandbox dollar." },
  "customer-experience": { name: "Customer Experience", mission: "Keep customers informed; humans one tap away." },
};

/**
 * Agent Fleet — the whole financial AI workforce on one board with live
 * statuses driven by backend heartbeats.
 */
export function MimiFleet() {
  useMimiLive();
  const { data } = useQuery({ queryKey: ["mimi", "fleet"], queryFn: () => mimiApi.fleet(), refetchInterval: 4_000 });
  const agents = data?.agents ?? [];
  const roots = agents.filter((a) => !a.managerId);

  return (
    <div>
      <PageHeader
        title="Agent Fleet"
        subtitle={`${agents.length} ADK agents · runtime ${data?.adkMode ?? "—"} · model ${data?.model ?? "—"}`}
      />
      <div className="space-y-6">
        {roots.map((root) => (
          <div key={root.id}>
            <OrgNode agent={root} large />
            <div className="ml-6 border-l border-mimi-grid pl-5">
              <div className="grid gap-3 pt-3 md:grid-cols-2 xl:grid-cols-3">
                {agents.filter((a) => a.managerId === root.id).map((child) => (
                  <OrgCard key={child.id} agent={child} />
                ))}
              </div>
              {agents.some((a) => a.managerId && agents.find((p) => p.id === a.managerId)?.managerId === root.id) ? (
                <div className="pt-1 text-xs text-muted-foreground">…reports into department leads above (see Organization for the full tree).</div>
              ) : null}
            </div>
          </div>
        ))}
      </div>
    </div>
  );
}

function OrgNode({ agent, large }: { agent: MimiAgent; large?: boolean }) {
  return (
    <Link
      to={`/mimi/agents/${agent.id}`}
      className={`flex items-center gap-3 rounded-lg border border-border bg-card px-4 py-3 transition-colors hover:border-mimi-accent ${large ? "" : ""}`}
    >
      <span className="flex size-9 items-center justify-center rounded-md border border-mimi-grid bg-mimi-surface text-mimi-accent-strong">
        <Bot className="size-5" />
      </span>
      <div className="min-w-0 flex-1">
        <div className={`truncate font-semibold text-foreground ${large ? "text-sm" : "text-sm"}`}>{agent.name}</div>
        <div className="truncate text-xs text-muted-foreground">{agent.title} · {DEPARTMENTS[agent.departmentId]?.name ?? agent.departmentId}</div>
      </div>
      <StatusBadge status={agent.status} />
    </Link>
  );
}

function OrgCard({ agent }: { agent: MimiAgent }) {
  const successRate = agent.stats.runsTotal === 0 ? null : Math.round((agent.stats.runsSucceeded / agent.stats.runsTotal) * 100);
  return (
    <Link
      to={`/mimi/agents/${agent.id}`}
      className="group rounded-lg border border-border bg-card p-3 transition-colors hover:border-mimi-accent"
    >
      <div className="flex items-center gap-2">
        <span className="flex size-7 items-center justify-center rounded-md border border-mimi-grid bg-mimi-surface text-mimi-accent-strong">
          <Bot className="size-4" />
        </span>
        <div className="min-w-0 flex-1">
          <div className="truncate text-sm font-medium text-foreground group-hover:text-mimi-accent-strong">{agent.name}</div>
          <div className="truncate text-xs text-muted-foreground">{DEPARTMENTS[agent.departmentId]?.name ?? agent.departmentId}</div>
        </div>
        <StatusBadge status={agent.status} />
      </div>
      <div className="mt-2 flex items-center justify-between text-xs text-muted-foreground">
        <span>heartbeat {formatWhen(agent.heartbeatAt)}</span>
        <span>{successRate == null ? "no runs yet" : `${successRate}% success`}</span>
      </div>
    </Link>
  );
}

/** Organization — departments, missions and reporting lines. */
export function MimiOrganization() {
  useMimiLive();
  const { data } = useQuery({ queryKey: ["mimi", "fleet"], queryFn: () => mimiApi.fleet(), refetchInterval: 8_000 });
  const agents = data?.agents ?? [];
  return (
    <div>
      <PageHeader title="Organization" subtitle="Departments, managers and reporting lines of the MiMi workforce." />
      <div className="space-y-4">
        {Object.entries(DEPARTMENTS).map(([deptId, dept]) => {
          const members = agents.filter((a) => a.departmentId === deptId);
          const lead = members.find((a) => members.every((m) => m.managerId !== a.id)) ?? members[0];
          return (
            <Panel key={deptId} title={dept.name} subtitle={dept.mission}>
              <ul className="grid gap-2 md:grid-cols-2 xl:grid-cols-3">
                {members.map((m) => (
                  <li key={m.id}>
                    <Link
                      to={`/mimi/agents/${m.id}`}
                      className="flex items-center justify-between rounded-md border border-border px-3 py-2 transition-colors hover:border-mimi-accent"
                    >
                      <span>
                        <span className="text-sm font-medium text-foreground">{m.name}</span>
                        <span className="block text-xs text-muted-foreground">
                          {lead?.id === m.id ? "Department head" : `reports to ${agents.find((p) => p.id === m.managerId)?.name ?? "—"}`}
                        </span>
                      </span>
                      <StatusBadge status={m.status} />
                    </Link>
                  </li>
                ))}
                {members.length === 0 ? <li className="text-sm text-muted-foreground">No agents assigned.</li> : null}
              </ul>
            </Panel>
          );
        })}
      </div>
    </div>
  );
}
