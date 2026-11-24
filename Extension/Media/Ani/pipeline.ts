/**
 * DreaMedia Extension — Anime Pipeline
 * Pipeline orchestrator for anime operations.
 * Coordinates Access, Feed, Fetch, Filter, and SQL layers.
 * No `any` type permitted.
 */

import type { SubscriptionOptions } from "./Config/Model/types";
import type { DomainRow } from "./Config/Model/types";
import type { ImportJob } from "./Config/Model/types";
import { aniManager } from "./manager";

export interface PipelineResult<T> {
  ok: boolean;
  data: T | null;
  error: string | null;
}

export class AniPipeline {
  private sendGraphQL: (query: string, variables: Record<string, unknown>) => Promise<unknown>;

  constructor(
    sendGraphQL: (query: string, variables: Record<string, unknown>) => Promise<unknown>
  ) {
    this.sendGraphQL = sendGraphQL;
  }

  async ensureReady(): Promise<void> {
    if (!aniManager.isReady()) {
      await aniManager.initialize();
    }
  }

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

  async addDomain(domain: string): Promise<PipelineResult<DomainRow>> {
    await this.ensureReady();
    try {
      const row = await (await import("./Access")).addDomain(
        this.sendGraphQL,
        domain,
        "ani"
      );
      return { ok: true, data: row, error: null };
    } catch (error) {
      return { ok: false, data: null, error: error instanceof Error ? error.message : "Unknown error" };
    }
  }

  async fetchDomains(): Promise<PipelineResult<DomainRow[]>> {
    await this.ensureReady();
    try {
      const rows = await (await import("./Feed")).fetchDomains(this.sendGraphQL);
      return { ok: true, data: rows, error: null };
    } catch (error) {
      return { ok: false, data: null, error: error instanceof Error ? error.message : "Unknown error" };
    }
  }

  async startImport(
    links: string[],
    options: SubscriptionOptions
  ): Promise<PipelineResult<ImportJob>> {
    await this.ensureReady();
    try {
      const job = await (await import("./Fetch")).startAnimeImport(
        this.sendGraphQL,
        links,
        options
      );
      return { ok: true, data: job, error: null };
    } catch (error) {
      return { ok: false, data: null, error: error instanceof Error ? error.message : "Unknown error" };
    }
  }

  async getImportJob(
    jobId: string,
    includeItems: boolean
  ): Promise<PipelineResult<ImportJob>> {
    await this.ensureReady();
    try {
      const job = await (await import("./Fetch")).getAnimeImportJob(
        this.sendGraphQL,
        jobId,
        includeItems
      );
      return { ok: true, data: job, error: null };
    } catch (error) {
      return { ok: false, data: null, error: error instanceof Error ? error.message : "Unknown error" };
    }
  }

  async retryImport(jobId: string): Promise<PipelineResult<ImportJob>> {
    await this.ensureReady();
    try {
      const job = await (await import("./Fetch")).retryAnimeImport(
        this.sendGraphQL,
        jobId
      );
      return { ok: true, data: job, error: null };
    } catch (error) {
      return { ok: false, data: null, error: error instanceof Error ? error.message : "Unknown error" };
    }
  }
}
