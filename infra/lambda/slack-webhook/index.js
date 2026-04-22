/**
 * Placeholder Lambda handler for Slack webhook.
 *
 * This stub is required by CDK Code.fromAsset() during synthesis.
 * The actual handler implementation lives in src/cloud/webhook/slack-handler.ts
 * and will be bundled and deployed in a later phase.
 */
exports.handler = async (event) => {
  console.log('Slack webhook invoked', JSON.stringify(event));
  return { statusCode: 200, body: 'placeholder' };
};
