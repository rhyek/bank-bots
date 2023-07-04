import * as aws from '@pulumi/aws';
import * as awsx from '@pulumi/awsx';
import * as pulumi from '@pulumi/pulumi';

const infraStack = new pulumi.StackReference(
  `rhyek/bank-apis.infrastructure/${pulumi.getStack()}`
);

const ecsClusterName = infraStack.getOutput('ecsClusterName');
const ecsSubnetId = infraStack.getOutput('ecsSubnetId');

const ecsCluster = ecsClusterName.apply((n) =>
  aws.ecs.getCluster({ clusterName: n })
);

const alb = new awsx.lb.ApplicationLoadBalancer('appLoadBalancer', {});

pulumi.all([ecsCluster, ecsSubnetId]).apply(([ecsCluster, ecsSubnetId]) => {
  const taskDefinition = new aws.ecs.TaskDefinition('appTaskDef', {
    containerDefinitions: JSON.stringify([
      {
        name: 'my-app',
        image: process.env.IMAGE_URI,
        memory: 256,
        portMappings: [
          {
            targetGroup: alb.defaultTargetGroup,
          },
        ],
      },
    ]),
    family: 'appFamily',
    networkMode: 'awsvpc',
    requiresCompatibilities: ['EC2'],
  });

  const service = new aws.ecs.Service(
    'appSvc',
    {
      cluster: ecsCluster.id,
      desiredCount: 1,
      launchType: 'EC2',
      taskDefinition: taskDefinition.arn,
      waitForSteadyState: true,
      networkConfiguration: {
        subnets: [ecsSubnetId], // use a default subnet
      },
      // loadBalancers: [{
      //     targetGroupArn: "<-group-arn>", // replace with target group ARN
      //     containerName: "my-app",
      //     containerPort: 8080,
      // }],
    }
    // {
    //   dependsOn: [ec2Instance],
    // }
  );
});

export const appLoadBalancerUrl = alb.loadBalancer.dnsName;
