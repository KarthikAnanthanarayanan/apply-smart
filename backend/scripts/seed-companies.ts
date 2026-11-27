import { setTimeout as sleep } from "node:timers/promises";
import { supabase } from "../src/queries/client.js";
import { fetchJobs, type JobBoard } from "../src/services/ats/index.js";

interface CompanyCandidate {
  name: string;
  job_board: JobBoard;
  company_board_id: string;
}

const COLLINFO_URL = "https://index.commoncrawl.org/collinfo.json";

const DOMAINS: { domain: string; jobBoard: JobBoard }[] = [
  { domain: "boards.greenhouse.io", jobBoard: "greenhouse" },
  { domain: "job-boards.greenhouse.io", jobBoard: "greenhouse" },
  { domain: "jobs.lever.co", jobBoard: "lever" },
  { domain: "jobs.ashbyhq.com", jobBoard: "ashby" },
];

// First path segments on the board domains that are site paths, not company boards.
const NON_COMPANY_SEGMENTS = new Set([
  "embed",
  "api",
  "v0",
  "v1",
  "jobs",
  "job_board",
  "job-board",
  "static",
  "assets",
  "include",
  "js",
  "css",
  "images",
  "img",
  "fonts",
  "favicon.ico",
  "robots.txt",
  "sitemap",
  "sitemap.xml",
  "search",
  "login",
  "privacy",
  "terms",
]);
const VALID_SEGMENT = /^[a-z0-9][a-z0-9 ._-]*$/;
const FILE_EXTENSION =
  /\.(txt|xml|ico|js|css|map|png|jpe?g|gif|svg|webp|json|html?|php)$/;

const CC_DELAY_MS = 1_000;
const CC_RETRY_DELAY_MS = 5_000;
const CC_TIMEOUT_MS = 60_000;
const VERIFY_DELAY_MS = 1_000;
const UPSERT_BATCH_SIZE = 50;
const PROGRESS_EVERY = 25;

type CcResult =
  | { ok: true; text: string }
  | { ok: false; status: number | null; reason: string };

let lastCcRequestEndedAt = 0;

// Sends a GET request to Common Crawl's API and waits so request are 1s apart. Retries the first time when server is busy.
async function ccGet(url: string): Promise<CcResult> {
  for (let attempt = 1; ; attempt++) {
    const wait = lastCcRequestEndedAt + CC_DELAY_MS - Date.now();
    if (wait > 0) await sleep(wait);

    try {
      const res = await fetch(url, {
        signal: AbortSignal.timeout(CC_TIMEOUT_MS),
      });
      if (res.status === 503 && attempt === 1) {
        console.warn(`Common Crawl 503, retrying: ${url}`);
        await res.body?.cancel();
        await sleep(CC_RETRY_DELAY_MS);
        continue;
      }
      if (!res.ok) {
        await res.body?.cancel();
        return {
          ok: false,
          status: res.status,
          reason: `HTTP ${res.status} ${res.statusText}`,
        };
      }
      return { ok: true, text: await res.text() };
    } catch (err) {
      return {
        ok: false,
        status: null,
        reason: err instanceof Error ? err.message : String(err),
      };
    } finally {
      lastCcRequestEndedAt = Date.now();
    }
  }
}

// Gets the ID of the latest snapshot from when Common Crawl last crawled the web.
async function getNewestIndexId(): Promise<string> {
  const res = await ccGet(COLLINFO_URL);
  if (!res.ok)
    throw new Error(`Could not fetch ${COLLINFO_URL}: ${res.reason}`);

  const collections: unknown = JSON.parse(res.text);
  if (!Array.isArray(collections) || collections.length === 0) {
    throw new Error(
      `Unexpected collinfo.json shape: expected a non-empty array`,
    );
  }
  // Index ids are "CC-MAIN-YYYY-WW", so largest is newest.
  const ids = collections
    .map((c: unknown) =>
      typeof c === "object" && c !== null
        ? (c as { id?: unknown }).id
        : undefined,
    )
    .filter(
      (id): id is string =>
        typeof id === "string" && /^CC-MAIN-\d{4}-\d{2}$/.test(id),
    )
    .sort();
  const newest = ids.at(-1);
  if (!newest)
    throw new Error("No CC-MAIN-YYYY-WW index ids found in collinfo.json");
  return newest;
}

function cdxQueryUrl(indexId: string, domain: string, extra: string): string {
  const url = encodeURIComponent(`${domain}/*`);
  return `https://index.commoncrawl.org/${indexId}-index?url=${url}&output=json&${extra}`;
}

// From the latest snapshot, get the number of result pages for a domain (e.g. 10 pages of Ashby URLs).
async function getPageCount(indexId: string, domain: string): Promise<number> {
  const res = await ccGet(cdxQueryUrl(indexId, domain, "showNumPages=true"));
  if (!res.ok) {
    // The server doesn't have the pages of URLs we are looking for, so we return 0.
    if (res.status !== 404)
      console.warn(`${domain}: page count failed (${res.reason}), skipped`);
    return 0;
  }
  let body: unknown;
  try {
    body = JSON.parse(res.text);
  } catch {
    console.warn(`${domain}: showNumPages response wasn't valid JSON, skipped`);
    return 0;
  }

  const pages = (body as { pages?: unknown } | null)?.pages;
  if (typeof pages !== "number" || !Number.isInteger(pages) || pages < 0) {
    console.warn(
      `${domain}: showNumPages response had no valid page count, skipped`,
    );
    return 0;
  }

  return pages;
}

