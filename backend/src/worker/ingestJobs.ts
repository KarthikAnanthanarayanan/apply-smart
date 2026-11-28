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
const PROGRESS_EVERY = 100;

interface Company {
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

interface IngestSummary {
  companiesFetched: number;
  companiesFailed: Record<string, number>;
  jobsSeen: number;
  jobsOutsideAustralia: number;
  duplicatesDropped: number;
  jobsSaved: number;
  rowsFailed: number;
  jobsDeleted: number;
  companiesCleanupFailed: number;
}

export async function ingestJobs(): Promise<IngestSummary> {
  const limit = readIngestLimit();
  const companies = await loadCompanies(limit);
  console.log(
    `Ingesting jobs for ${companies.length} companies` +
      (limit ? ` (INGEST_LIMIT=${limit})` : ""),
  );

  const summary: IngestSummary = {
    companiesFetched: 0,
    companiesFailed: {},
    jobsSeen: 0,
    jobsOutsideAustralia: 0,
    duplicatesDropped: 0,
    jobsSaved: 0,
    rowsFailed: 0,
    jobsDeleted: 0,
    companiesCleanupFailed: 0,
  };
  const seenKeys = new Set<string>();
  let processed = 0;

  const onCompanyDone = () => {
    processed++;
    if (processed % PROGRESS_EVERY === 0) {
      console.log(
        `Processed ${processed}/${companies.length} companies, ${summary.jobsSeen} jobs seen, ${summary.jobsSaved} saved, ${summary.jobsDeleted} deleted`,
      );
    }
  };

  const boards = new Map<JobBoard, Company[]>();
  for (const company of companies) {
    const queue = boards.get(company.job_board) ?? [];
    queue.push(company);
    boards.set(company.job_board, queue);
  }

  await Promise.all(
    [...boards.values()].map(async (boardCompanies) => {
      let lastRequestAt = 0;
      for (const company of boardCompanies) {
        const wait = lastRequestAt + REQUEST_INTERVAL_MS - Date.now();
        if (wait > 0) await sleep(wait);
        lastRequestAt = Date.now();

        try {
          await ingestCompany(company, summary, seenKeys);
        } catch (err) {
          recordCompanyFailure(
            summary,
            `unexpected error: ${errorMessage(err)}`,
          );
          console.error(
            `${company.job_board}/${company.company_board_id}:`,
            err,
          );
        }
        onCompanyDone();
      }
    }),
  );

  logSummary(summary, companies.length);
  return summary;
}

async function ingestCompany(
  company: Company,
  summary: IngestSummary,
  seenKeys: Set<string>,
): Promise<void> {
  const result = await fetchJobs(company.job_board, company.company_board_id);
  if (!result.ok) {
    recordCompanyFailure(summary, result.reason);
    return;
  }
  summary.companiesFetched++;

  const rows: JobRow[] = [];
  for (const job of result.jobs) {
    summary.jobsSeen++;
    if (job.country === null) {
      summary.jobsOutsideAustralia++;
      continue;
    }
    const row = toJobRow(company.id, job);
    if (seenKeys.has(row.duplicate_key)) {
      summary.duplicatesDropped++;
      continue;
    }
    seenKeys.add(row.duplicate_key);
    rows.push(row);
  }

  for (let start = 0; start < rows.length; start += SAVE_BATCH_SIZE) {
    await saveBatch(rows.slice(start, start + SAVE_BATCH_SIZE), summary);
  }

  // Only Australian jobs count as live, so rows saved before the Australia-only filter get deleted.
  const liveIds = new Set(
    result.jobs
      .filter((job) => job.country !== null)
      .map((job) => job.boardJobId),
  );
  await deleteClosedJobs(company, liveIds, summary);
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
  summary: IngestSummary,
): Promise<void> {
  const batchError = await upsertJobs(batch);
  if (!batchError) {
    summary.jobsSaved += batch.length;
    return;
  }

  console.warn(
    `Saving a batch of ${batch.length} jobs failed (${batchError}), retrying one row at a time`,
  );
  for (const row of batch) {
    const rowError = await upsertJobs([row]);
    if (!rowError) {
      summary.jobsSaved++;
      continue;
    }
    summary.rowsFailed++;
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
  summary: IngestSummary,
): Promise<void> {
  try {
    if (liveIds.size === 0) {
      const { error, count } = await supabase
        .from("jobs")
        .delete({ count: "exact" })
        .eq("company_id", company.id);
      if (error) throw new Error(error.message);
      summary.jobsDeleted += count ?? 0;
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
      summary.jobsDeleted += count ?? 0;
    }
  } catch (err) {
    summary.companiesCleanupFailed++;
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

async function loadCompanies(limit: number | null): Promise<Company[]> {
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

function recordCompanyFailure(summary: IngestSummary, reason: string): void {
  summary.companiesFailed[reason] = (summary.companiesFailed[reason] ?? 0) + 1;
}

function logSummary(summary: IngestSummary, total: number): void {
  const failedTotal = Object.values(summary.companiesFailed).reduce(
    (sum, n) => sum + n,
    0,
  );
  console.log(
    [
      `Job ingestion done for ${total} companies:`,
      `  companies fetched: ${summary.companiesFetched}`,
      `  companies failed:  ${failedTotal}`,
      ...Object.entries(summary.companiesFailed)
        .sort(([, a], [, b]) => b - a)
        .map(([reason, count]) => `    ${count} x ${reason}`),
      `  jobs seen:         ${summary.jobsSeen}`,
      `  outside Australia: ${summary.jobsOutsideAustralia}`,
      `  duplicates dropped: ${summary.duplicatesDropped}`,
      `  jobs saved:        ${summary.jobsSaved}`,
      `  rows failed:       ${summary.rowsFailed}`,
      `  jobs deleted:      ${summary.jobsDeleted}`,
      `  cleanup failed:    ${summary.companiesCleanupFailed} companies`,
    ].join("\n"),
  );
}

function errorMessage(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}
