import { setTimeout as sleep } from "node:timers/promises";
import { supabase } from "../src/queries/client.js";

// Public ESCO API, no key needed. offset is a page number, not a row offset.
const ESCO_SEARCH_URL =
  "https://ec.europa.eu/esco/api/search?type=occupation&language=en";
const PAGE_SIZE = 50;
const REQUEST_DELAY_MS = 500;
const REQUEST_TIMEOUT_MS = 60_000;
const INSERT_BATCH_SIZE = 500;

interface Synonym {
  title: string;
  standard_title: string;
}

interface Occupation {
  preferred: string;
  alternatives: string[];
}

interface EscoResult {
  preferredLabel?: { en?: unknown };
  alternativeLabel?: { en?: unknown };
}

interface EscoPage {
  total: number;
  results: EscoResult[];
}

type FetchResult = { ok: true; page: EscoPage } | { ok: false; reason: string };

async function fetchPage(
  limit: number,
  offset: number,
  full: boolean,
): Promise<FetchResult> {
  await sleep(REQUEST_DELAY_MS);
  const url = `${ESCO_SEARCH_URL}&full=${full}&limit=${limit}&offset=${offset}`;
  try {
    const res = await fetch(url, {
      signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
    });
    if (!res.ok) {
      await res.body?.cancel();
      return { ok: false, reason: `HTTP ${res.status} ${res.statusText}` };
    }
    const body = (await res.json()) as {
      total?: unknown;
      _embedded?: { results?: EscoResult[] };
    };
    if (typeof body.total !== "number") {
      return { ok: false, reason: "response has no numeric total" };
    }
    return {
      ok: true,
      page: { total: body.total, results: body._embedded?.results ?? [] },
    };
  } catch (err) {
    return {
      ok: false,
      reason: err instanceof Error ? err.message : String(err),
    };
  }
}

function toOccupation(result: EscoResult): Occupation | null {
  const preferred = result.preferredLabel?.en;
  if (typeof preferred !== "string" || !preferred.trim()) return null;
  const alternatives = result.alternativeLabel?.en;
  return {
    preferred: preferred.trim(),
    alternatives: Array.isArray(alternatives)
      ? alternatives.filter((a): a is string => typeof a === "string")
      : [],
  };
}

// Some ESCO records (e.g. "civil engineer") make full=true return a 500, so a failing
// page is retried one occupation at a time, and a still-failing occupation falls back
// to its preferred label from the lightweight search.
async function fetchPageRows(
  page: number,
): Promise<{ results: EscoResult[]; labelOnly: string[] }> {
  const results: EscoResult[] = [];
  const labelOnly: string[] = [];

  for (let row = page * PAGE_SIZE; row < (page + 1) * PAGE_SIZE; row++) {
    const full = await fetchPage(1, row, true);
    if (full.ok) {
      results.push(...full.page.results);
      if (full.page.results.length === 0) break;
      continue;
    }

    const light = await fetchPage(1, row, false);
    if (!light.ok) {
      throw new Error(`ESCO row ${row}: ${light.reason}`);
    }
    if (light.page.results.length === 0) break;
    results.push(...light.page.results);
    const title = toOccupation(light.page.results[0])?.preferred;
    if (title) labelOnly.push(title);
  }

  return { results, labelOnly };
}

// Fetches every occupation's English preferred and alternative labels, in the API's order.
async function fetchOccupations(): Promise<{
  occupations: Occupation[];
  labelOnly: string[];
}> {
  const occupations: Occupation[] = [];
  const labelOnly: string[] = [];
  let total = Infinity;

  for (let page = 0; page * PAGE_SIZE < total; page++) {
    let results: EscoResult[];
    const res = await fetchPage(PAGE_SIZE, page, true);
    if (res.ok) {
      total = res.page.total;
      results = res.page.results;
    } else {
      console.warn(
        `ESCO page ${page} failed (${res.reason}), fetching its occupations one at a time`,
      );
      const rows = await fetchPageRows(page);
      results = rows.results;
      labelOnly.push(...rows.labelOnly);
    }
    if (results.length === 0) break;

    for (const result of results) {
      const occupation = toOccupation(result);
      if (occupation) occupations.push(occupation);
    }
    console.log(`Fetched ${occupations.length}/${total} occupations`);
  }

  return { occupations, labelOnly };
}

