import { Module } from '@nestjs/common';
import { TypeOrmModule } from '@nestjs/typeorm';
import { AreasController } from './areas.controller';
import { AreasService } from './areas.service';
import { ServiceArea, AreaRequest } from './area.entity';

@Module({
  imports: [TypeOrmModule.forFeature([ServiceArea, AreaRequest])],
  controllers: [AreasController],
  providers: [AreasService],
  exports: [AreasService],
})
export class AreasModule {}
