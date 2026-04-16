/**
 * Daytona sandbox task wrapper with pipeline context injection.
 *
 * Wraps DaytonaClient.executeTask() to inject CAH_* environment
 * variables (D-07), parse agent stdout for JSON results, and
 * write checkpoint state to Postgres after execution (D-12).
 *
 * @see D-07 Entrypoint reads task config from environment variables
 * @see D-12 Per agent task checkpoint granularity
 * @see D-16 Full .planning/ directory in each sandbox
 */

import type { Pool } from 'pg';
import { SecretsManagerClient, GetSecretValueCommand } from '@aws-sdk/client-secrets-manager';
import type { DaytonaClient } from '../daytona-client.js';
import type { AgentTaskConfig } from '../types.js';
import type { StageMessage, AgentTaskOutcome, AgentRunData } from './types.js';
import { PipelineError } from './types.js';
import { buildTaskId } from './idempotency.js';
import { writeAgentCheckpoint } from './checkpoint.js';

// --- Secrets Manager (cold-start cache) -------------------------------------

/** Cached Anthropic API key resolved from Secrets Manager at Lambda cold start. */
let cachedApiKey: string | undefined;

/**
 * Fetches the Anthropic API key from Secrets Manager and caches it.
 *
 * The secret ARN is provided via ANTHROPIC_API_KEY_SECRET_ARN env var
 * (set by the pipeline-lambda CDK construct). The value is cached in
 * module scope so subsequent invocations reuse it within the same
 * Lambda execution context.
 *
 * @returns The resolved API key string
 * @throws Error if ANTHROPIC_API_KEY_SECRET_ARN is not set or secret fetch fails
 */
export async function getAnthropicApiKey(): Promise<string> {
  if (cachedApiKey) return cachedApiKey;
  const secretArn = process.env.ANTHROPIC_API_KEY_SECRET_ARN;
  if (!secretArn) throw new Error('ANTHROPIC_API_KEY_SECRET_ARN not set');
  const smClient = new SecretsManagerClient({
    region: process.env.AWS_DEFAULT_REGION ?? 'us-east-1',
  });
  const response = await smClient.send(
    new GetSecretValueCommand({ SecretId: secretArn }),
  );
  if (!response.SecretString) {
    throw new Error('Secrets Manager returned empty SecretString');
  }
  cachedApiKey = response.SecretString;
  return cachedApiKey;
}

// --- Types -------------------------------------------------------------------

/**
 * Configuration for running an agent task in a Daytona sandbox.
 *
 * @property msg - SQS stage message with pipeline context
 * @property plan - Plan name within the phase (e.g., "02-01")
 * @property wave - Execution wave number
 * @property command - Shell command to execute inside the sandbox
 * @property timeoutSeconds - Maximum execution time (default: 600)
 */
export interface SandboxTaskConfig {
  /** SQS stage message with pipeline context */
  msg: StageMessage;
  /** Plan name within the phase */
  plan: string;
  /** Execution wave number */
  wave: number;
  /** Shell command to execute inside the sandbox */
  command: string;
  /** Maximum execution time in seconds */
  timeoutSeconds?: number;
}

// --- Sandbox task execution --------------------------------------------------

/**
 * Runs an agent task in a Daytona sandbox with pipeline context injection.
 *
 * Injects CAH_RUN_ID, CAH_STAGE, CAH_PHASE, CAH_PLAN, CAH_BUCKET,
 * CAH_REPO_URL, CAH_BRANCH as environment variables (per D-07). Writes
 * checkpoint to Postgres after execution (per D-12).
 *
 * The ANTHROPIC_API_KEY is fetched from Secrets Manager via the ARN in
 * ANTHROPIC_API_KEY_SECRET_ARN and cached at cold start (T-02-08: never
 * logged, scoped per sandbox invocation, sandbox is ephemeral and deleted
 * after task).
 *
 * @param client - DaytonaClient instance for sandbox management
 * @param pool - Postgres connection pool for checkpoint writes
 * @param bucket - S3 bucket name for artifact storage
 * @param config - Sandbox task configuration
 * @returns Agent task outcome with metrics
 * @throws {PipelineError} When the agent task fails
 *
 * @example
 * const outcome = await runAgentTask(client, pool, 'cah-artifacts', {
 *   msg: stageMessage,
 *   plan: '02-01',
 *   wave: 1,
 *   command: 'node /harness/entrypoint.js',
 * });
 */
export async function runAgentTask(
  client: DaytonaClient,
  pool: Pool,
  bucket: string,
  config: SandboxTaskConfig,
): Promise<AgentTaskOutcome> {
  const taskKey = buildTaskId(
    config.msg.runId,
    String(config.msg.context.phaseNumber),
    config.plan,
    config.wave,
  );

  // Resolve API key from Secrets Manager (cold-start cached)
  const anthropicApiKey = await getAnthropicApiKey();

  // Build agent task config with pipeline context env vars (D-07)
  const agentConfig: AgentTaskConfig = {
    repoUrl: config.msg.repoUrl,
    branch: config.msg.branch,
    envVars: {
      CAH_RUN_ID: config.msg.runId,
      CAH_STAGE: config.msg.stage,
      CAH_PHASE: String(config.msg.context.phaseNumber),
      CAH_PLAN: config.plan,
      CAH_BUCKET: bucket,
      CAH_REPO_URL: config.msg.repoUrl,
      CAH_BRANCH: config.msg.branch,
      ANTHROPIC_API_KEY: anthropicApiKey,
    },
    command: config.command,
    timeoutSeconds: config.timeoutSeconds ?? 600,
  };

  const agentRunData: AgentRunData = {
    pipelineRunId: config.msg.runId,
    phase: config.msg.context.phaseNumber,
    planName: config.plan,
    wave: config.wave,
    status: 'running',
  };

  try {
    const result = await client.executeTask(agentConfig);

    // Parse JSON result from stdout (T-02-09: try/catch with fallback)
    // The entrypoint script writes a JSON line as the last output line
    let parsed: { success: boolean; costUsd: number; artifacts: string[] } = {
      success: result.exitCode === 0,
      costUsd: 0,
      artifacts: [],
    };
    try {
      const lastLine = result.stdout.trim().split('\n').pop() ?? '';
      parsed = JSON.parse(lastLine);
    } catch {
      // stdout may not be valid JSON if agent failed early
      // Fall back to exit code based determination
    }

    const outcome: AgentTaskOutcome = {
      taskKey,
      success: parsed.success,
      exitCode: result.exitCode,
      durationMs: result.durationMs,
      costUsd: parsed.costUsd,
      artifacts: parsed.artifacts,
    };

    await writeAgentCheckpoint(pool, taskKey, agentRunData, outcome);
    return outcome;
  } catch (err) {
    // If already a PipelineError from writeAgentCheckpoint, rethrow
    if (err instanceof PipelineError) throw err;

    const message = err instanceof Error ? err.message : String(err);
    const failOutcome: AgentTaskOutcome = {
      taskKey,
      success: false,
      exitCode: 1,
      durationMs: 0,
      costUsd: 0,
      artifacts: [],
      error: message,
    };

    await writeAgentCheckpoint(
      pool,
      taskKey,
      { ...agentRunData, status: 'failed' },
      failOutcome,
    );

    throw new PipelineError(
      `Agent task failed: ${message}`,
      'runAgentTask',
      config.msg.stage,
    );
  }
}
