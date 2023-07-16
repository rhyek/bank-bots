import * as aws from '@pulumi/aws';

const webApiImageRepo = new aws.ecr.Repository('web-api-image-repo');
const biRegisterNewBiTxPushNotificationImageRepo = new aws.ecr.Repository(
  'bi-register-new-bi-tx-push-notification-image-repo'
);

export const imageRepos = {
  webApi: {
    url: webApiImageRepo.repositoryUrl,
    registryId: webApiImageRepo.registryId,
  },
  bi: {
    registerNewBiTxPushNotificationImageRepo: {
      name: biRegisterNewBiTxPushNotificationImageRepo.name,
      url: biRegisterNewBiTxPushNotificationImageRepo.repositoryUrl,
    },
  },
};
