import { createHash } from "node:crypto";
import { setTimeout as sleep } from "node:timers/promises";
import { supabase } from "../queries/client.js";
import {
  fetchJobs,
  type AtsJob,
  type JobBoard,
} from "../services/ats/index.js";

const PAGE_SIZE = 1_000;
const REQUEST_INTERVAL_MS = 1_000;
const SAVE_BATCH_SIZE = 50;
const DELETE_BATCH_SIZE = 100;

export interface Company {
  id: string;
  name: string;
  job_board: JobBoard;
  company_board_id: string;
}

// standard_title is left out so it is null on insert and an upsert never clears a later ESCO mapping.
interface JobRow {
  company_id: string;
  board_job_id: string;
  duplicate_key: string;
  title: string;
  city: string | null;
  state: string | null;
  country: string | null;
  apply_url: string | null;
  raw_data: Record<string, unknown>;
  last_updated: string;
}

export interface CompanyIngestResult {
  fetchFailed: string | null;
  jobsSeen: number;
  jobsOutsideAustralia: number;
  duplicatesDropped: number;
  jobsSaved: number;
  rowsFailed: number;
  jobsDeleted: number;
  cleanupFailed: boolean;
}

// Assumes one worker process with at most one active job per board (groupConcurrency: 1),
// so requests to each board start at least REQUEST_INTERVAL_MS apart.
const lastRequestAt = new Map<JobBoard, number>();

async function waitForBoardSlot(board: JobBoard): Promise<void> {
  const wait = (lastRequestAt.get(board) ?? 0) + REQUEST_INTERVAL_MS - Date.now();
  if (wait > 0) await sleep(wait);
  lastRequestAt.set(board, Date.now());
}

export async function ingestCompany(
  company: Company,
): Promise<CompanyIngestResult> {
  const result: CompanyIngestResult = {
    fetchFailed: null,
    jobsSeen: 0,
    jobsOutsideAustralia: 0,
    duplicatesDropped: 0,
    jobsSaved: 0,
    rowsFailed: 0,
    jobsDeleted: 0,
    cleanupFailed: false,
  };
  const label = `${company.job_board}/${company.company_board_id}`;

  await waitForBoardSlot(company.job_board);
  const fetched = await fetchJobs(company.job_board, company.company_board_id);
  if (!fetched.ok) {
    result.fetchFailed = fetched.reason;
    console.warn(`${label}: fetch failed: ${fetched.reason}`);
    return result;
  }

  const seenKeys = new Set<string>();
  const rows: JobRow[] = [];
  for (const job of fetched.jobs) {
    result.jobsSeen++;
    if (job.country === null) {
      result.jobsOutsideAustralia++;
      continue;
    }
    const row = toJobRow(company.id, job);
    if (seenKeys.has(row.duplicate_key)) {
      result.duplicatesDropped++;
      continue;
    }
    seenKeys.add(row.duplicate_key);
    rows.push(row);
  }

  for (let start = 0; start < rows.length; start += SAVE_BATCH_SIZE) {
    await saveBatch(rows.slice(start, start + SAVE_BATCH_SIZE), result);
  }

  // Only Australian jobs count as live, so rows saved before the Australia-only filter get deleted.
  const liveIds = new Set(
    fetched.jobs
      .filter((job) => job.country !== null)
      .map((job) => job.boardJobId),
  );
  await deleteClosedJobs(company, liveIds, result);

  console.log(
    `${label}: ${result.jobsSeen} seen, ${result.jobsOutsideAustralia} outside Australia, ` +
      `${result.duplicatesDropped} duplicates, ${result.jobsSaved} saved, ` +
      `${result.rowsFailed} rows failed, ${result.jobsDeleted} deleted` +
      (result.cleanupFailed ? ", cleanup failed" : ""),
  );
  return result;
}

function toJobRow(companyId: string, job: AtsJob): JobRow {
  return {
    company_id: companyId,
    board_job_id: job.boardJobId,
    duplicate_key: duplicateKey(job.title, companyId, job.city),
    title: job.title,
    city: job.city,
    state: job.state,
    country: job.country,
    apply_url: job.applyUrl,
    raw_data: job.raw,
    last_updated: job.updatedAt ?? new Date().toISOString(),
  };
}

