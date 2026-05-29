/**
 * WhatsAppWebhookController — HTTP boundary contract.
 *
 * What this spec locks in
 * -----------------------
 *
 *   1. POST /webhooks/whatsapp throws 401 BEFORE invoking the routing
 *      service when the X-Hub-Signature-256 HMAC fails. This is the
 *      auth boundary for the entire webhook surface — every other
 *      protection (chef-by-phone, idempotency, state guards) is
 *      defence in depth, but signature is the firewall. A regression
 *      here lets anyone on the internet flip any chef's bookings.
 *
 *   2. POST returns 200 { ok: true } on a verified signature, even
 *      when the routing service does nothing (status events, unknown
 *      button payloads, etc.). Meta retries on any non-2xx, and we
 *      never want them to retry a state-mutating webhook.
 *
 *   3. POST passes the parsed body to the routing service. (The
 *      RAW body is used only for signature verification; routing
 *      uses the parsed object.)
 *
 *   4. GET /webhooks/whatsapp echoes the challenge string back as
 *      `text/plain` with status 200 when the verify token matches.
 *      This is the only response shape Meta accepts during the
 *      subscription handshake — a wrapped { success, data } would
 *      fail verification.
 *
 *   5. GET returns 403 (no body) when the verify token doesn't match,
 *      or any other shape Meta might send.
 *
 * Construction
 * ────────────
 * We instantiate the controller manually rather than booting a
 * TestingModule so the tests stay fast and don't pull in BullModule,
 * TypeORM, Redis, etc. The controller is thin enough that direct
 * instantiation covers every meaningful branch.
 */
import { UnauthorizedException } from '@nestjs/common';
import type { Request, Response } from 'express';
import { WhatsAppWebhookController } from './whatsapp-webhook.controller';

interface ControllerFixture {
  controller: WhatsAppWebhookController;
  whatsappVerifySig: jest.Mock;
  whatsappVerifyChall: jest.Mock;
  webhookHandle: jest.Mock;
}

function makeController(opts: {
  signatureValid?: boolean;
  challenge?: string | null;
} = {}): ControllerFixture {
  const whatsappVerifySig = jest.fn(() => opts.signatureValid ?? true);
  const whatsappVerifyChall = jest.fn(() => opts.challenge ?? null);
  const whatsapp: any = {
    verifySignature: whatsappVerifySig,
    verifyChallenge: whatsappVerifyChall,
    parseInbound: jest.fn(),
    sendTemplate: jest.fn(),
    sendText: jest.fn(),
    isConfigured: jest.fn(),
  };

  const webhookHandle = jest.fn(async () => undefined);
  const webhookService: any = { handle: webhookHandle };

  const controller = new WhatsAppWebhookController(whatsapp, webhookService);
  return { controller, whatsappVerifySig, whatsappVerifyChall, webhookHandle };
}

function fakeReq(rawBody: Buffer | undefined): any {
  return { rawBody };
}

function fakeRes(): Response & {
  _status: number;
  _type: string | null;
  _body: any;
} {
  const r: any = {
    _status: 0,
    _type: null,
    _body: undefined,
    status(code: number) {
      this._status = code;
      return this;
    },
    type(t: string) {
      this._type = t;
      return this;
    },
    send(body?: any) {
      this._body = body;
      return this;
    },
  };
  return r as Response & { _status: number; _type: string | null; _body: any };
}

describe('WhatsAppWebhookController — POST signature gate', () => {
  it('throws Unauthorized on bad signature WITHOUT invoking the routing service', async () => {
    const f = makeController({ signatureValid: false });

    await expect(
      f.controller.receive(
        fakeReq(Buffer.from('{}')),
        { object: 'whatsapp_business_account' },
        'sha256=deadbeef',
      ),
    ).rejects.toBeInstanceOf(UnauthorizedException);

    expect(f.webhookHandle).not.toHaveBeenCalled();
    expect(f.whatsappVerifySig).toHaveBeenCalledTimes(1);
  });

  it('throws Unauthorized when no signature header is present', async () => {
    // Provider's verifySignature returns false for a missing sig — this
    // test additionally verifies the controller does NOT short-circuit
    // around it (e.g. by treating undefined as "trusted").
    const f = makeController({ signatureValid: false });

    await expect(
      f.controller.receive(
        fakeReq(Buffer.from('{}')),
        {},
        undefined,
      ),
    ).rejects.toBeInstanceOf(UnauthorizedException);
    expect(f.webhookHandle).not.toHaveBeenCalled();
  });

  it('passes the rawBody (NOT JSON.stringify(body)) to verifySignature', async () => {
    const f = makeController({ signatureValid: true });
    const raw = Buffer.from('{"object":"whatsapp_business_account"}');

    await f.controller.receive(
      fakeReq(raw),
      { object: 'whatsapp_business_account' },
      'sha256=abc',
    );

    expect(f.whatsappVerifySig).toHaveBeenCalledWith(raw, 'sha256=abc');
  });

  it('returns { ok: true } on verified signature, after passing the parsed body to the routing service', async () => {
    const f = makeController({ signatureValid: true });
    const parsed = { object: 'whatsapp_business_account', entry: [] };

    const result = await f.controller.receive(
      fakeReq(Buffer.from(JSON.stringify(parsed))),
      parsed,
      'sha256=abc',
    );

    expect(result).toEqual({ ok: true });
    expect(f.webhookHandle).toHaveBeenCalledWith(parsed);
  });

  it('still returns { ok: true } when routing service does nothing (no events of interest)', async () => {
    const f = makeController({ signatureValid: true });
    f.webhookHandle.mockResolvedValue(undefined);

    const result = await f.controller.receive(
      fakeReq(Buffer.from('{}')),
      {},
      'sha256=abc',
    );

    expect(result).toEqual({ ok: true });
  });
});

describe('WhatsAppWebhookController — GET subscription handshake', () => {
  it('echoes the challenge as text/plain 200 on a valid handshake', () => {
    const f = makeController({ challenge: 'echo-me-back' });
    const res = fakeRes();

    f.controller.verifyChallenge(
      {
        'hub.mode': 'subscribe',
        'hub.verify_token': 'whatever',
        'hub.challenge': 'echo-me-back',
      },
      res,
    );

    expect(res._status).toBe(200);
    expect(res._type).toBe('text/plain');
    expect(res._body).toBe('echo-me-back');
  });

  it('returns 403 with no body on token mismatch / wrong mode', () => {
    const f = makeController({ challenge: null });
    const res = fakeRes();

    f.controller.verifyChallenge(
      {
        'hub.mode': 'subscribe',
        'hub.verify_token': 'wrong',
        'hub.challenge': 'x',
      },
      res,
    );

    expect(res._status).toBe(403);
    expect(res._body).toBeUndefined();
    expect(f.whatsappVerifyChall).toHaveBeenCalled();
  });
});
