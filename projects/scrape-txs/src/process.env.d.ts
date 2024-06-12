declare namespace NodeJS {
  export interface ProcessEnv {
    readonly DATABASE_URL: string;
    readonly BANK_KEY: 'bancoIndustrialGt' | 'bacGt';
  }
}
