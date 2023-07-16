import * as pulumi from '@pulumi/pulumi';
import * as aws from '@pulumi/aws';
import * as awsx from '@pulumi/awsx';

const infraStack = new pulumi.StackReference(
  `rhyek/bank-apis.infrastructure/${pulumi.getStack()}`
);

const repository = (await infraStack.getOutputDetails('imageRepos')).value.bi
  .registerNewBiTxPushNotificationImageRepo;

const latestImage = await aws.ecr.getImage({
  repositoryName: repository.name,
  mostRecent: true,
});

const lambda = new aws.lambda.Function(
  'biRegisterNewBiTxPushNotificationLambda',
  {
    imageUri: `${repository.url}@${latestImage.imageDigest}`,
    role: infraStack.getOutput('basicLambdaRoleArn'),
    packageType: 'Image',
    architectures: ['arm64'],
    timeout: 10,
  }
);

const lambdaUrl = new aws.lambda.FunctionUrl(
  'biRegisterNewBiTxPushNotificationLambdaUrl',
  {
    functionName: lambda.name,
    authorizationType: 'NONE',
    cors: {
      allowCredentials: true,
      allowHeaders: ['X-Example-Header'],
      allowMethods: ['GET', 'POST'],
      allowOrigins: ['*'],
      exposeHeaders: ['X-Some-Header'],
      maxAge: 3600,
    },
  }
);

export const biRegisterNewBiTxPushNotificationFunctionUrl =
  lambdaUrl.functionUrl;
