import * as aws from '@pulumi/aws';
import * as awsx from '@pulumi/awsx';
import * as pulumi from '@pulumi/pulumi';

const awsRegion = new pulumi.Config('aws').require('region');

const infraStack = new pulumi.StackReference(
  `rhyek/bank-apis.infrastructure/${pulumi.getStack()}`
);

const vpcId = infraStack.getOutput('vpcId');
const ecsClusterId = infraStack.getOutput('ecsClusterId');
const appLogGroupName = infraStack.getOutput('appLogGroupName');
const ecsSecurityGroupId = infraStack.getOutput('ecsSecurityGroupId');

const albSecurityGroup = new aws.ec2.SecurityGroup('webApiAlbSecurityGroup', {
  vpcId,
  ingress: [
    // alb listener port
    {
      protocol: 'tcp',
      fromPort: 80,
      toPort: 80,
      cidrBlocks: ['0.0.0.0/0'],
    },
  ],
  egress: [
    {
      protocol: '-1', // Represents all protocols.
      fromPort: 0, // Represents all ports.
      toPort: 0, // Represents all ports.
      securityGroups: [ecsSecurityGroupId],
    },
  ],
});

new aws.ec2.SecurityGroupRule('webApiAlbToEcsSecurityGroupRule', {
  securityGroupId: ecsSecurityGroupId,
  type: 'ingress',
  protocol: '-1',
  fromPort: 0,
  toPort: 0,
  sourceSecurityGroupId: albSecurityGroup.id,
});

const alb = new awsx.lb.ApplicationLoadBalancer('webApiAppLoadBalancer', {
  internal: false,
  // securityGroups: [ecsSecurityGroupId],
  listener: {
    port: 80,
  },
  securityGroups: [albSecurityGroup.id],
  defaultTargetGroup: {
    targetType: 'instance',
    healthCheck: {
      enabled: true,
      path: '/_health',
      port: 'traffic-port',
      protocol: 'HTTP',
      interval: 5,
      timeout: 2,
      healthyThreshold: 2,
      unhealthyThreshold: 3,
    },
  },
});

const taskDefinition = new aws.ecs.TaskDefinition('webApiAppTaskDef', {
  containerDefinitions: pulumi.jsonStringify([
    {
      name: 'web-api',
      image: process.env.IMAGE_URI,
      memory: 256,
      logConfiguration: {
        logDriver: 'awslogs',
        options: {
          'awslogs-group': appLogGroupName,
          'awslogs-region': awsRegion,
          'awslogs-stream-prefix': 'ecs',
        },
      },
      portMappings: [
        {
          // hostPort: 80, // use dynamic ports
          containerPort: 3000,
          protocol: 'tcp',
        },
      ],
    },
  ]),
  family: 'appFamily',
  // https://docs.aws.amazon.com/AmazonECS/latest/bestpracticesguide/networking-networkmode.html
  // keeping it simple.
  networkMode: 'bridge',
  requiresCompatibilities: ['EC2'],
});

const service = new aws.ecs.Service('webApiAppSvc', {
  cluster: ecsClusterId,
  desiredCount: 1,
  launchType: 'EC2',
  taskDefinition: taskDefinition.arn,
  waitForSteadyState: true,
  loadBalancers: [
    {
      targetGroupArn: alb.defaultTargetGroup.arn,
      containerName: 'web-api',
      containerPort: 3000,
    },
  ],
});

export const appLoadBalancerUrl = alb.loadBalancer.dnsName;
