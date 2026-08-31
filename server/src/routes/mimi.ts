import { asc } from "drizzle-orm";
import type { Db } from "@paperclipai/db";
import { companies } from "@paperclipai/db";
import { MimiService } from "@mimi/agentos-core";
import { createMimiRouter } from "./mimi-router.js";
import { persistActivity } from "../services/activity-log.js";
import { logger } from "../middleware/logger.js";

/**
 * Server-side wiring for the MiMi Money AgentOS domain.
 *
 * MiMi Money AgentOS owns the financial workforce experience; the underlying
 * Paperclip framework supplies the existing control-plane capabilities.
 * Meaningful financial milestones are mirrored into the host activity log so
 * governance/attention flows keep working.
 */

let servicePromise: Promise<MimiService> | null = null;

export function getMimiService(): Promise<MimiService> {
  if (!servicePromise) {
    const service = new MimiService();
    servicePromise = service
      .start()
      .then(() => {
        logger.info({ adkMode: service.adkMode, model: service.currentModel() }, "[mimi] AgentOS started");
        return service;
      })
      .catch((err) => {
        servicePromise = null;
        throw err;
      });
  }
  return servicePromise;
}

export async function shutdownMimiService(): Promise<void> {
  if (!servicePromise) return;
  try {
    const svc = await servicePromise;
    svc.shutdown();
  } catch {
    // never block shutdown on MiMi teardown
  }
  servicePromise = null;
}

/** Mirror a MiMi milestone into the host control-plane activity log (best-effort). */
async function logMimiActivity(
  db: Db,
  input: {
    companyId: string;
    action: string;
    entityId: string;
    entityType?: string;
    summary: string;
    details?: Record<string, unknown>;
  },
): Promise<void> {
  try {
    await persistActivity(db, {
      companyId: input.companyId,
      actorType: "system",
      actorId: "mimi-agentos",
      action: input.action,
      entityType: input.entityType ?? "mimi_workflow",
      entityId: input.entityId,
      details: { source: "mimi-agentos", sandbox: true, summary: input.summary, ...(input.details ?? {}) },
    });
  } catch (err) {
    logger.warn({ err }, "[mimi] failed to mirror activity into host control-plane log");
  }
}

let cachedCompanyId: string | null | undefined;

async function resolveCompanyId(db: Db): Promise<string | null> {
  if (cachedCompanyId !== undefined) return cachedCompanyId;
  try {
    const rows = await db.select({ id: companies.id }).from(companies).orderBy(asc(companies.createdAt)).limit(1);
    cachedCompanyId = rows[0]?.id ?? null;
  } catch {
    cachedCompanyId = null;
  }
  return cachedCompanyId;
}

export async function mimiRoutes(db: Db) {
  const service = await getMimiService();

  // Mirror human-review decisions into the host control-plane activity log.
  const originalDecide = service.decideReview.bind(service);
  service.decideReview = async (reviewId, approved, decidedBy, note) => {
    const review = await originalDecide(reviewId, approved, decidedBy, note);
    const companyId = await resolveCompanyId(db);
    if (companyId) {
      void logMimiActivity(db, {
        companyId,
        action: approved ? "mimi.human_review.approved" : "mimi.human_review.rejected",
        entityId: review.id,
        summary: `Human review ${review.status.toLowerCase()} for $${review.amountUsd.toFixed(2)} (sandbox)`,
        details: { workflowId: review.workflowId, transactionId: review.transactionId, decidedBy },
      });
    }
    return review;
  };

  // Mirror workflow completion milestones into the host control-plane activity log.
  const loggedWorkflowIds = new Set<string>();
  setInterval(() => {
    void (async () => {
      try {
        const workflows = await service.listWorkflows(30);
        const companyId = await resolveCompanyId(db);
        if (!companyId) return;
        for (const wf of workflows) {
          if (!wf.completedAt || loggedWorkflowIds.has(wf.id)) continue;
          if (new Date(wf.completedAt).getTime() < Date.now() - 120_000) continue; // only fresh completions
          loggedWorkflowIds.add(wf.id);
          void logMimiActivity(db, {
            companyId,
            action: wf.status === "ESCALATED" ? "mimi.workflow.escalated" : "mimi.workflow.completed",
            entityId: wf.id,
            summary: `MiMi payment workflow ${wf.status.toLowerCase()} (sandbox, txn ${wf.transactionId})`,
            details: { transactionId: wf.transactionId, status: wf.status },
          });
        }
      } catch {
        // polling mirror is best-effort only
      }
    })();
  }, 10_000).unref?.();

  return createMimiRouter(service);
}
