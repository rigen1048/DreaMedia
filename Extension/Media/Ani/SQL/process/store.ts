/**
 * DreaMedia Extension — Anime SQL Process Layer
 * Operations intended to be used by the backend mechanism itself.
 * No `any` type permitted.
 */

import type { ImportJob } from "../../Config/Model/types";
import type { ImportItem } from "../../Config/Model/types";

export async function createImportJob(
  sendGraphQL: (query: string, variables: Record<string, unknown>) => Promise<unknown>,
  job: Omit<ImportJob, "items">
): Promise<ImportJob> {
  const data = await sendGraphQL(
    `mutation CreateImportJob($jobId: String!, $status: String!, $requested: Int!, $processed: Int!, $resolved: Int!, $added: Int!, $skipped: Int!, $failed: Int!) {
      createImportJob(jobId: $jobId, status: $status, requested: $requested, processed: $processed, resolved: $resolved, added: $added, skipped: $skipped, failed: $failed) { jobId status requested processed resolved added skipped failed }
    }`,
    {
      jobId: job.jobId,
      status: job.status,
      requested: job.requested,
      processed: job.processed,
      resolved: job.resolved,
      added: job.added,
      skipped: job.skipped,
      failed: job.failed,
    }
  );
  const result = data as { createImportJob: ImportJob };
  return { ...result.createImportJob, items: null };
}

export async function updateImportJobProgress(
  sendGraphQL: (query: string, variables: Record<string, unknown>) => Promise<unknown>,
  jobId: string,
  processed: number,
  resolved: number,
  added: number,
  skipped: number,
  failed: number
): Promise<ImportJob> {
  const data = await sendGraphQL(
    `mutation UpdateImportJob($jobId: String!, $processed: Int!, $resolved: Int!, $added: Int!, $skipped: Int!, $failed: Int!) {
      updateImportJob(jobId: $jobId, processed: $processed, resolved: $resolved, added: $added, skipped: $skipped, failed: $failed) { jobId status requested processed resolved added skipped failed }
    }`,
    { jobId, processed, resolved, added, skipped, failed }
  );
  const result = data as { updateImportJob: ImportJob };
  return { ...result.updateImportJob, items: null };
}

export async function recordFailedItems(
  sendGraphQL: (query: string, variables: Record<string, unknown>) => Promise<unknown>,
  jobId: string,
  items: ImportItem[]
): Promise<void> {
  await sendGraphQL(
    `mutation RecordFailedItems($jobId: String!, $items: [ImportItemInput!]!) {
      recordFailedItems(jobId: $jobId, items: $items) { ok }
    }`,
    { jobId, items: items }
  );
}

export async function processFetchActiveJobs(
  sendGraphQL: (query: string, variables: Record<string, unknown>) => Promise<unknown>
): Promise<ImportJob[]> {
  const data = await sendGraphQL(`query { activeImportJobs { jobId status requested processed resolved added skipped failed } }`, {});
  const result = data as { activeImportJobs: ImportJob[] };
  return result.activeImportJobs.map((job) => ({ ...job, items: null }));
}
