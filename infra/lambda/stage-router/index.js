/**
 * Placeholder Lambda handler for pipeline stage router.
 *
 * This stub is required by CDK Code.fromAsset() during synthesis.
 * The actual handler implementation lives in src/cloud/pipeline/stage-router.ts
 * and will be bundled and deployed in a later phase.
 */
exports.handler = async (event) => {
  console.log('Stage router invoked', JSON.stringify(event));
  return { statusCode: 200, body: 'placeholder' };
};
