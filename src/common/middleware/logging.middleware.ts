import { Injectable, Logger, NestMiddleware } from '@nestjs/common';
import { Request, Response, NextFunction } from 'express';
import { randomUUID } from 'crypto';

/**
 * ✅ P1: Request logging middleware.
 * Logs every HTTP request with: requestId, method, url, statusCode,
 * duration, ip, userAgent. Structured JSON for Railway log search.
 *
 * Skips: health check endpoint (would spam logs)
 */
@Injectable()
export class LoggingMiddleware implements NestMiddleware {
  private readonly logger = new Logger('HTTP');

  use(req: Request, res: Response, next: NextFunction): void {
    // Skip health check to avoid log spam
    if (req.url === '/api/v1/health') {
      next();
      return;
    }

    const requestId = randomUUID();
    const startTime = Date.now();

    // Attach requestId to request for downstream use
    (req as any).requestId = requestId;
    res.setHeader('X-Request-Id', requestId);

    res.on('finish', () => {
      const duration = Date.now() - startTime;
      const { method, url } = req;
      const { statusCode } = res;
      const ip =
        (req.headers['x-forwarded-for'] as string)?.split(',')[0]?.trim() ||
        req.ip ||
        'unknown';
      const userAgent = req.headers['user-agent'] || 'unknown';
      const userId = (req as any).user?.id || 'anonymous';

      const logData = {
        requestId,
        method,
        url,
        statusCode,
        duration: `${duration}ms`,
        ip,
        userId,
        userAgent: userAgent.slice(0, 100), // truncate to avoid giant logs
      };

      if (statusCode >= 500) {
        this.logger.error(JSON.stringify(logData));
      } else if (statusCode >= 400) {
        this.logger.warn(JSON.stringify(logData));
      } else {
        this.logger.log(JSON.stringify(logData));
      }
    });

    next();
  }
}
