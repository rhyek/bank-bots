import * as aws from '@pulumi/aws';

const sqsQeneralQueue = new aws.sqs.Queue('generalQueue', {
  // 30 minutes
  visibilityTimeoutSeconds: 30 * 60,
});

export const sqsGeneralQueueUrl = sqsQeneralQueue.url;

export * from './basic-lambda-execution-role.js';
export * from './ecs-cluster.js';
export * from './image-repos.js';
