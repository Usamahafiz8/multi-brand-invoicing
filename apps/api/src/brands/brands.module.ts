import { Module } from '@nestjs/common';
import { BrandSettingsController } from './brand-settings.controller.js';
import { BrandSettingsService } from './brand-settings.service.js';
import { BrandsController } from './brands.controller.js';
import { BrandsService } from './brands.service.js';

@Module({
  controllers: [BrandsController, BrandSettingsController],
  providers: [BrandsService, BrandSettingsService],
  exports: [BrandSettingsService],
})
export class BrandsModule {}
