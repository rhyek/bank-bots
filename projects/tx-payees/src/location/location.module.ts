import { Module } from '@nestjs/common';
import { DawarichClient } from '~/location/dawarich.client';
import { LocationService } from '~/location/location.service';

// The owner's location tracker (Dawarich) with its own local day cache. Knows nothing about
// transactions: it answers "what did the tracker record on these days", and owner-location decides
// how far to believe it.
@Module({
  providers: [DawarichClient, LocationService],
  exports: [LocationService],
})
export class LocationModule {}
