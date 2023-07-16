import * as aws from '@pulumi/aws';

const lambdaRole = new aws.iam.Role('basicLambdaRole', {
  assumeRolePolicy: aws.iam.assumeRolePolicyForPrincipal(
    aws.iam.Principals.LambdaPrincipal
  ),
});
// managed policies: https://docs.aws.amazon.com/lambda/latest/dg/lambda-intro-execution-role.html
new aws.iam.RolePolicyAttachment('basicLambdaRolePolicyAttachment', {
  role: lambdaRole.name,
  policyArn: aws.iam.ManagedPolicy.AWSLambdaBasicExecutionRole,
});

export const basicLambdaRoleArn = lambdaRole.arn;
