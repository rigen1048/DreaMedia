/**
 * DreaMedia Extension — YouTube Fetch Layer
 * Fetch operations for YouTube data. No `any` type permitted.
 */

import type { SubscriptionOptions } from "../Config/Model/types";
import type { ImportJob } from "../Config/Model/types";

/**
 * Start a YouTube bulk import via GraphQL.
 */
export async function startYouTubeImport(
  sendGraphQL: (query: string, variables: Record<string, unknown>) => Promise<unknown>,
  links: string[],
  options: SubscriptionOptions
): Promise<ImportJob> {
  const data = await sendGraphQL(
    `mutation StartYouTubeImport($payload: JSON!, $kind: String!, $words: [String!], $rank: String, $withhold: Int, $domain: String, $subdomain: String) {
      startYoutubeImport(payload: $payload, kind: $kind, words: $words, rank: $rank, withhold: $withhold, domain: $domain, subdomain: $subdomain) { jobId status requested processed resolved added skipped failed }
    }`,
    {
      payload: { sources: links.map((link) => ({ link })) },
      kind: options.kind,
      words: options.words ?? null,
      rank: options.rank ?? null,
      withhold: options.withhold ?? null,
      domain: options.domain ?? null,
      subdomain: options.subdomain ?? null,
    }
  );

  const result = data as { startYoutubeImport: ImportJob };
  return result.startYoutubeImport;
}

/**
 * Get import job status via GraphQL.
 */
export async function getYouTubeImportJob(
  sendGraphQL: (query: string, variables: Record<string, unknown>) => Promise<unknown>,
  jobId: string,
  includeItems: boolean
): Promise<ImportJob> {
  const data = await sendGraphQL(
    `query YoutubeImportJob($jobId: String!, $includeItems: Boolean!) {
      youtubeImportJob(jobId: $jobId, includeItems: $includeItems) {
        jobId status requested processed resolved added skipped failed errors
        items { ordinal link status error retryable }
      }
    }`,
    { jobId, includeItems }
  );

  const result = data as { youtubeImportJob: ImportJob };
  return result.youtubeImportJob;
}

/**
 * Retry a failed YouTube import job via GraphQL.
 */
export async function retryYouTubeImport(
  sendGraphQL: (query: string, variables: Record<string, unknown>) => Promise<unknown>,
  jobId: string
): Promise<ImportJob> {
  const data = await sendGraphQL(
    `mutation RetryYouTubeImport($jobId: String!) {
      retryYoutubeImport(jobId: $jobId) { jobId status requested processed resolved added skipped failed }
    }`,
    { jobId }
  );

  const result = data as { retryYoutubeImport: ImportJob };
  return result.retryYoutubeImport;
}
