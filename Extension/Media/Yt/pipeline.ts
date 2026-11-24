/**
 * DreaMedia Extension — YouTube Pipeline
 * Pipeline orchestrator for YouTube operations.
 * Coordinates Access, Feed, Fetch, Filter, and SQL layers.
 * No `any` type permitted.
 */

import type { SubscriptionOptions } from "./Config/Model/types";
import type { DomainRow } from "./Config/Model/types";
import type { ImportJob } from "./Config/Model/types";
import { ytManager } from "./manager";

/**
 * Pipeline result type.
 */
export interface PipelineResult<T> {
  ok: boolean;
  data: T | null;
  error: string | null;
}

/**
 * YouTube pipeline class. All operations flow through here.
 */
export class YtPipeline {
  private sendGraphQL: (query: string, variables: Record<string, unknown>) => Promise<unknown>;

  constructor(
    sendGraphQL: (query: string, variables: Record<string, unknown>) => Promise<unknown>
  ) {
    this.sendGraphQL = sendGraphQL;
  }

  /**
   * Ensure the manager is initialized before any pipeline operation.
   */
  async ensureReady(): Promise<void> {
    if (!ytManager.isReady()) {
      await ytManager.initialize();
    }
  }

  /**
   * Subscribe to a YouTube source (Access layer → SQL/user).
   */
  async subscribe(options: SubscriptionOptions): Promise<PipelineResult<{ channelId: number }>> {
    await this.ensureReady();
    try {
      const { ok, channelId } = await (await import("./Access")).subscribe(
        this.sendGraphQL,
        options
      );
      return { ok, data: { channelId: channelId ?? 0 }, error: null };
    } catch (error) {
      return { ok: false, data: null, error: error instanceof Error ? error.message : "Unknown error" };
    }
  }

  /**
   * Add a domain to the allowlist (Access layer → SQL/user).
   */
  async addDomain(domain: string): Promise<PipelineResult<DomainRow>> {
    await this.ensureReady();
    try {
      const row = await (await import("./Access")).addDomain(
        this.sendGraphQL,
        domain,
        "yt"
      );
      return { ok: true, data: row, error: null };
    } catch (error) {
      return { ok: false, data: null, error: error instanceof Error ? error.message : "Unknown error" };
    }
  }

  /**
   * Fetch domains (Feed layer → SQL/user).
   */
  async fetchDomains(): Promise<PipelineResult<DomainRow[]>> {
    await this.ensureReady();
    try {
      const rows = await (await import("./Feed")).fetchDomains(this.sendGraphQL);
      return { ok: true, data: rows, error: null };
    } catch (error) {
      return { ok: false, data: null, error: error instanceof Error ? error.message : "Unknown error" };
    }
  }

  /**
   * Start a YouTube bulk import (Fetch layer → SQL/process).
   */
  async startImport(
    links: string[],
    options: SubscriptionOptions
  ): Promise<PipelineResult<ImportJob>> {
    await this.ensureReady();
    try {
      const job = await (await import("./Fetch")).startYouTubeImport(
        this.sendGraphQL,
        links,
        options
      );
      return { ok: true, data: job, error: null };
    } catch (error) {
      return { ok: false, data: null, error: error instanceof Error ? error.message : "Unknown error" };
    }
  }

  /**
   * Get import job status (Fetch layer → SQL/process).
   */
  async getImportJob(
    jobId: string,
    includeItems: boolean
  ): Promise<PipelineResult<ImportJob>> {
    await this.ensureReady();
    try {
      const job = await (await import("./Fetch")).getYouTubeImportJob(
        this.sendGraphQL,
        jobId,
        includeItems
      );
      return { ok: true, data: job, error: null };
    } catch (error) {
      return { ok: false, data: null, error: error instanceof Error ? error.message : "Unknown error" };
    }
  }

  /**
   * Retry a failed import job (Fetch layer → SQL/process).
   */
  async retryImport(jobId: string): Promise<PipelineResult<ImportJob>> {
    await this.ensureReady();
    try {
      const job = await (await import("./Fetch")).retryYouTubeImport(
        this.sendGraphQL,
        jobId
      );
      return { ok: true, data: job, error: null };
    } catch (error) {
      return { ok: false, data: null, error: error instanceof Error ? error.message : "Unknown error" };
    }
  }
}