function duplicateKey(
  title: string,
  companyId: string,
  city: string | null,
): string {
  return createHash("sha256")
    .update(title.toLowerCase() + companyId + (city ?? "").toLowerCase())
    .digest("hex");
}

async function saveBatch(
  batch: JobRow[],
  result: CompanyIngestResult,
): Promise<void> {
  const batchError = await upsertJobs(batch);
  if (!batchError) {
    result.jobsSaved += batch.length;
    return;
  }

  console.warn(
    `Saving a batch of ${batch.length} jobs failed (${batchError}), retrying one row at a time`,
  );
  for (const row of batch) {
    const rowError = await upsertJobs([row]);
    if (!rowError) {
      result.jobsSaved++;
      continue;
    }
    result.rowsFailed++;
    console.error(
      `Job ${row.board_job_id} for company ${row.company_id} ("${row.title}") failed: ${rowError}`,
    );
  }
}

// Returns the error message, or null on success. Never throws.
async function upsertJobs(rows: JobRow[]): Promise<string | null> {
  try {
    const { error } = await supabase
      .from("jobs")
      .upsert(rows, { onConflict: "duplicate_key" });
    return error ? error.message : null;
  } catch (err) {
    return errorMessage(err);
  }
}

// Deletes the company's stored jobs whose board_job_id the board no longer lists. Never throws.
async function deleteClosedJobs(
  company: Company,
  liveIds: Set<string>,
  result: CompanyIngestResult,
): Promise<void> {
  try {
    if (liveIds.size === 0) {
      const { error, count } = await supabase
        .from("jobs")
        .delete({ count: "exact" })
        .eq("company_id", company.id);
      if (error) throw new Error(error.message);
      result.jobsDeleted += count ?? 0;
      return;
    }

    const storedIds = await loadBoardJobIds(company.id);
    const closedIds = storedIds.filter((id) => !liveIds.has(id));
    for (let start = 0; start < closedIds.length; start += DELETE_BATCH_SIZE) {
      const { error, count } = await supabase
        .from("jobs")
        .delete({ count: "exact" })
        .eq("company_id", company.id)
        .in("board_job_id", closedIds.slice(start, start + DELETE_BATCH_SIZE));
      if (error) throw new Error(error.message);
      result.jobsDeleted += count ?? 0;
    }
  } catch (err) {
    result.cleanupFailed = true;
    console.error(
      `${company.job_board}/${company.company_board_id}: deleting closed jobs failed: ${errorMessage(err)}`,
    );
  }
}

async function loadBoardJobIds(companyId: string): Promise<string[]> {
  const ids: string[] = [];
  for (let from = 0; ; from += PAGE_SIZE) {
    const { data, error } = await supabase
      .from("jobs")
      .select("board_job_id")
      .eq("company_id", companyId)
      .order("board_job_id")
      .range(from, from + PAGE_SIZE - 1);
    if (error) throw new Error(`Could not load stored jobs: ${error.message}`);

    ids.push(...data.map((row) => row.board_job_id as string));
    if (data.length < PAGE_SIZE) break;
  }
  return ids;
}

export async function loadCompanies(): Promise<Company[]> {
  const limit = readIngestLimit();
  const companies: Company[] = [];
  for (let from = 0; ; from += PAGE_SIZE) {
    const pageSize = limit
      ? Math.min(PAGE_SIZE, limit - companies.length)
      : PAGE_SIZE;
    if (pageSize <= 0) break;

    const { data, error } = await supabase
      .from("companies")
      .select("id, name, job_board, company_board_id")
      .order("id")
      .range(from, from + pageSize - 1);
    if (error) throw new Error(`Could not load companies: ${error.message}`);

    companies.push(...(data as Company[]));
    if (data.length < pageSize) break;
  }
  return companies;
}

function readIngestLimit(): number | null {
  const raw = process.env.INGEST_LIMIT?.trim();
  if (!raw) return null;
  const limit = Number(raw);
  if (!Number.isInteger(limit) || limit <= 0) {
    throw new Error(
      `INGEST_LIMIT must be a positive integer, got "${process.env.INGEST_LIMIT}"`,
    );
  }
  return limit;
}

function errorMessage(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}
