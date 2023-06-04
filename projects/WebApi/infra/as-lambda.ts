import * as aws from '@pulumi/aws';

const lambdaRole = new aws.iam.Role('webApiLambdaRole', {
  assumeRolePolicy: aws.iam.assumeRolePolicyForPrincipal(
    aws.iam.Principals.LambdaPrincipal
  ),
});
// managed policies: https://docs.aws.amazon.com/lambda/latest/dg/lambda-intro-execution-role.html
new aws.iam.RolePolicyAttachment('webApiLambdaRolePolicyAttachment', {
  role: lambdaRole.name,
  policyArn: aws.iam.ManagedPolicy.AWSLambdaBasicExecutionRole,
});

const lambda = new aws.lambda.Function('webApiLambda', {
  imageUri: process.env.IMAGE_URI,
  role: lambdaRole.arn, // provide an IAM role for the Lambda function here
  packageType: 'Image',
  architectures: ['arm64'], // set the architecture you want to use
  timeout: 60,
});

const lambdaUrl = new aws.lambda.FunctionUrl('webApiLambdaUrl', {
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
});

export const functionUrl = lambdaUrl.functionUrl;
