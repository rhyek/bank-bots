declare namespace NodeJS {
  export interface ProcessEnv {
    readonly DATABASE_URL: string;
    readonly BANK_KEY: 'bancoIndustrialGt' | 'bacGt';
    readonly MAILER_SMTP_ACCOUNT: string;
    readonly MAILER_SMTP_PASSWORD: string;
    readonly MAILER_ME: string;
    readonly PLAYWRIGHT_TRACES_S3_BUCKET_ID: string;
  }
}
