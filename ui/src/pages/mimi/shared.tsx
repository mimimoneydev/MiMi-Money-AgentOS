import { useEffect, useRef } from "react";
import { useQueryClient } from "@tanstack/react-query";
import { subscribeMimiStream, type MimiEvent } from "@/api/mimi";
import { cn } from "@/lib/utils";

/**
 * Live backend events for MiMi Money AgentOS. Subscribes to the server's SSE
 * stream (real backend events, not simulated animations) and invalidates
 * react-query caches so every page reflects actual state.
 */
export function useMimiLive(onEvent?: (event: MimiEvent) => void): void {
  const queryClient = useQueryClient();
  const handlerRef = useRef(onEvent);
  handlerRef.current = onEvent;
  useEffect(() => {
    return subscribeMimiStream((event) => {
      void queryClient.invalidateQueries({ queryKey: ["mimi"] });
      handlerRef.current?.(event);
    });
  }, [queryClient]);
}

const TONES: Record<string, string> = {
  IDLE: "bg-mimi-surface text-mimi-info border-mimi-grid",
  QUEUED: "bg-mimi-accent-soft text-mimi-accent-strong border-mimi-grid",
  RUNNING: "bg-mimi-accent-soft text-mimi-accent-strong border-mimi-accent",
  WAITING: "bg-mimi-warning/15 text-mimi-warning border-mimi-warning",
  WAITING_FOR_HUMAN: "bg-mimi-warning/15 text-mimi-warning border-mimi-warning",
  COMPLETED: "bg-mimi-positive/15 text-mimi-positive border-mimi-positive",
  APPROVED: "bg-mimi-positive/15 text-mimi-positive border-mimi-positive",
  ALLOWED: "bg-mimi-positive/15 text-mimi-positive border-mimi-positive",
  EXECUTED: "bg-mimi-positive/15 text-mimi-positive border-mimi-positive",
  CLEAR: "bg-mimi-positive/15 text-mimi-positive border-mimi-positive",
  SETTLED: "bg-mimi-positive/15 text-mimi-positive border-mimi-positive",
  FAILED: "bg-mimi-danger/15 text-mimi-danger border-mimi-danger",
  DENIED: "bg-mimi-danger/15 text-mimi-danger border-mimi-danger",
  DENY: "bg-mimi-danger/15 text-mimi-danger border-mimi-danger",
  BLOCKED: "bg-mimi-danger/15 text-mimi-danger border-mimi-danger",
  REJECTED: "bg-mimi-danger/15 text-mimi-danger border-mimi-danger",
  ESCALATED: "bg-mimi-danger/15 text-mimi-danger border-mimi-danger",
  PAUSED: "bg-mimi-warning/15 text-mimi-warning border-mimi-warning",
  PENDING: "bg-mimi-accent-soft text-mimi-accent-strong border-mimi-accent",
  REQUIRES_HUMAN: "bg-mimi-warning/15 text-mimi-warning border-mimi-warning",
};

export function StatusBadge({ status, className }: { status: string; className?: string }) {
  const tone = TONES[status] ?? "bg-muted text-muted-foreground border-border";
  return (
    <span
      className={cn(
        "inline-flex items-center gap-1 rounded-md border px-1.5 py-0.5 font-mono text-(length:--text-compact) font-medium tracking-wide uppercase",
        tone,
        className,
      )}
    >
      {status.replace(/_/g, " ")}
    </span>
  );
}

export function PageHeader(props: {
  title: string;
  subtitle: string;
  actions?: React.ReactNode;
}) {
  return (
    <div className="mb-4 flex flex-wrap items-end justify-between gap-3">
      <div>
        <h1 className="text-xl font-semibold tracking-tight text-foreground">{props.title}</h1>
        <p className="mt-0.5 text-sm text-muted-foreground">{props.subtitle}</p>
      </div>
      {props.actions ? <div className="flex items-center gap-2">{props.actions}</div> : null}
    </div>
  );
}

export function Panel(props: {
  title?: string;
  subtitle?: string;
  children: React.ReactNode;
  className?: string;
  actions?: React.ReactNode;
}) {
  return (
    <section className={cn("rounded-lg border border-border bg-card", props.className)}>
      {props.title ? (
        <header className="flex items-center justify-between gap-2 border-b border-border px-4 py-2.5">
          <div>
            <h2 className="text-sm font-semibold text-foreground">{props.title}</h2>
            {props.subtitle ? <p className="text-xs text-muted-foreground">{props.subtitle}</p> : null}
          </div>
          {props.actions}
        </header>
      ) : null}
      <div className="p-4">{props.children}</div>
    </section>
  );
}

export function Metric(props: {
  label: string;
  value: React.ReactNode;
  hint?: string;
  tone?: "default" | "positive" | "warning" | "danger";
}) {
  const valueTone =
    props.tone === "positive"
      ? "text-mimi-positive"
      : props.tone === "warning"
        ? "text-mimi-warning"
        : props.tone === "danger"
          ? "text-mimi-danger"
          : "text-foreground";
  return (
    <div className="rounded-lg border border-border bg-card p-4">
      <div className="text-xs font-medium tracking-wide text-muted-foreground uppercase">{props.label}</div>
      <div className={cn("mt-1 text-2xl font-semibold tabular-nums", valueTone)}>{props.value}</div>
      {props.hint ? <div className="mt-0.5 text-xs text-muted-foreground">{props.hint}</div> : null}
    </div>
  );
}

export function DemoBadge() {
  return (
    <span className="inline-flex items-center gap-1 rounded-md border border-mimi-accent bg-mimi-accent-soft px-2 py-0.5 font-mono text-(length:--text-compact) font-semibold tracking-widest text-mimi-accent-strong uppercase">
      Demo / Sandbox
    </span>
  );
}

export function formatUsd(n: number): string {
  return n.toLocaleString("en-US", { style: "currency", currency: "USD", maximumFractionDigits: 2 });
}

export function formatWhen(iso: string | null): string {
  if (!iso) return "—";
  const d = new Date(iso);
  const diffMs = Date.now() - d.getTime();
  if (diffMs >= 0 && diffMs < 60_000) return `${Math.max(1, Math.round(diffMs / 1000))}s ago`;
  if (diffMs >= 0 && diffMs < 3600_000) return `${Math.round(diffMs / 60_000)}m ago`;
  if (diffMs >= 0 && diffMs < 86_400_000) return `${Math.round(diffMs / 3_600_000)}h ago`;
  return d.toLocaleString();
}

export function riskTone(score: number | null | undefined): "positive" | "warning" | "danger" {
  if (score == null) return "warning";
  if (score >= 0.85) return "danger";
  if (score >= 0.4) return "warning";
  return "positive";
}
