import * as aws from '@pulumi/aws';

const webApiImageRepo = new aws.ecr.Repository('web-api-image-repo');

export const imageRepos = {
  webApi: {
    url: webApiImageRepo.repositoryUrl,
    registryId: webApiImageRepo.registryId,
  },
};
