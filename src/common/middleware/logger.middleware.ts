import { Injectable, NestMiddleware, Logger } from '@nestjs/common';
import { Request, Response, NextFunction } from 'express';
import { randomUUID } from 'crypto';

/**
 * Structured per-request logging middleware.
 * Logs method, path, status, duration, IP, and request ID.
 * Skips health check and static asset requests to reduce noise.
 */
@Injectable()
export class LoggerMiddleware implements NestMiddleware {
  private readonly logger = new Logger('HTTP');

  use(req: Request, res: Response, next: NextFunction): void {
    // Skip health checks to avoid log spam
    if (req.path === '/api/v1/health' || req.path === '/favicon.ico') {
      return next();
    }

    const requestId = (req.headers['x-request-id'] as string) || randomUUID();
    const startMs = Date.now();

    // Attach requestId to request for use in controllers/services
    (req as any).requestId = requestId;
    res.setHeader('X-Request-Id', requestId);

    // Log on response finish
    res.on('finish', () => {
      const duration = Date.now() - startMs;
      const { method, originalUrl } = req;
      const { statusCode } = res;

      // Sanitize: strip auth header from logs
      const ip =
        (req.headers['x-forwarded-for'] as string)?.split(',')[0]?.trim() ||
        req.socket.remoteAddress ||
        'unknown';

      const userAgent = req.headers['user-agent'] || '';
      const userId = (req as any).user?.id || '-';

      const level = statusCode >= 500 ? 'error' : statusCode >= 400 ? 'warn' : 'log';

      const message = JSON.stringify({
        requestId,
        method,
        path: originalUrl,
        status: statusCode,
        duration_ms: duration,
        ip,
        userId,
        userAgent: userAgent.substring(0, 100),
      });

      this.logger[level](message);
    });

    next();
  }
}