// Get page URLs on each page for that domain.
async function getPageUrls(
  indexId: string,
  domain: string,
  page: number,
): Promise<string[] | null> {
  // Get all the domains on each page.
  const res = await ccGet(cdxQueryUrl(indexId, domain, `fl=url&page=${page}`));
  if (!res.ok) {
    if (res.status === 404) return [];
    console.warn(`${domain} page ${page}: ${res.reason}, skipped`);
    return null;
  }

  const urls: string[] = [];
  for (const line of res.text.split("\n")) {
    if (!line.trim()) continue;
    try {
      const record: unknown = JSON.parse(line);
      const url =
        typeof record === "object" && record !== null
          ? (record as { url?: unknown }).url
          : undefined;
      if (typeof url === "string") urls.push(url);
    } catch {
      continue;
    }
  }
  return urls;
}

function extractBoardId(capturedUrl: string): string | null {
  let firstSegment: string | undefined;
  try {
    firstSegment = new URL(capturedUrl).pathname
      .split("/")
      .find((s) => s !== "");
  } catch {
    return null;
  }
  if (!firstSegment) return null;

  let id: string;
  try {
    id = decodeURIComponent(firstSegment).trim().toLowerCase();
  } catch {
    return null;
  }

  if (!VALID_SEGMENT.test(id)) return null;
  if (NON_COMPANY_SEGMENTS.has(id) || FILE_EXTENSION.test(id)) return null;
  return id;
}

// Get the company name and details across different job boards.
async function discoverCandidates(
  indexId: string,
): Promise<CompanyCandidate[]> {
  const seen = new Set<string>();
  const candidates: CompanyCandidate[] = [];

  for (const { domain, jobBoard } of DOMAINS) {
    const pages = await getPageCount(indexId, domain);
    const before = candidates.length;

    for (let page = 0; page < pages; page++) {
      const urls = await getPageUrls(indexId, domain, page);
      if (urls === null) continue;

      for (const url of urls) {
        const boardId = extractBoardId(url);
        if (!boardId) continue;

        const key = `${jobBoard}:${boardId}`;
        if (seen.has(key)) continue;
        seen.add(key);

        candidates.push({
          name: boardId,
          job_board: jobBoard,
          company_board_id: boardId,
        });
      }
    }
    console.log(
      `${domain}: ${pages} pages, +${candidates.length - before} candidates`,
    );
  }

  return candidates;
}

// Verify by seeing if the API correctly returns jobs.
async function verifyCandidates(candidates: CompanyCandidate[]) {
  const kept: CompanyCandidate[] = [];
  let skipped = 0;

  for (const [i, candidate] of candidates.entries()) {
    if (i > 0) await sleep(VERIFY_DELAY_MS);

    const result = await fetchJobs(
      candidate.job_board,
      candidate.company_board_id,
    );
    if (result.ok) kept.push(candidate);
    else skipped++;

    const done = i + 1;
    if (done % PROGRESS_EVERY === 0 || done === candidates.length) {
      console.log(
        `Verified ${done}/${candidates.length} (${kept.length} kept)`,
      );
    }
  }

  return { kept, skipped };
}

// Persist to the db in batches.
async function upsertCompanies(companies: CompanyCandidate[]) {
  let inserted = 0;
  let failedBatches = 0;
  let failedRows = 0;

  for (let start = 0; start < companies.length; start += UPSERT_BATCH_SIZE) {
    const batch = companies.slice(start, start + UPSERT_BATCH_SIZE);
    const batchLabel = `rows ${start + 1}-${start + batch.length}`;

    const { data, error } = await supabase
      .from("companies")
      .upsert(batch, {
        onConflict: "job_board,company_board_id",
        ignoreDuplicates: true,
      })
      .select("id");

    if (error) {
      failedBatches++;
      failedRows += batch.length;
      console.error(`Upsert ${batchLabel} failed: ${error.message}`);
      continue;
    }
    inserted += data.length;
  }

  return { inserted, failedBatches, failedRows };
}

async function main(): Promise<void> {
  const indexId = await getNewestIndexId();
  console.log(`Common Crawl index ${indexId}`);

  const candidates = await discoverCandidates(indexId);
  const { kept, skipped } = await verifyCandidates(candidates);
  const { inserted, failedBatches, failedRows } = await upsertCompanies(kept);
  const existing = kept.length - failedRows - inserted;

  const failed = failedBatches > 0 ? `, ${failedRows} failed to save` : "";
  console.log(
    `Done: ${candidates.length} discovered, ${kept.length} kept, ${skipped} skipped, ${inserted} new, ${existing} existing${failed}`,
  );
  if (failedBatches > 0) process.exitCode = 1;
}

main().catch((err: unknown) => {
  console.error(err);
  process.exitCode = 1;
});
