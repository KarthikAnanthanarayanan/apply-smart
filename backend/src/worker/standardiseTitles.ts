import { setTimeout as sleep } from "node:timers/promises";
import { GoogleGenAI, Type } from "@google/genai";
import { supabase } from "../queries/client.js";

const PAGE_SIZE = 1_000;
const LOOKUP_BATCH_SIZE = 100; // titles per .in() filter, keeps the request URL short.
const LINK_BATCH_SIZE = 500;
const GEMINI_BATCH_SIZE = 150; // titles classified per Gemini request.
const GEMINI_REQUEST_INTERVAL_MS = 1_000;
const MAX_STANDARD_TITLES = 5;
const DEFAULT_GEMINI_MODEL = "gemini-2.5-flash-lite";

interface UnlinkedJob {
  id: string;
  title: string;
}

interface StandardTitle {
  id: string;
  name: string;
}

// raw title -> ids of its standard titles
type TitleMapping = Map<string, string[]>;

// Same normalisation the ESCO import uses for title_synonyms.title.
function normaliseTitle(title: string): string {
  return title.trim().toLowerCase();
}

// Links every job with no job_standard_titles rows to its standard titles: title_synonyms matches first, then
// Gemini for titles with none. Gemini answers are saved to title_synonyms. Returns every error hit, like ingestCompany.
export async function standardiseTitles(): Promise<string[]> {
  const errors: string[] = [];

  const jobIdsByTitle = new Map<string, string[]>();
  for (const job of await loadUnlinkedJobs()) {
    const title = normaliseTitle(job.title);
    if (!title) continue;
    jobIdsByTitle.set(title, [...(jobIdsByTitle.get(title) ?? []), job.id]);
  }
  if (jobIdsByTitle.size === 0) return errors;

  const titles = [...jobIdsByTitle.keys()];
  const mapping = await lookupSynonyms(titles);
  const misses = titles.filter((title) => !mapping.has(title));
  console.log(
    `Linking ${titles.length} distinct titles: ${mapping.size} in title_synonyms, ${misses.length} for Gemini`,
  );

  if (misses.length > 0) {
    for (const [title, ids] of await classifyWithGemini(misses, errors)) {
      mapping.set(title, ids);
    }
  }

  const links = [...mapping].flatMap(([title, standardTitleIds]) =>
    (jobIdsByTitle.get(title) ?? []).flatMap((job_id) =>
      standardTitleIds.map((standard_title_id) => ({ job_id, standard_title_id })),
    ),
  );
  const linkError = await saveRows("job_standard_titles", links, "job_id,standard_title_id");
  if (linkError) errors.push(`linking jobs failed: ${linkError}`);

  return errors;
}

// The left embed filtered to null is an anti-join: jobs with no job_standard_titles rows.
async function loadUnlinkedJobs(): Promise<UnlinkedJob[]> {
  const jobs: UnlinkedJob[] = [];
  for (let from = 0; ; from += PAGE_SIZE) {
    const { data, error } = await supabase
      .from("jobs")
      .select("id, title, job_standard_titles(job_id)")
      .is("job_standard_titles", null)
      .order("id")
      .range(from, from + PAGE_SIZE - 1);
    if (error) throw new Error(`Could not load unlinked jobs: ${error.message}`);

    jobs.push(...data.map((row) => ({ id: row.id as string, title: row.title as string })));
    if (data.length < PAGE_SIZE) break;
  }
  return jobs;
}

async function lookupSynonyms(titles: string[]): Promise<TitleMapping> {
  const mapping: TitleMapping = new Map();
  for (let start = 0; start < titles.length; start += LOOKUP_BATCH_SIZE) {
    const { data, error } = await supabase
      .from("title_synonyms")
      .select("title, standard_title_id")
      .in("title", titles.slice(start, start + LOOKUP_BATCH_SIZE));
    if (error)
      throw new Error(`Could not look up title synonyms: ${error.message}`);

    for (const row of data) {
      const title = row.title as string;
      mapping.set(title, [...(mapping.get(title) ?? []), row.standard_title_id as string]);
    }
  }
  return mapping;
}

// Sorted by name so the label list, and with it the prompt prefix Gemini caches, is identical across requests.
async function loadStandardTitles(): Promise<StandardTitle[]> {
  const titles: StandardTitle[] = [];
  for (let from = 0; ; from += PAGE_SIZE) {
    const { data, error } = await supabase
      .from("standard_titles")
      .select("id, name")
      .order("name")
      .range(from, from + PAGE_SIZE - 1);
    if (error)
      throw new Error(`Could not load standard titles: ${error.message}`);

    titles.push(...(data as StandardTitle[]));
    if (data.length < PAGE_SIZE) break;
  }
  return titles;
}

