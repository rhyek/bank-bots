import { Module } from '@nestjs/common';
import { StatusController } from '~/status/status.controller';

@Module({ controllers: [StatusController] })
export class StatusModule {}
