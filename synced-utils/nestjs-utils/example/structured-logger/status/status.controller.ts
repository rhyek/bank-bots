import { Body, Controller, Get, HttpStatus, Post } from '@nestjs/common';
import { StructuredLoggerService, setRequestContext } from '@rhyek/nestjs-utils';

// Widen the known-attribute set — the declaration-merging path, exercised for real.
declare module '@rhyek/nestjs-utils' {
  interface LogAttributes {
    orderId?: string;
  }
  interface RequestContextExtras {
    tenantId?: string;
  }
}

@Controller('status')
export class StatusController {
  constructor(private readonly logger: StructuredLoggerService) {}

  @Get('health')
  health() {
    this.logger.debug({ orderId: 'o_1' }, 'health check');
    return { status: 'ok' };
  }

  @Post('echo')
  echo(@Body() body: unknown) {
    setRequestContext({ tenantId: 't_42' });
    this.logger.info('echo received');
    this.logger.error({ error: new Error('demo failure') }, 'demo error line');
    return { received: body };
  }

  @Get('teapot')
  teapot() {
    throw this.logger.createError({}, 'teapot refused', {
      statusCode: HttpStatus.I_AM_A_TEAPOT,
      friendlyMessage: 'No coffee here',
    });
  }
}
