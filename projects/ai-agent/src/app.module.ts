import { Module } from '@nestjs/common';
import { DbReplicaModule } from '~/db-replica/db-replica.module';
import { StatusModule } from '~/status/status.module';

@Module({ imports: [StatusModule, DbReplicaModule] })
export class AppModule {}
