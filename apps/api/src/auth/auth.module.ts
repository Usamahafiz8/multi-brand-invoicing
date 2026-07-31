import { Module } from '@nestjs/common';
import { AuthController } from './auth.controller.js';
import { AuthService } from './auth.service.js';

/**
 * SessionService is not provided here — TenancyModule is @Global and already
 * exports it, so the guard and this module share one instance rather than two
 * with divergent views of the same table.
 */
@Module({
  controllers: [AuthController],
  providers: [AuthService],
  exports: [AuthService],
})
export class AuthModule {}
