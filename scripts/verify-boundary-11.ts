/**
 * Boundary 11 verification: Approve -> Slack (live DM)
 *
 * Sends a real Block Kit approval message via DM using sendApprovalMessage(),
 * then sends an escalation message via sendEscalationMessage().
 * Verifies both message types render correctly in Slack.
 *
 * Usage: NODE_OPTIONS="" npx tsx scripts/verify-boundary-11.ts
 */

import { randomUUID } from 'node:crypto';

// Set the env var before importing slack.ts (it reads at import time for cache)
process.env.SLACK_BOT_TOKEN_SECRET_ARN = 'arn:aws:secretsmanager:us-east-1:659828095854:secret:cah-dev-slack-bot-token-VPynMv';

import { sendApprovalMessage, sendEscalationMessage } from '../src/cloud/integrations/slack.js';

const SLACK_USER_ID = 'U0A6ZENN1D5';

async function main(): Promise<void> {
  console.log('=== Boundary 11: Approve → Slack (live DM) ===\n');

  const fakeRunId = `boundary-test-${randomUUID().slice(0, 8)}`;
  const fakeToken = randomUUID();
  let allPassed = true;

  // --- Test 1: Plan approval message ---
  console.log('--- Test 1: sendApprovalMessage ---');
  try {
    const planSummary = [
      '*Feature:* Add user authentication with OAuth2',
      '*Phase:* 2 of 5',
      '*Project:* `cloud-agent-harness`',
    ].join('\n');

    const messageTs = await sendApprovalMessage(
      SLACK_USER_ID,
      fakeRunId,
      'boundary-test',
      fakeToken,
      planSummary,
    );

    const hasTs = typeof messageTs === 'string' && messageTs.length > 0;
    console.log(`  [${hasTs ? 'PASS' : 'FAIL'}] Message sent, ts=${messageTs}`);
    if (!hasTs) allPassed = false;

    console.log('  Check your Slack DMs for a "Pipeline Plan Approval" message with Approve/Reject buttons');
  } catch (err) {
    console.error(`  [FAIL] sendApprovalMessage threw:`, err);
    allPassed = false;
  }

  // --- Test 2: Escalation message ---
  console.log('\n--- Test 2: sendEscalationMessage ---');
  const escalationToken = randomUUID();
  try {
    const escalationTs = await sendEscalationMessage(
      SLACK_USER_ID,
      fakeRunId,
      'boundary-test',
      escalationToken,
      'The auto-decider wants to add `lodash` as a new dependency for deep object merging.',
      'New external dependency addition affects supply chain security',
    );

    const hasTs = typeof escalationTs === 'string' && escalationTs.length > 0;
    console.log(`  [${hasTs ? 'PASS' : 'FAIL'}] Escalation sent, ts=${escalationTs}`);
    if (!hasTs) allPassed = false;

    console.log('  Check your Slack DMs for a "Risk Escalation" message with Approve Decision/Reject Decision buttons');
  } catch (err) {
    console.error(`  [FAIL] sendEscalationMessage threw:`, err);
    allPassed = false;
  }

  // --- Summary ---
  console.log(`\n--- Checks ---`);
  console.log(`  [${allPassed ? 'PASS' : 'FAIL'}] Both messages sent successfully`);
  console.log(`  [MANUAL] Verify in Slack DMs:`);
  console.log(`    1. "Pipeline Plan Approval" with Approve + Reject buttons`);
  console.log(`    2. "Risk Escalation" with Approve Decision + Reject Decision buttons`);
  console.log(`    3. Both show run ID, project, and summary text`);

  console.log(`\n=== Boundary 11: ${allPassed ? 'PASS (pending visual confirmation)' : 'FAIL'} ===`);
  if (!allPassed) process.exit(1);
}

main().catch((err) => {
  console.error('Unhandled error:', err);
  process.exit(1);
});