// A label ESCO lists under several occupations keeps a row for each of them.
function buildSynonyms(occupations: Occupation[]): {
  synonyms: Synonym[];
  duplicatesSkipped: number;
} {
  const seen = new Set<string>();
  const synonyms: Synonym[] = [];
  let duplicatesSkipped = 0;

  for (const { preferred, alternatives } of occupations) {
    for (const label of [preferred, ...alternatives]) {
      const raw = label.trim().toLowerCase();
      if (!raw) continue;

      const key = JSON.stringify([raw, preferred]);
      if (seen.has(key)) {
        duplicatesSkipped++;
        continue;
      }
      seen.add(key);
      synonyms.push({ title: raw, standard_title: preferred });
    }
  }

  return { synonyms, duplicatesSkipped };
}

// Creates any missing standard_titles rows and returns every standard title's id by name.
async function saveStandardTitles(names: string[]): Promise<Map<string, string>> {
  for (let start = 0; start < names.length; start += INSERT_BATCH_SIZE) {
    const { error } = await supabase
      .from("standard_titles")
      .upsert(
        names.slice(start, start + INSERT_BATCH_SIZE).map((name) => ({ name })),
        { onConflict: "name", ignoreDuplicates: true },
      );
    if (error) throw new Error(`Could not save standard titles: ${error.message}`);
  }

  const ids = new Map<string, string>();
  for (let from = 0; ; from += INSERT_BATCH_SIZE) {
    const { data, error } = await supabase
      .from("standard_titles")
      .select("id, name")
      .order("name")
      .range(from, from + INSERT_BATCH_SIZE - 1);
    if (error) throw new Error(`Could not load standard titles: ${error.message}`);

    for (const row of data) ids.set(row.name as string, row.id as string);
    if (data.length < INSERT_BATCH_SIZE) break;
  }
  return ids;
}

// ignoreDuplicates makes this ON CONFLICT (title, standard_title_id) DO NOTHING, so existing rows are kept.
async function insertSynonyms(synonyms: Synonym[], standardTitleIds: Map<string, string>) {
  let written = 0;
  let failedRows = 0;

  for (let start = 0; start < synonyms.length; start += INSERT_BATCH_SIZE) {
    const batch = synonyms.slice(start, start + INSERT_BATCH_SIZE);
    const { data, error } = await supabase
      .from("title_synonyms")
      .upsert(
        batch.map(({ title, standard_title }) => ({
          title,
          standard_title_id: standardTitleIds.get(standard_title),
        })),
        { onConflict: "title,standard_title_id", ignoreDuplicates: true },
      )
      .select("title");

    if (error) {
      failedRows += batch.length;
      console.error(
        `Insert rows ${start + 1}-${start + batch.length} failed: ${error.message}`,
      );
      continue;
    }
    written += data.length;
  }

  return { written, failedRows };
}

async function main(): Promise<void> {
  const { occupations, labelOnly } = await fetchOccupations();
  const { synonyms, duplicatesSkipped } = buildSynonyms(occupations);

  const standardTitleIds = await saveStandardTitles([
    ...new Set(occupations.map((occupation) => occupation.preferred)),
  ]);
  const { written, failedRows } = await insertSynonyms(synonyms, standardTitleIds);

  console.log(`Rows written: ${written}`);
  console.log(`Duplicates skipped: ${duplicatesSkipped}`);
  if (labelOnly.length > 0) {
    console.log(
      `Preferred label only (ESCO errored on full record): ${labelOnly.join(", ")}`,
    );
  }
  if (failedRows > 0) {
    console.log(`Failed to save: ${failedRows}`);
    process.exitCode = 1;
  }
}

main().catch((err: unknown) => {
  console.error(err);
  process.exitCode = 1;
});
