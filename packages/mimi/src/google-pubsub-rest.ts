/**
 * Minimal Google Cloud Pub/Sub REST client.
 *
 * Works against:
 *  - the Pub/Sub emulator via PUBSUB_EMULATOR_HOST (local dev / CI),
 *  - production Pub/Sub on Cloud Run via the metadata-server token,
 *  - any environment providing GOOGLE_PUBSUB_BEARER_TOKEN.
 *
 * Zero SDK dependencies: publishing is a single authenticated POST.
 */

export interface PubSubTarget {
  projectId: string;
  emulator: boolean;
}

export function resolvePubSubTarget(env: NodeJS.ProcessEnv = process.env): PubSubTarget | null {
  const emulatorHost = env.PUBSUB_EMULATOR_HOST?.trim();
  if (emulatorHost) {
    const projectId = env.PUBSUB_PROJECT_ID?.trim() || env.GOOGLE_CLOUD_PROJECT?.trim() || "mimi-local";
    return { projectId, emulator: true };
  }
  const projectId = env.GOOGLE_CLOUD_PROJECT?.trim() || env.GCP_PROJECT_ID?.trim();
  if (projectId) return { projectId, emulator: false };
  return null;
}

function baseUrl(target: PubSubTarget): string {
  return target.emulator
    ? `http://${process.env.PUBSUB_EMULATOR_HOST}/v1`
    : "https://pubsub.googleapis.com/v1";
}

let cachedToken: { token: string; expiresAtMs: number } | null = null;

async function bearerToken(): Promise<string | undefined> {
  const explicit = process.env.GOOGLE_PUBSUB_BEARER_TOKEN?.trim()
    || process.env.GOOGLE_OAUTH_ACCESS_TOKEN?.trim();
  if (explicit) return explicit;
  if (!cachedToken || cachedToken.expiresAtMs - Date.now() < 30_000) {
    const res = await fetch(
      "http://metadata.google.internal/computeMetadata/v1/instance/service-accounts/default/token",
      {
        headers: { "Metadata-Flavor": "Google" },
        signal: AbortSignal.timeout(2_000),
      },
    );
    if (!res.ok) throw new Error(`metadata token request failed: ${res.status}`);
    const body = (await res.json()) as { access_token: string; expires_in: number };
    cachedToken = { token: body.access_token, expiresAtMs: Date.now() + body.expires_in * 1000 };
  }
  return cachedToken.token;
}

export async function ensurePubSubTopic(projectId: string, topic: string): Promise<void> {
  const target = resolvePubSubTarget();
  if (!target) throw new Error("Pub/Sub is not configured");
  const res = await fetch(`${baseUrl(target)}/projects/${projectId}/topics/${topic}`, {
    method: "PUT",
    headers: await authHeaders(),
    signal: AbortSignal.timeout(10_000),
  });
  // 409 ALREADY_EXISTS is fine; anything else surfaces to caller.
  if (!res.ok && res.status !== 409) {
    throw new Error(`failed to create topic ${topic}: ${res.status} ${await safeText(res)}`);
  }
}

export async function publishToPubSubTopic(input: {
  projectId: string;
  topic: string;
  message: unknown;
}): Promise<{ messageId: string | null }> {
  const target = resolvePubSubTarget();
  if (!target) throw new Error("Pub/Sub is not configured");
  const data = Buffer.from(JSON.stringify(input.message), "utf8").toString("base64");
  const res = await fetch(
    `${baseUrl(target)}/projects/${input.projectId}/topics/${input.topic}:publish`,
    {
      method: "POST",
      headers: { ...(await authHeaders()), "Content-Type": "application/json" },
      body: JSON.stringify({ messages: [{ data }] }),
      signal: AbortSignal.timeout(10_000),
    },
  );
  if (!res.ok) throw new Error(`pubsub publish failed: ${res.status} ${await safeText(res)}`);
  const body = (await res.json()) as { messageIds?: string[] };
  return { messageId: body.messageIds?.[0] ?? null };
}

async function authHeaders(): Promise<Record<string, string>> {
  if (resolvePubSubTarget()?.emulator) return {};
  try {
    const token = await bearerToken();
    return token ? { Authorization: `Bearer ${token}` } : {};
  } catch {
    return {};
  }
}

async function safeText(res: Response): Promise<string> {
  try {
    return await res.text();
  } catch {
    return "";
  }
}
