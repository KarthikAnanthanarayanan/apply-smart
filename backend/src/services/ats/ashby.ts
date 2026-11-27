import {
  badResponse,
  getJson,
  isoDateOrNull,
  isRecord,
  stringOrNull,
  type AtsJob,
  type FetchJobsResult,
} from "./http.js";
import {
  countryName,
  mergeLocations,
  parseLocation,
  REMOTE_CITY,
} from "./normalise.js";

export async function fetchJobs(
  companyBoardId: string,
): Promise<FetchJobsResult> {
  const url = `https://api.ashbyhq.com/posting-api/job-board/${encodeURIComponent(companyBoardId)}`;
  const res = await getJson(url);
  if (!res.ok) return res;

  if (!isRecord(res.body) || !Array.isArray(res.body.jobs)) {
    return badResponse("expected { jobs: [...] }");
  }

  // When job has no name or id or is privately listed (internal hires etc.)
  const jobs: AtsJob[] = res.body.jobs
    .filter(isRecord)
    .filter(
      (job) =>
        typeof job.id === "string" &&
        stringOrNull(job.title) &&
        job.isListed !== false,
    )
    .map((job) => {
      const address =
        isRecord(job.address) && isRecord(job.address.postalAddress)
          ? job.address.postalAddress
          : null;
      const { city, country } = mergeLocations(
        {
          city: stringOrNull(address?.addressLocality)?.trim() ?? null,
          country: countryName(address?.addressCountry),
        },
        parseLocation(stringOrNull(job.location)),
      );

      return {
        boardJobId: job.id as string,
        title: stringOrNull(job.title)!,
        // isRemote is also true for hybrid jobs, so use workplaceType.
        city: job.workplaceType === "Remote" ? REMOTE_CITY : city,
        country,
        applyUrl: stringOrNull(job.jobUrl),
        raw: job,
        updatedAt:
          typeof job.publishedAt === "string"
            ? isoDateOrNull(job.publishedAt)
            : null,
      };
    });

  return { ok: true, jobs };
}
