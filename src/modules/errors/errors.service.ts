import { Injectable } from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { Repository } from 'typeorm';
import { ErrorLog } from './error-log.entity';
import { CreateErrorLogDto } from './dto/create-error-log.dto';

@Injectable()
export class ErrorsService {
  constructor(
    @InjectRepository(ErrorLog)
    private errorLogsRepository: Repository<ErrorLog>,
  ) {}

  async create(dto: CreateErrorLogDto): Promise<{ id: string }> {
    const log = this.errorLogsRepository.create({
      message: dto.message?.slice(0, 2000) || 'Unknown error',
      stack: dto.stack?.slice(0, 10000) || null,
      component_stack: dto.component_stack?.slice(0, 5000) || null,
      url: dto.url?.slice(0, 2000) || null,
      user_agent: dto.user_agent?.slice(0, 500) || null,
      user_id: dto.user_id || null,
    });

    const saved = await this.errorLogsRepository.save(log);
    return { id: saved.id };
  }

  // Admin: get recent errors (up to 200)
  async getRecent(limit = 100): Promise<ErrorLog[]> {
    return this.errorLogsRepository.find({
      order: { created_at: 'DESC' },
      take: Math.min(limit, 200),
    });
  }
}
