import { Module } from '@nestjs/common';
import { MAIL_PORT } from '@fenwick/shared';
import { ENV, type Env } from '../../config/env.js';
import { ConsoleMailAdapter } from './console-mail.adapter.js';
import { SmtpMailAdapter } from './smtp-mail.adapter.js';

/**
 * MAIL_DRIVER=postmark is not bound yet: the provider account is not
 * provisioned, and a half-written provider adapter is worse than none. The
 * environment schema rejects `postmark` without a server token, so the gap is
 * visible at boot rather than at send time.
 */
@Module({
  providers: [
    SmtpMailAdapter,
    ConsoleMailAdapter,
    {
      provide: MAIL_PORT,
      inject: [ENV, SmtpMailAdapter, ConsoleMailAdapter],
      useFactory: (env: Env, smtp: SmtpMailAdapter, console_: ConsoleMailAdapter) =>
        env.MAIL_DRIVER === 'smtp' ? smtp : console_,
    },
  ],
  exports: [MAIL_PORT, SmtpMailAdapter, ConsoleMailAdapter],
})
export class MailModule {}
