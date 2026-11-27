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
  const url = `https://api.lever.co/v0/postings/${encodeURIComponent(companyBoardId)}?mode=json`;
  const res = await getJson(url);
  if (!res.ok) return res;

  if (!Array.isArray(res.body))
    return badResponse("expected an array of postings");

  // Defensive checks for no job id or title.
  const jobs: AtsJob[] = res.body
    .filter(isRecord)
    .filter((job) => typeof job.id === "string" && stringOrNull(job.text))
    .map((job) => {
      const categories = isRecord(job.categories) ? job.categories : null;
      const allLocations = Array.isArray(categories?.allLocations)
        ? categories.allLocations
        : [];
      const { city, country } = mergeLocations(
        { city: null, country: countryName(job.country) },
        parseLocation(stringOrNull(categories?.location)),
        parseLocation(stringOrNull(allLocations[0])),
      );

      return {
        boardJobId: job.id as string,
        title: stringOrNull(job.text)!,
        city: job.workplaceType === "remote" ? REMOTE_CITY : city,
        country,
        applyUrl: stringOrNull(job.hostedUrl),
        raw: job,
        updatedAt:
          typeof job.createdAt === "number"
            ? isoDateOrNull(job.createdAt)
            : null,
      };
    });

  return { ok: true, jobs };
}
