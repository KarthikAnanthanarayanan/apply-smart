import {
  badResponse,
  getJson,
  isRecord,
  stringOrNull,
  type AtsJob,
  type FetchJobsResult,
} from './http.js';

export async function fetchJobs(companyBoardId: string): Promise<FetchJobsResult> {
  const url = `https://boards-api.greenhouse.io/v1/boards/${encodeURIComponent(companyBoardId)}/jobs`;
  const res = await getJson(url);
  if (!res.ok) return res;

  if (!isRecord(res.body) || !Array.isArray(res.body.jobs)) {
    return badResponse('expected { jobs: [...] }');
  }

  const jobs: AtsJob[] = res.body.jobs.filter(isRecord).map((job) => ({
    id: String(job.id),
    title: stringOrNull(job.title) ?? '',
    location: isRecord(job.location) ? stringOrNull(job.location.name) : null,
    url: stringOrNull(job.absolute_url),
    raw: job,
  }));

  return { ok: true, jobs };
}
