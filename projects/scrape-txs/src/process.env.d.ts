declare namespace NodeJS {
  export interface ProcessEnv {
    readonly PORT?: string;
    readonly DATABASE_URL: string;
    readonly BANK_KEY?: 'bancoIndustrialGt' | 'bacGt' | 'bacCr';
    readonly MAILER_SMTP_ACCOUNT: string;
    readonly MAILER_SMTP_PASSWORD: string;
    readonly MAILER_ME: string;
    readonly BW_CLIENTID?: string;
    readonly BW_CLIENTSECRET?: string;
    readonly BW_PASSWORD?: string;
    readonly BITWARDENCLI_APPDATA_DIR?: string;
  }
}
