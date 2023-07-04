import * as aws from '@pulumi/aws';

const webApiImageRepo = new aws.ecr.Repository('web-api-image-repo');

const sqsQeneralQueue = new aws.sqs.Queue('generalQueue', {
  // 30 minutes
  visibilityTimeoutSeconds: 30 * 60,
});

export const sqsGeneralQueueUrl = sqsQeneralQueue.url;

export const imageRepos = {
  webApi: {
    url: webApiImageRepo.repositoryUrl,
    registryId: webApiImageRepo.registryId,
  },
};

export * from './ecs-cluster.js';
