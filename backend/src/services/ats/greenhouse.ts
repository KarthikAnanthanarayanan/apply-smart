import {
  badResponse,
  getJson,
  isoDateOrNull,
  isRecord,
  stringOrNull,
  type AtsJob,
  type FetchJobsResult,
} from "./http.js";
import { parseLocation } from "./normalise.js";

export async function fetchJobs(
  companyBoardId: string,
): Promise<FetchJobsResult> {
  const url = `https://boards-api.greenhouse.io/v1/boards/${encodeURIComponent(companyBoardId)}/jobs?content=true`;
  const res = await getJson(url);
  if (!res.ok) return res;

  if (!isRecord(res.body) || !Array.isArray(res.body.jobs)) {
    return badResponse("expected { jobs: [...] }");
  }

  const jobs: AtsJob[] = res.body.jobs
    .filter(isRecord)
    .filter(
      (job) =>
        (typeof job.id === "number" || typeof job.id === "string") &&
        stringOrNull(job.title),
    )
    .map((job) => {
      const firstOffice =
        Array.isArray(job.offices) && isRecord(job.offices[0])
          ? job.offices[0]
          : null;
      // The job's own location first, then its office. null = not in Australia.
      const place =
        parseLocation(
          isRecord(job.location) ? stringOrNull(job.location.name) : null,
        ) ?? parseLocation(stringOrNull(firstOffice?.location));

      return {
        boardJobId: String(job.id),
        title: stringOrNull(job.title)!,
        city: place?.city ?? null,
        state: place?.state ?? null,
        country: place?.country ?? null,
        applyUrl: stringOrNull(job.absolute_url),
        raw: job,
        updatedAt:
          isoDateOrNull(job.first_published) ?? isoDateOrNull(job.updated_at),
      };
    });

  return { ok: true, jobs };
}