// Saves Gemini's mappings to title_synonyms. A failed batch is added to errors and retried on the next run.
async function classifyWithGemini(
  titles: string[],
  errors: string[],
): Promise<TitleMapping> {
  const mapping: TitleMapping = new Map();
  const { GEMINI_API_KEY, GEMINI_MODEL } = process.env;
  if (!GEMINI_API_KEY) {
    errors.push(`GEMINI_API_KEY is not set, ${titles.length} titles left unlinked`);
    return mapping;
  }
  const ai = new GoogleGenAI({ apiKey: GEMINI_API_KEY });
  const model = GEMINI_MODEL?.trim() || DEFAULT_GEMINI_MODEL;

  const labels = await loadStandardTitles();
  // The numbered label list goes first and is identical on every request, so Gemini's implicit
  // prompt caching bills it at the cached rate after the first batch.
  const systemInstruction =
    `ESCO occupations:\n${labels.map((label, i) => `${i}: ${label.name}`).join("\n")}\n\n` +
    "You map job titles to the ESCO occupations above. For each numbered job title, return the numbers " +
    `of the 1 to ${MAX_STANDARD_TITLES} closest occupations, best first. Ignore seniority, team names and ` +
    "locations. Return an empty list when no occupation is a reasonable fit (e.g. talent pools).";

  for (let start = 0; start < titles.length; start += GEMINI_BATCH_SIZE) {
    const batch = titles.slice(start, start + GEMINI_BATCH_SIZE);
    if (start > 0) await sleep(GEMINI_REQUEST_INTERVAL_MS);

    try {
      const answers = await requestClassification(ai, model, systemInstruction, batch);
      const batchMapping: TitleMapping = new Map();
      for (const [titleIndex, labelIndexes] of answers) {
        const title = batch[titleIndex];
        if (title === undefined || batchMapping.has(title)) continue;
        const ids = [
          ...new Set(
            labelIndexes
              .filter((i) => Number.isInteger(i) && i >= 0 && i < labels.length)
              .map((i) => labels[i]!.id),
          ),
        ].slice(0, MAX_STANDARD_TITLES);
        if (ids.length > 0) batchMapping.set(title, ids);
      }

      const synonyms = [...batchMapping].flatMap(([title, ids]) =>
        ids.map((standard_title_id) => ({ title, standard_title_id })),
      );
      const saveError = await saveRows("title_synonyms", synonyms, "title,standard_title_id");
      if (saveError) errors.push(`saving Gemini titles failed: ${saveError}`);
      for (const [title, ids] of batchMapping) mapping.set(title, ids);
    } catch (err) {
      errors.push(
        `Gemini batch ${start / GEMINI_BATCH_SIZE + 1}: ${err instanceof Error ? err.message : String(err)}`,
      );
    }
  }
  return mapping;
}

// Returns job title index -> label indexes, as Gemini answered them (unvalidated).
async function requestClassification(
  ai: GoogleGenAI,
  model: string,
  systemInstruction: string,
  titles: string[],
): Promise<Map<number, number[]>> {
  const response = await ai.models.generateContent({
    model,
    contents: `Job titles:\n${titles.map((title, i) => `${i}: ${title}`).join("\n")}`,
    config: {
      systemInstruction,
      temperature: 0,
      responseMimeType: "application/json",
      responseSchema: {
        type: Type.ARRAY,
        items: {
          type: Type.OBJECT,
          properties: {
            t: { type: Type.INTEGER },
            l: { type: Type.ARRAY, items: { type: Type.INTEGER } },
          },
          required: ["t", "l"],
        },
      },
    },
  });

  const parsed: unknown = JSON.parse(response.text ?? "");
  if (!Array.isArray(parsed)) throw new Error("response is not a JSON array");

  const answers = new Map<number, number[]>();
  for (const item of parsed as { t?: unknown; l?: unknown }[]) {
    if (typeof item.t !== "number" || !Array.isArray(item.l)) continue;
    answers.set(item.t, item.l.filter((i): i is number => typeof i === "number"));
  }
  return answers;
}

async function saveRows(
  table: string,
  rows: Record<string, string>[],
  onConflict: string,
): Promise<string | null> {
  const failures: string[] = [];
  for (let start = 0; start < rows.length; start += LINK_BATCH_SIZE) {
    const { error } = await supabase
      .from(table)
      .upsert(rows.slice(start, start + LINK_BATCH_SIZE), { onConflict, ignoreDuplicates: true });
    if (error) failures.push(error.message);
  }
  return failures.length > 0 ? failures.join("; ") : null;
}
