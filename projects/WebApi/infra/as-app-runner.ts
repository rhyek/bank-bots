import * as aws from '@pulumi/aws';

const appRunnerEcrRole = new aws.iam.Role('webApiAppRunnerEcrRole', {
  assumeRolePolicy: aws.iam.assumeRolePolicyForPrincipal({
    Service: 'build.apprunner.amazonaws.com',
  }),
});

new aws.iam.RolePolicyAttachment('webApiAppRunnerEcrRoleAttachment', {
  policyArn: aws.iam.ManagedPolicy.AWSAppRunnerServicePolicyForECRAccess,
  role: appRunnerEcrRole.name,
});

const appRunner = new aws.apprunner.Service('webApiAppRunner', {
  serviceName: 'web-api',
  sourceConfiguration: {
    imageRepository: {
      imageIdentifier: process.env.IMAGE_URI!,
      imageRepositoryType: 'ECR',
    },
    authenticationConfiguration: {
      accessRoleArn: appRunnerEcrRole.arn,
    },
    autoDeploymentsEnabled: false,
  },
  instanceConfiguration: {
    cpu: '512',
    memory: '1 GB',
  },
});

export const serviceUrl = appRunner.serviceUrl;
