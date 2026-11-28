import { createHash } from "node:crypto";
import { setTimeout as sleep } from "node:timers/promises";
import { supabase } from "../queries/client.js";
import {
  fetchJobs,
  type AtsJob,
  type JobBoard,
} from "../services/ats/index.js";

const PAGE_SIZE = 1_000; // how many companies are read from db at once.
const REQUEST_INTERVAL_MS = 1_000; // 1s gap b/w requests so we don't get rate-limited.
const SAVE_BATCH_SIZE = 50; // how many jobs are saved at one time in the table.
const DELETE_BATCH_SIZE = 100; // how many stale jobs are deleted at one time.
const MAX_JOB_AGE_DAYS = 20; // jobs not updated on the board within this many days are deleted.

export interface Company {
  id: string;
  name: string;
  job_board: JobBoard;
  company_board_id: string;
}

// standard_title is left out so it is null on insert and an upsert never clears a later ESCO mapping
// (since its not in field, db never overwrites it).
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

// Each board's queue runs one company at a time in one worker process,
// so requests to each board start at least REQUEST_INTERVAL_MS apart.
const lastRequestAt = new Map<JobBoard, number>();

// Wait 1ms per job-board request to avoid being rate-limited.
async function waitForBoardSlot(board: JobBoard): Promise<void> {
  const wait =
    (lastRequestAt.get(board) ?? 0) + REQUEST_INTERVAL_MS - Date.now();
  if (wait > 0) await sleep(wait);
  lastRequestAt.set(board, Date.now());
}

// Returns every error hit, so one failure never stops the later saves/deletes. index.ts throws them.
export async function ingestCompany(company: Company): Promise<string[]> {
  const label = `${company.job_board}/${company.company_board_id}`;
  const errors: string[] = [];

  await waitForBoardSlot(company.job_board);
  const fetched = await fetchJobs(company.job_board, company.company_board_id);
  if (!fetched.ok) return [`${label}: fetch failed: ${fetched.reason}`];

  // Only Australian jobs updated in the last MAX_JOB_AGE_DAYS are kept, since location is null when its not Australian.
  // Anything else is left out of liveIds, so deleteClosedJobs also removes it from the table.
  const cutoff = Date.now() - MAX_JOB_AGE_DAYS * 24 * 60 * 60 * 1000;
  const keptJobs = fetched.jobs.filter(
    (job) =>
      job.country !== null &&
      (job.updatedAt === null || Date.parse(job.updatedAt) >= cutoff),
  );

  const seenKeys = new Set<string>();
  const rows: JobRow[] = [];
  for (const job of keptJobs) {
    const row = toJobRow(company.id, job);
    if (seenKeys.has(row.duplicate_key)) continue;
    seenKeys.add(row.duplicate_key);
    rows.push(row);
  }

  for (let start = 0; start < rows.length; start += SAVE_BATCH_SIZE) {
    const saveError = await saveBatch(
      rows.slice(start, start + SAVE_BATCH_SIZE),
    );
    if (saveError) errors.push(`${label}: saving jobs failed: ${saveError}`);
  }

  const liveIds = new Set(keptJobs.map((job) => job.boardJobId));
  const deleteError = await deleteClosedJobs(company, liveIds);
  if (deleteError)
    errors.push(`${label}: deleting closed jobs failed: ${deleteError}`);

  return errors;
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

// to dedup per job per board.
function duplicateKey(
  title: string,
  companyId: string,
  city: string | null,
): string {
  return createHash("sha256")
    .update(title.toLowerCase() + companyId + (city ?? "").toLowerCase())
    .digest("hex");
}

async function saveBatch(batch: JobRow[]): Promise<string | null> {
  const batchError = await upsertJobs(batch);
  if (!batchError) return null;

  // retry one row at a time so a bad row doesn't stop the rest of the batch saving.
  const rowErrors: string[] = [];
  for (const row of batch) {
    const rowError = await upsertJobs([row]);
    if (rowError)
      rowErrors.push(`job ${row.board_job_id} ("${row.title}"): ${rowError}`);
  }
  return rowErrors.length > 0 ? rowErrors.join("; ") : null;
}

// Returns the error message, or null on success. Never throws.
async function upsertJobs(rows: JobRow[]): Promise<string | null> {
  try {
    const { error } = await supabase
      .from("jobs")
      .upsert(rows, { onConflict: "duplicate_key" }); // When a job is reposted etc. just update it instead of adding a new entry/erroring.
    return error ? error.message : null;
  } catch (err) {
    return errorMessage(err);
  }
}

// Deletes the company's stored jobs whose board_job_id the board no longer lists OR older than 20 days.
async function deleteClosedJobs(
  company: Company,
  liveIds: Set<string>,
): Promise<string | null> {
  try {
    if (liveIds.size === 0) {
      const { error } = await supabase
        .from("jobs")
        .delete()
        .eq("company_id", company.id);
      if (error) throw new Error(error.message);
      return null;
    }

    const storedIds = await loadBoardJobIds(company.id);
    const closedIds = storedIds.filter((id) => !liveIds.has(id));
    for (let start = 0; start < closedIds.length; start += DELETE_BATCH_SIZE) {
      const { error } = await supabase
        .from("jobs")
        .delete()
        .eq("company_id", company.id)
        .in("board_job_id", closedIds.slice(start, start + DELETE_BATCH_SIZE));
      if (error) throw new Error(error.message);
    }
    return null;
  } catch (err) {
    return errorMessage(err);
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

// reads number of jobs that can come in from one request (env variable)
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
