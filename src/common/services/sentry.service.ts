import { Injectable, Logger } from '@nestjs/common';
import * as Sentry from '@sentry/node';

/**
 * Sentry initialization + helpers for the backend.
 *
 * Init is fire-and-forget at module load (called from main.ts BEFORE NestFactory.create).
 * If SENTRY_DSN is unset, Sentry is a no-op — safe for local dev / CI.
 *
 * PII redaction:
 *  - Strips Authorization header
 *  - Redacts password / otp / token / refresh_token / razorpay_signature fields
 *    from request body, query, and headers before send.
 */
export function initSentry(): boolean {
  const dsn = process.env.SENTRY_DSN;
  if (!dsn) {
    new Logger('Sentry').log('SENTRY_DSN unset — error tracking disabled');
    return false;
  }

  Sentry.init({
    dsn,
    environment: process.env.NODE_ENV || 'development',
    release: process.env.APP_VERSION || '1.0.0',
    // 10% sampling on traces — bumpable via env
    tracesSampleRate: Number(process.env.SENTRY_TRACES_SAMPLE_RATE ?? 0.1),
    // Don't send events when dev mode runs without explicit opt-in
    enabled: process.env.NODE_ENV === 'production' || process.env.SENTRY_FORCE === 'true',
    beforeSend(event) {
      try {
        if (event.request) {
          // Strip auth header
          if (event.request.headers) {
            delete (event.request.headers as any)['authorization'];
            delete (event.request.headers as any)['Authorization'];
            delete (event.request.headers as any)['cookie'];
          }
          // Redact sensitive body fields
          event.request.data = redactSensitive(event.request.data);
          event.request.query_string = redactSensitive(event.request.query_string);
        }
        // Strip user PII other than id
        if (event.user) {
          event.user = { id: event.user.id };
        }
      } catch {
        // Never let beforeSend itself throw
      }
      return event;
    },
  });

  new Logger('Sentry').log(
    `Sentry initialized (env=${process.env.NODE_ENV}, traces=${
      process.env.SENTRY_TRACES_SAMPLE_RATE ?? 0.1
    })`,
  );
  return true;
}

const SENSITIVE_KEYS = new Set([
  'password',
  'new_password',
  'old_password',
  'otp',
  'access_token',
  'refresh_token',
  'token',
  'razorpay_signature',
  'razorpay_payment_id',
  'fcm_token',
  'aadhaar_number',
  'pan_number',
  'account_number',
]);

function redactSensitive(input: any): any {
  if (input == null) return input;
  if (typeof input === 'string') {
    // Best-effort: if the string is a query string, redact known keys
    return input.replace(
      /([?&])(password|otp|token|refresh_token|access_token)=[^&]*/gi,
      '$1$2=[REDACTED]',
    );
  }
  if (Array.isArray(input)) return input.map(redactSensitive);
  if (typeof input === 'object') {
    const cloned: Record<string, any> = {};
    for (const [k, v] of Object.entries(input)) {
      cloned[k] = SENSITIVE_KEYS.has(k.toLowerCase())
        ? '[REDACTED]'
        : redactSensitive(v);
    }
    return cloned;
  }
  return input;
}

@Injectable()
export class SentryService {
  captureException(err: unknown, ctx?: { userId?: string; requestId?: string; route?: string }) {
    Sentry.captureException(err, {
      tags: {
        route: ctx?.route ?? 'unknown',
        request_id: ctx?.requestId ?? 'unknown',
      },
      user: ctx?.userId ? { id: ctx.userId } : undefined,
    });
  }
}
