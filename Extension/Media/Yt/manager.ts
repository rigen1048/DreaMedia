/**
 * DreaMedia Extension — YouTube Manager
 * What triggers the Pipeline. Entry point for user-initiated and
 * backend-initiated YouTube operations.
 * No `any` type permitted.
 */

import { createYouTubeStorage, isValidDomainRow, isValidImportJob } from "./SQL/process/create";
import type { DomainRow } from "./Config/Model/types";
import type { ImportJob } from "./Config/Model/types";

/**
 * Manager interface for YouTube operations.
 * All methods return validated, typed results.
 */
export class YtManager {
  private initialized = false;

  /**
   * Initialize YouTube media storage and validate schema.
   * Must be called before any other operation.
   */
  async initialize(): Promise<void> {
    if (this.initialized) return;
    await createYouTubeStorage();
    this.initialized = true;
  }

  /**
   * Validate a domain row from storage.
   */
  validateDomainRow(row: unknown): DomainRow {
    if (!isValidDomainRow(row)) {
      throw new Error("Invalid domain row in YouTube storage");
    }
    return row;
  }

  /**
   * Validate an import job from storage.
   */
  validateImportJob(job: unknown): ImportJob {
    if (!isValidImportJob(job)) {
      throw new Error("Invalid import job in YouTube storage");
    }
    return job;
  }

  /**
   * Check if the manager is initialized.
   */
  isReady(): boolean {
    return this.initialized;
  }
}

export const ytManager = new YtManager();
