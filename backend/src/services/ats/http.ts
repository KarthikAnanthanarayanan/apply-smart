export type JobBoard = "greenhouse" | "lever" | "ashby";

export interface AtsJob {
  boardJobId: string;
  title: string;
  city: string | null;
  country: string | null;
  applyUrl: string | null;
  raw: Record<string, unknown>;
  updatedAt: string | null;
}

export type FetchJobsResult =
  | { ok: true; jobs: AtsJob[] }
  | { ok: false; reason: string };

const TIMEOUT_MS = 15_000;

type JsonResult =
  | { ok: true; body: unknown }
  | { ok: false; reason: string };

// Calls public job board and handle's error accordingly.
export async function getJson(url: string): Promise<JsonResult> {
  let res: Response;
  try {
    res = await fetch(url, {
      headers: { Accept: "application/json" },
      signal: AbortSignal.timeout(TIMEOUT_MS),
    });
  } catch (err) {
    if (err instanceof Error && err.name === "TimeoutError") {
      return { ok: false, reason: `timed out after ${TIMEOUT_MS / 1000}s` };
    }
    return { ok: false, reason: `network error: ${errorMessage(err)}` };
  }

  if (res.status === 404) return { ok: false, reason: "board not found (404)" };
  if (!res.ok)
    return { ok: false, reason: `HTTP ${res.status} ${res.statusText}` };

  try {
    return { ok: true, body: await res.json() };
  } catch (err) {
    return { ok: false, reason: `invalid JSON: ${errorMessage(err)}` };
  }
}

// Just some helpers for error handling.

export function badResponse(detail: string): FetchJobsResult {
  return { ok: false, reason: `unexpected response shape: ${detail}` };
}

export function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

export function stringOrNull(value: unknown): string | null {
  return typeof value === "string" && value.trim() !== "" ? value : null;
}

export function isoDateOrNull(value: unknown): string | null {
  if (typeof value !== "number" && stringOrNull(value) === null) return null;
  const date = new Date(value as string | number);
  return Number.isNaN(date.getTime()) ? null : date.toISOString();
}

function errorMessage(err: unknown): string {
  if (!(err instanceof Error)) return String(err);
  const cause = err.cause instanceof Error ? ` (${err.cause.message})` : "";
  return `${err.message}${cause}`;
}
