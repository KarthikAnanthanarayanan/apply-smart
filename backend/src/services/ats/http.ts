export type JobBoard = 'greenhouse' | 'lever' | 'ashby';

export interface AtsJob {
  id: string;
  title: string;
  location: string | null;
  url: string | null;
  raw: unknown;
}

export type FetchJobsResult =
  | { ok: true; jobs: AtsJob[] }
  | { ok: false; reason: string };

const TIMEOUT_MS = 15_000;

export type JsonResult = { ok: true; body: unknown } | { ok: false; reason: string };

/** GETs a public ATS endpoint and parses JSON. Never throws. */
export async function getJson(url: string): Promise<JsonResult> {
  let res: Response;
  try {
    res = await fetch(url, {
      headers: { Accept: 'application/json' },
      signal: AbortSignal.timeout(TIMEOUT_MS),
    });
  } catch (err) {
    if (err instanceof Error && err.name === 'TimeoutError') {
      return { ok: false, reason: `timed out after ${TIMEOUT_MS / 1000}s` };
    }
    return { ok: false, reason: `network error: ${errorMessage(err)}` };
  }

  if (res.status === 404) return { ok: false, reason: 'board not found (404)' };
  if (!res.ok) return { ok: false, reason: `HTTP ${res.status} ${res.statusText}` };

  try {
    return { ok: true, body: await res.json() };
  } catch (err) {
    return { ok: false, reason: `invalid JSON: ${errorMessage(err)}` };
  }
}

export function badResponse(detail: string): FetchJobsResult {
  return { ok: false, reason: `unexpected response shape: ${detail}` };
}

export function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

export function stringOrNull(value: unknown): string | null {
  return typeof value === 'string' && value.trim() !== '' ? value : null;
}

function errorMessage(err: unknown): string {
  if (!(err instanceof Error)) return String(err);
  // undici puts the real reason (ENOTFOUND, ECONNRESET, ...) on `cause`.
  const cause = err.cause instanceof Error ? ` (${err.cause.message})` : '';
  return `${err.message}${cause}`;
}
