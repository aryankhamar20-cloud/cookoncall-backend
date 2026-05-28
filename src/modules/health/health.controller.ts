import { Controller, Get } from '@nestjs/common';
import { InjectDataSource } from '@nestjs/typeorm';
import { DataSource } from 'typeorm';
import { Public } from '../../common/decorators/public.decorator';
import { ApiTags, ApiOperation } from '@nestjs/swagger';

@ApiTags('Health')
@Controller('health')
export class HealthController {
  private readonly startTime = Date.now();

  constructor(@InjectDataSource() private dataSource: DataSource) {}

  @Public()
  @Get()
  @ApiOperation({ summary: 'Health check — DB connectivity + uptime' })
  async check() {
    let dbStatus: 'ok' | 'error' = 'ok';
    let dbLatencyMs = 0;

    try {
      const t0 = Date.now();
      await this.dataSource.query('SELECT 1');
      dbLatencyMs = Date.now() - t0;
    } catch {
      dbStatus = 'error';
    }

    const uptimeMs = Date.now() - this.startTime;

    return {
      status: dbStatus === 'ok' ? 'ok' : 'degraded',
      timestamp: new Date().toISOString(),
      uptime_ms: uptimeMs,
      uptime_human: this.formatUptime(uptimeMs),
      version: process.env.npm_package_version || '1.0.0',
      environment: process.env.NODE_ENV || 'development',
      services: {
        database: {
          status: dbStatus,
          latency_ms: dbLatencyMs,
        },
      },
    };
  }

  private formatUptime(ms: number): string {
    const seconds = Math.floor(ms / 1000);
    const minutes = Math.floor(seconds / 60);
    const hours = Math.floor(minutes / 60);
    const days = Math.floor(hours / 24);

    if (days > 0) return `${days}d ${hours % 24}h`;
    if (hours > 0) return `${hours}h ${minutes % 60}m`;
    if (minutes > 0) return `${minutes}m ${seconds % 60}s`;
    return `${seconds}s`;
  }
}
