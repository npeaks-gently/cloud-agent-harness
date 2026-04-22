/**
 * Boundary 2 verification: CLI dispatch → SQS message shape
 *
 * Sends a real PipelineJobMessage to SQS, receives it back,
 * and verifies the shape matches what stage-router expects.
 * Uses a DEDICATED TEST QUEUE (not the live job queue) to avoid
 * triggering the pipeline Lambda.
 *
 * Usage: NODE_OPTIONS="" npx tsx scripts/verify-boundary-2.ts
 */

import {
  SQSClient,
  CreateQueueCommand,
  DeleteQueueCommand,
  SendMessageCommand,
  ReceiveMessageCommand,
  DeleteMessageCommand,
  GetQueueAttributesCommand,
} from '@aws-sdk/client-sqs';

const REGION = 'us-east-1';
const TEST_QUEUE_NAME = `cah-boundary2-test-${Date.now()}`;

// Replicate the type guards from stage-router.ts and sqs-consumer.ts
// so we can verify the message passes both

function isPipelineJobMessage(body: unknown): body is Record<string, unknown> {
  if (typeof body !== 'object' || body === null) return false;
  const obj = body as Record<string, unknown>;
  return (
    typeof obj.projectId === 'string' &&
    typeof obj.repoUrl === 'string' &&
    typeof obj.branch === 'string' &&
    typeof obj.featureDescription === 'string' &&
    obj.stage === undefined
  );
}

function isSqsConsumerCompatible(body: unknown): body is Record<string, unknown> {
  if (typeof body !== 'object' || body === null) return false;
  const obj = body as Record<string, unknown>;
  return (
    typeof obj.projectId === 'string' &&
    typeof obj.repoUrl === 'string' &&
    typeof obj.branch === 'string' &&
    typeof obj.featureDescription === 'string'
  );
}

async function main(): Promise<void> {
  console.log('=== Boundary 2: CLI → SQS (live AWS round-trip) ===\n');

  const sqs = new SQSClient({ region: REGION });
  let queueUrl: string | undefined;

  try {
    // 1. Create a temporary test queue
    console.log(`Creating temp queue: ${TEST_QUEUE_NAME}`);
    const createResult = await sqs.send(
      new CreateQueueCommand({ QueueName: TEST_QUEUE_NAME }),
    );
    queueUrl = createResult.QueueUrl;
    if (!queueUrl) throw new Error('Failed to create test queue');
    console.log(`  Queue URL: ${queueUrl}\n`);

    // 2. Build the exact message dispatch() would send
    const message = {
      projectId: 'boundary-test-2',
      repoUrl: 'https://github.com/test/verify',
      branch: 'main',
      featureDescription: 'Boundary 2 SQS verification test',
      planningPrefix: 'triggers/a1b2c3d4-e5f6-7890-abcd-ef1234567890/planning/',
    };

    console.log('--- Sending message ---');
    console.log(JSON.stringify(message, null, 2));

    await sqs.send(
      new SendMessageCommand({
        QueueUrl: queueUrl,
        MessageBody: JSON.stringify(message),
      }),
    );
    console.log('  Sent successfully\n');

    // 3. Receive it back
    console.log('--- Receiving message ---');
    const receiveResult = await sqs.send(
      new ReceiveMessageCommand({
        QueueUrl: queueUrl,
        MaxNumberOfMessages: 1,
        WaitTimeSeconds: 5,
      }),
    );

    const received = receiveResult.Messages?.[0];
    if (!received?.Body) {
      console.error('FAIL: No message received from queue');
      process.exit(1);
    }

    const parsed = JSON.parse(received.Body);
    console.log('Received body:');
    console.log(JSON.stringify(parsed, null, 2));

    // Delete the message so it doesn't linger
    if (received.ReceiptHandle) {
      await sqs.send(
        new DeleteMessageCommand({
          QueueUrl: queueUrl,
          ReceiptHandle: received.ReceiptHandle,
        }),
      );
    }

    // 4. Run checks
    console.log('\n--- Checks ---');
    let allPassed = true;

    // Check: stage-router isPipelineJobMessage type guard
    const passesRouterGuard = isPipelineJobMessage(parsed);
    console.log(`  [${passesRouterGuard ? 'PASS' : 'FAIL'}] Passes stage-router isPipelineJobMessage() type guard`);
    if (!passesRouterGuard) allPassed = false;

    // Check: sqs-consumer isPipelineJobMessage type guard
    const passesConsumerGuard = isSqsConsumerCompatible(parsed);
    console.log(`  [${passesConsumerGuard ? 'PASS' : 'FAIL'}] Passes sqs-consumer isPipelineJobMessage() type guard`);
    if (!passesConsumerGuard) allPassed = false;

    // Check: no 'stage' field (would cause misrouting as StageMessage)
    const noStageField = parsed.stage === undefined;
    console.log(`  [${noStageField ? 'PASS' : 'FAIL'}] No 'stage' field present (avoids StageMessage misidentification)`);
    if (!noStageField) allPassed = false;

    // Check: planningPrefix preserved through JSON round-trip
    const prefixPreserved = parsed.planningPrefix === message.planningPrefix;
    console.log(`  [${prefixPreserved ? 'PASS' : 'FAIL'}] planningPrefix preserved through SQS round-trip`);
    if (!prefixPreserved) allPassed = false;

    // Check: all required fields present and typed correctly
    const fieldsCorrect =
      typeof parsed.projectId === 'string' &&
      typeof parsed.repoUrl === 'string' &&
      typeof parsed.branch === 'string' &&
      typeof parsed.featureDescription === 'string';
    console.log(`  [${fieldsCorrect ? 'PASS' : 'FAIL'}] All required fields present and string-typed`);
    if (!fieldsCorrect) allPassed = false;

    // Check: JSON body is exact match (no mutation by SQS)
    const bodyMatch = received.Body === JSON.stringify(message);
    console.log(`  [${bodyMatch ? 'PASS' : 'FAIL'}] SQS body is byte-identical to sent message`);
    if (!bodyMatch) allPassed = false;

    console.log(`\n=== Boundary 2: ${allPassed ? 'PASS' : 'FAIL'} ===`);
    if (!allPassed) process.exit(1);
  } finally {
    // 5. Cleanup: delete the temp queue
    if (queueUrl) {
      console.log(`\n--- Cleanup ---`);
      await sqs.send(new DeleteQueueCommand({ QueueUrl: queueUrl }));
      console.log(`  Deleted queue: ${TEST_QUEUE_NAME}`);
    }
  }
}

main().catch((err) => {
  console.error('Unhandled error:', err);
  process.exit(1);
});
