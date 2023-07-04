import * as aws from '@pulumi/aws';
import * as pulumi from '@pulumi/pulumi';

const defaultVpc = new aws.ec2.DefaultVpc('defaultVpc');
const defaultSubnet = new aws.ec2.DefaultSubnet('defaultSubnet', {
  availabilityZone: 'us-east-1a',
});
const ecsCluster = new aws.ecs.Cluster('ecsCluster', {});
const ec2InstanceRole = new aws.iam.Role('ec2InstanceRole', {
  assumeRolePolicy: aws.iam.assumeRolePolicyForPrincipal({
    Service: 'ec2.amazonaws.com',
  }),
});
new aws.iam.RolePolicyAttachment('ecsInstanceRoleEC2PolicyAttachment', {
  role: ec2InstanceRole,
  policyArn: aws.iam.ManagedPolicy.AmazonEC2ContainerServiceforEC2Role,
});
let ecsOptimizedAmi = aws.ec2.getAmi({
  filters: [
    {
      name: 'architecture',
      values: ['arm64'],
    },
    {
      name: 'manifest-location',
      values: ['amazon/amzn2-ami-ecs-hvm-2.0.*-arm64-ebs'],
    },
  ],
  mostRecent: true,
  owners: ['amazon'],
});
const ecsInstanceProfile = new aws.iam.InstanceProfile('ecsInstanceProfile', {
  role: ec2InstanceRole.name,
});

new aws.ec2.Instance('ecsEc2Compute', {
  ami: ecsOptimizedAmi.then((ami) => ami.id), // replace with an appropriate AMI ID
  instanceType: 't4g.micro',
  iamInstanceProfile: ecsInstanceProfile.name,
  vpcSecurityGroupIds: [defaultVpc.defaultSecurityGroupId], // use VPC's default security group
  subnetId: defaultSubnet.id,
  userData: pulumi.interpolate`#!/bin/bash
echo ECS_CLUSTER=${ecsCluster.name} >> /etc/ecs/ecs.config`,
});

export const ecsClusterName = ecsCluster.name;
export const ecsSubnetId = defaultSubnet.id;
