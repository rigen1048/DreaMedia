/**
 * DreaMedia Extension — Anime Manager
 * What triggers the Pipeline for anime. Entry point for user-initiated and
 * backend-initiated anime operations.
 * No `any` type permitted.
 */

import { createAnimeStorage, isValidDomainRow, isValidImportJob } from "./SQL/process/create";
import type { DomainRow } from "./Config/Model/types";
import type { ImportJob } from "./Config/Model/types";

export class AniManager {
  private initialized = false;

  async initialize(): Promise<void> {
    if (this.initialized) return;
    await createAnimeStorage();
    this.initialized = true;
  }

  validateDomainRow(row: unknown): DomainRow {
    if (!isValidDomainRow(row)) {
      throw new Error("Invalid domain row in Anime storage");
    }
    return row;
  }

  validateImportJob(job: unknown): ImportJob {
    if (!isValidImportJob(job)) {
      throw new Error("Invalid import job in Anime storage");
    }
    return job;
  }

  isReady(): boolean {
    return this.initialized;
  }
}

export const aniManager = new AniManager();
