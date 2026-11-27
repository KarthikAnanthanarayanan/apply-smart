import {
  badResponse,
  getJson,
  isRecord,
  stringOrNull,
  type AtsJob,
  type FetchJobsResult,
} from './http.js';

export async function fetchJobs(companyBoardId: string): Promise<FetchJobsResult> {
  const url = `https://api.lever.co/v0/postings/${encodeURIComponent(companyBoardId)}?mode=json`;
  const res = await getJson(url);
  if (!res.ok) return res;

  // Lever returns a bare array of postings.
  if (!Array.isArray(res.body)) return badResponse('expected an array of postings');

  const jobs: AtsJob[] = res.body.filter(isRecord).map((job) => ({
    id: String(job.id),
    title: stringOrNull(job.text) ?? '',
    location: isRecord(job.categories) ? stringOrNull(job.categories.location) : null,
    url: stringOrNull(job.hostedUrl),
    raw: job,
  }));

  return { ok: true, jobs };
}
