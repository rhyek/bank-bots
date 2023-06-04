import * as aws from '@pulumi/aws';

const appRunnerInstanceRole = new aws.iam.Role('webApiAppRunnerInstanceRole', {
  assumeRolePolicy: aws.iam.assumeRolePolicyForPrincipal({
    Service: 'tasks.apprunner.amazonaws.com',
  }),
});

new aws.iam.RolePolicyAttachment('webApiAppRunnerInstanceAttachment', {
  policyArn: aws.iam.ManagedPolicy.AWSAppRunnerServicePolicyForECRAccess,
  role: appRunnerInstanceRole.name,
});

const appRunner = new aws.apprunner.Service('webApiAppRunner', {
  serviceName: 'web-api',
  sourceConfiguration: {
    imageRepository: {
      imageIdentifier: process.env.IMAGE_URI!,
      imageRepositoryType: 'ECR',
    },
  },
  instanceConfiguration: {
    cpu: '512',
    memory: '1GB',
    instanceRoleArn: appRunnerInstanceRole.arn,
  },
});

export const serviceUrl = appRunner.serviceUrl;
