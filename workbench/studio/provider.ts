import { sha256, type Artifact, type Hyperparameters } from "./schema.js";

/**
 * The boundary between the studio and whatever trains models.
 *
 * The engine only ever talks to this interface. A vendor integration
 * implements it later with real credentials and real jobs; until then the
 * local development provider below implements it with no network, no
 * credentials and no weights, and says so on everything it produces.
 */

export interface ProviderConfig {
  baseModel: string;
  hyperparameters: Hyperparameters;
}

export interface ProviderDataset {
  contentHash: string;
  records: number;
  bytes: number;
}

export interface ProviderJobState {
  providerJobId: string;
  status: "running" | "succeeded" | "failed" | "cancelled";
  /** Safe to show and to store. Never carries credentials or dataset content. */
  detail: string;
  finishedAt?: string;
}

export interface TrainingProvider {
  /** Stable id stored on every config and job that used this provider. */
  id: string;
  label: string;
  /** Problems with a configuration, in plain words. Empty means it can start. */
  validateConfiguration(config: ProviderConfig): string[];
  /** A rough size for the job, so a person sees what they are about to start. */
  estimate(config: ProviderConfig, dataset: ProviderDataset): { units: number; note: string };
  startJob(config: ProviderConfig, dataset: ProviderDataset, configHash: string): { providerJobId: string };
  getJob(providerJobId: string): ProviderJobState;
  cancelJob(providerJobId: string): ProviderJobState;
  /** The output of a succeeded job, or undefined while there is none. */
  resolveArtifact(providerJobId: string): Artifact | undefined;
}

export const LOCAL_DEV_PROVIDER = "local-dev";
export const DEVELOPMENT_ARTIFACT_NOTE = "Development artifact from the local development provider. No model weights were trained.";

/**
 * A provider that trains nothing.
 *
 * It exists so the whole studio flow can be exercised, tested and
 * demonstrated on one machine. It is deterministic: the same configuration
 * and dataset always produce the same job id and the same artifact hash, so
 * a test can assert on them and a restart cannot lose track of a job. The
 * job "succeeds" on the first status check after it starts.
 *
 * Nothing it produces can be mistaken for a trained model. Every artifact is
 * labelled "development" and carries a note saying no weights exist, and the
 * UI repeats that wherever the artifact is shown.
 */
export function localDevProvider(options: { now?: () => string } = {}): TrainingProvider {
  const now = options.now ?? (() => new Date().toISOString());
  const cancelled = new Set<string>();
  const started = new Map<string, { checks: number }>();

  const artifactFor = (providerJobId: string): Artifact => {
    const hash = sha256(`development-artifact:${providerJobId}`);
    return { uri: `magentic-dev://artifacts/${hash}`, hash, label: "development", note: DEVELOPMENT_ARTIFACT_NOTE };
  };

  return {
    id: LOCAL_DEV_PROVIDER,
    label: "Local development provider (no training)",

    validateConfiguration(config) {
      const problems: string[] = [];
      if (config.hyperparameters.learningRate > 0.01) problems.push("Learning rate above 0.01 is refused by the development provider as a likely typo.");
      if (config.hyperparameters.epochs > 10) problems.push("The development provider accepts at most 10 epochs.");
      return problems;
    },

    estimate(config, dataset) {
      const units = dataset.records * config.hyperparameters.epochs;
      return { units, note: `${dataset.records} records × ${config.hyperparameters.epochs} epochs = ${units} example passes. Development estimate only; no compute is used.` };
    },

    startJob(_config, dataset, configHash) {
      const providerJobId = `dev-${sha256(`${configHash}:${dataset.contentHash}`).slice(0, 16)}`;
      started.set(providerJobId, { checks: 0 });
      cancelled.delete(providerJobId);
      return { providerJobId };
    },

    getJob(providerJobId) {
      if (!/^dev-[0-9a-f]{16}$/.test(providerJobId)) {
        return { providerJobId, status: "failed", detail: "This job id does not belong to the development provider." };
      }
      if (cancelled.has(providerJobId)) return { providerJobId, status: "cancelled", detail: "Cancelled before completion." };
      // A job this process did not start is one from before a restart. The
      // provider is deterministic, so its outcome is known without any
      // record of it: it succeeded. A job it did start succeeds on the
      // first check; the check count only decides whether cancel is still
      // possible.
      const state = started.get(providerJobId);
      if (state) state.checks++;
      return { providerJobId, status: "succeeded", detail: "Development job complete.", finishedAt: now() };
    },

    cancelJob(providerJobId) {
      const state = started.get(providerJobId);
      if (state && state.checks === 0) {
        cancelled.add(providerJobId);
        return { providerJobId, status: "cancelled", detail: "Cancelled before completion.", finishedAt: now() };
      }
      return this.getJob(providerJobId);
    },

    resolveArtifact(providerJobId) {
      return this.getJob(providerJobId).status === "succeeded" ? artifactFor(providerJobId) : undefined;
    },
  };
}
