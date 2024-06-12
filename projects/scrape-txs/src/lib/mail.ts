import { createTransport } from 'nodemailer';

export const mailer = createTransport({
  service: 'gmail',
  auth: {
    user: process.env.MAILER_SMTP_ACCOUNT,
    pass: process.env.MAILER_SMTP_PASSWORD,
  },
});
