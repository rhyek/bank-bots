import * as aws from '@pulumi/aws';
import * as pulumi from '@pulumi/pulumi';
import * as awsx from '@pulumi/awsx';

const defaultSubnet = new aws.ec2.DefaultSubnet('defaultSubnet', {
  availabilityZone: 'us-east-1a',
});

const ecsSecurityGroup = new aws.ec2.SecurityGroup('ecsSecurityGroup', {
  vpcId: awsx.classic.ec2.Vpc.getDefault().id,
  ingress: [
    // for ssh
    {
      protocol: 'tcp',
      fromPort: 22,
      toPort: 22,
      cidrBlocks: ['0.0.0.0/0'],
    },
  ],
  // needed so that the ec2 instance can register on the ecs cluster
  egress: [
    {
      protocol: '-1', // Represents all protocols.
      fromPort: 0, // Represents all ports.
      toPort: 0, // Represents all ports.
      cidrBlocks: ['0.0.0.0/0'],
    },
  ],
});

const ecsCluster = new aws.ecs.Cluster('ecsCluster', {});

const ec2InstanceRole = new aws.iam.Role('ec2InstanceRole', {
  assumeRolePolicy: aws.iam.assumeRolePolicyForPrincipal({
    Service: 'ec2.amazonaws.com',
  }),
});
new aws.iam.RolePolicyAttachment('ecsContainerInstanceRolePolicyAttachment', {
  role: ec2InstanceRole,
  policyArn: aws.iam.ManagedPolicy.AmazonEC2ContainerServiceforEC2Role,
});
const ecsInstanceProfile = new aws.iam.InstanceProfile('ecsInstanceProfile', {
  role: ec2InstanceRole.name,
});

// https://docs.aws.amazon.com/AmazonECS/latest/developerguide/retrieve-ecs-optimized_AMI.html
const ecsOptimizedAmi = pulumi
  .output(
    aws.ssm.getParameter({
      name: '/aws/service/ecs/optimized-ami/amazon-linux-2/kernel-5.10/arm64/recommended',
    })
  )
  .apply((result) => JSON.parse(result.value).image_id);

// for ssh
const keyPair = new aws.ec2.KeyPair('ec2KeyPair', {
  publicKey:
    'ssh-rsa AAAAB3NzaC1yc2EAAAADAQABAAACAQDBSEIHml0lrwkT0yEumITf0vItV1W0UmwEXhZ7fhV8Nxh75f1O0L11L6viygIAuECOYhyPwp4z/e7MmKv0MEHEmg2aS2cvRzodgULLpl9gl9U4lzAWJzvApOwOhUDzRfoRI93XEYlXYysZpbNujYhtQ7DyRep8ZJU0RrkM40aDScAnji4KCnNnr8goA6uAHfPuIwqsTBdBnDhd8+4iJmPf81x/K7aE3o52By3o60sS141H2VQ4SEWpUbNa6uMaciPgizB+ASdg8VLW0tOfX8MvsfgQJBWM6iYWOdP9uUP6t5IrY6KmoUnYM6KIoFDn91WI6oqN02VEDOfYLjODdiCdKdPLqqTWk42UaGZkNwRq1XOEhsk7/Tw1O655IZhXDr5T6I1ov5tTzrlt280TO+pU8V3VXlE6n+dOfb6FXijQbw2aZbK0PksqMm5pu98eKApsKM2HMw0flL70KGHtnFDpHzPxAwlTwi8uB0XLuMJoGjROyUYhxEF70srRBF4SBYb8eFAKFcgM/9kjAGxoeI34V9+e33rBW6JL6cBCj6qU6MDTfLAf2sRIXkEv1BP2vSQCF8qZ/zRlDpzYyGXCnfMFQ1WsCyQbidpuqc9E5E5LGhWSJ1xr/SC2wmdqJAhkAMH6DZu51/pYUFhWXXT1a2KRqDbI8/afJqBCskvLbz4ssw== carlos@macbook',
});

new aws.ec2.Instance('ecsEc2Compute', {
  ami: ecsOptimizedAmi,
  instanceType: 't4g.micro',
  iamInstanceProfile: ecsInstanceProfile.name,
  vpcSecurityGroupIds: [ecsSecurityGroup.id], // use VPC's default security group
  subnetId: defaultSubnet.id,
  keyName: keyPair.keyName,
  userData: pulumi.interpolate`#!/bin/bash
echo ECS_CLUSTER=${ecsCluster.name} >> /etc/ecs/ecs.config`,
});

const appLogGroup = new aws.cloudwatch.LogGroup('appLogGroup', {});

export const vpcId = awsx.classic.ec2.Vpc.getDefault().id;
export const ecsClusterId = ecsCluster.id;
export const appLogGroupName = appLogGroup.name;
export const ecsSecurityGroupId = ecsSecurityGroup.id;
