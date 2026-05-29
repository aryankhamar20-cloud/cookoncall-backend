import {
  Body,
  Controller,
  Get,
  Headers,
  HttpCode,
  HttpStatus,
  Logger,
  Post,
  Query,
  RawBodyRequest,
  Req,
  Res,
  UnauthorizedException,
} from '@nestjs/common';
import type { Request, Response } from 'express';
import { Public } from '../../common/decorators/public.decorator';
import { WhatsAppService } from './whatsapp.service';
import { WhatsAppWebhookService } from './whatsapp-webhook.service';

/**
 * Inbound WhatsApp webhook endpoint.
 *
 * Endpoint URL (configured in Meta App → WhatsApp → Configuration):
 *   https://api.thecookoncall.com/api/v1/webhooks/whatsapp
 *
 * Two methods, both @Public (no JWT):
 *
 *   GET  — Meta's subscription handshake. Echoes `hub.challenge` back
 *          when `hub.verify_token` matches our env. Returns 403 on
 *          mismatch. Plain-text response (NOT wrapped by the global
 *          TransformInterceptor — Meta refuses anything that isn't
 *          the bare challenge string).
 *
 *   POST — Inbound message delivery. HMAC-verified against the
 *          X-Hub-Signature-256 header before any payload parsing.
 *          On signature failure we throw 401 — Meta will retry
 *          aggressively but we'd rather they retry than process a
 *          forged payload. Always returns 200 on success, even when
 *          the inbound event is unhandled (idempotency safety —
 *          Meta retries any non-2xx).
 */
@Controller('webhooks/whatsapp')
export class WhatsAppWebhookController {
  private readonly logger = new Logger(WhatsAppWebhookController.name);

  constructor(
    private readonly whatsapp: WhatsAppService,
    private readonly webhookService: WhatsAppWebhookService,
  ) {}

  @Public()
  @Get()
  verifyChallenge(
    @Query() query: Record<string, string | undefined>,
    @Res() res: Response,
  ): void {
    // The TransformInterceptor wraps any returned value in
    // { success, data }; Meta refuses anything that isn't the bare
    // challenge string. Use @Res() to bypass the interceptor entirely.
    const challenge = this.whatsapp.verifyChallenge(query);
    if (challenge) {
      res.status(200).type('text/plain').send(challenge);
      return;
    }
    res.status(403).send();
  }

  @Public()
  @Post()
  @HttpCode(HttpStatus.OK)
  async receive(
    @Req() req: RawBodyRequest<Request>,
    @Body() body: unknown,
    @Headers('x-hub-signature-256') signature: string | undefined,
  ): Promise<{ ok: true }> {
    // Signature MUST be checked against the EXACT bytes Meta sent —
    // JSON.stringify(body) does not reproduce them (key order,
    // whitespace, escaped chars). NestFactory was booted with
    // rawBody:true so req.rawBody is the unparsed Buffer.
    if (!this.whatsapp.verifySignature(req.rawBody, signature)) {
      // Refuse aggressively. Do NOT log the body — payloads from
      // an attacker probing for vulnerabilities should not make it
      // into our log retention.
      this.logger.warn('Refusing inbound WhatsApp webhook — bad signature');
      throw new UnauthorizedException();
    }

    // Always 200 from here on — even malformed payloads, even
    // unhandled event types. Meta retries on any non-2xx and we
    // never want to retry a state mutation just because a downstream
    // logger glitched.
    await this.webhookService.handle(body);
    return { ok: true };
  }
}
