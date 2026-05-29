/**
 * WhatsAppService — outbound queueing + phone normalisation contract.
 *
 * What this spec locks in
 * -----------------------
 *   1. Static phone normaliser produces digits-only E.164 for every
 *      input shape we documented in the JSDoc + null for un-fixable
 *      inputs. This is the wire-level contract Meta enforces (any
 *      malformed `to` is rejected at the API edge).
 *
 *   2. `sendTemplate` short-circuits when the provider reports
 *      `isConfigured() === false` — NO Bull job is queued, NO error
 *      is thrown. This is the behaviour that lets Phase 1 ship to
 *      prod before the WABA credentials are provisioned.
 *
 *   3. `sendTemplate` queues a Bull job with the EXACT shape the
 *      processor consumes:
 *        kind='template', to=<E.164>, template={ name, language,
 *        vars[], buttons[{ payload }] }
 *      Every {{N}} placeholder + every quick-reply button we ship
 *      lives or dies by this shape — a regression here breaks every
 *      booking-flow notification at once.
 *
 *   4. Button mismatch (template registered with N buttons, caller
 *      passes M ≠ N suffixes) is rejected by the service WITHOUT
 *      queueing, so a misconfigured call site fails fast in dev
 *      instead of getting silently dropped at the Meta API edge.
 *
 *   5. The static normaliser runs BEFORE the queue. The job payload
 *      always carries digits-only E.164 — no provider should ever
 *      have to re-normalise.
 */
import { WhatsAppService } from './whatsapp.service';
import { CHEF_BOOKING_REQUEST, CUSTOMER_BOOKING_REJECTED } from './templates';
import {
  WHATSAPP_PROVIDER,
  WhatsAppProvider,
} from './providers/whatsapp.provider.interface';

function makeService(opts: {
  isConfigured?: boolean;
  defaultCountryCode?: string;
} = {}) {
  const provider: WhatsAppProvider = {
    isConfigured: jest.fn(() => opts.isConfigured ?? true),
    send: jest.fn(),
    verifySignature: jest.fn(() => false),
    verifyChallenge: jest.fn(() => null),
    parseInbound: jest.fn(() => []),
  };

  const queue: any = {
    add: jest.fn(async () => ({ id: 'job-1' })),
  };

  const config: any = {
    get: jest.fn((key: string) =>
      key === 'WHATSAPP_DEFAULT_COUNTRY_CODE'
        ? opts.defaultCountryCode ?? '91'
        : undefined,
    ),
  };

  // The constructor signature uses @Inject + @InjectQueue decorators;
  // when we instantiate manually we just hand the deps in positional
  // order. No metadata reflection happens because we're not going
  // through Nest's DI here.
  const svc = new WhatsAppService(provider, queue, config);
  return { svc, provider, queue };
}

describe('WhatsAppService.normalizePhoneE164 (static)', () => {
  it.each<[string, string]>([
    ['+919876543210', '919876543210'],
    ['919876543210', '919876543210'],
    [' 91 98765 43210', '919876543210'],
    ['+91 (98765) 43210', '919876543210'],
    ['9876543210', '919876543210'],
    ['09876543210', '919876543210'],
    ['00919876543210', '919876543210'],
    ['+1-415-867-5309', '14158675309'], // US 11-digit also works
  ])('"%s" → "%s"', (input, expected) => {
    expect(WhatsAppService.normalizePhoneE164(input)).toBe(expected);
  });

  it.each<string>([
    '',
    'abc',
    '12345',          // too short (< 10 digits after stripping)
    '0', '+',
    '00',
  ])('rejects un-fixable input %j', (raw) => {
    expect(WhatsAppService.normalizePhoneE164(raw)).toBeNull();
  });

  it('honours a non-default country code argument', () => {
    expect(WhatsAppService.normalizePhoneE164('1234567890', '44')).toBe(
      '441234567890',
    );
  });

  it('returns null for null / undefined input', () => {
    expect(WhatsAppService.normalizePhoneE164(null)).toBeNull();
    expect(WhatsAppService.normalizePhoneE164(undefined)).toBeNull();
  });
});

describe('WhatsAppService.sendTemplate', () => {
  const baseOpts = {
    to: '+919876543210',
    template: CHEF_BOOKING_REQUEST,
    vars: [
      'Chef Anjali',
      'Riya',
      'ABC12345',
      'Saturday, June 15, 2026',
      '07:30 PM',
      'Flat 4B, Sky Heights',
      '1,234',
    ],
    buttonSuffixes: ['booking-uuid-1', 'booking-uuid-1'],
  };

  it('queues a Bull job with the exact shape the processor consumes', async () => {
    const { svc, queue } = makeService({});
    const queued = await svc.sendTemplate(baseOpts);
    expect(queued).toBe(true);

    expect(queue.add).toHaveBeenCalledTimes(1);
    const [jobName, jobData, jobOpts] = queue.add.mock.calls[0];
    expect(jobName).toBe('send-message');
    expect(jobData).toEqual({
      kind: 'template',
      to: '919876543210', // normalised
      template: {
        name: 'chef_booking_request',
        language: 'en',
        vars: baseOpts.vars,
        buttons: [
          { payload: 'APPROVE_booking-uuid-1' },
          { payload: 'REJECT_booking-uuid-1' },
        ],
      },
      correlationId: undefined,
    });
    // Bull retry config matches the email queue exactly so SLA is
    // consistent across channels.
    expect(jobOpts).toMatchObject({
      attempts: 3,
      backoff: { type: 'exponential', delay: 5000 },
    });
  });

  it('forwards correlationId onto the job payload', async () => {
    const { svc, queue } = makeService({});
    await svc.sendTemplate({
      ...baseOpts,
      correlationId: 'booking-uuid-1',
    });
    expect(queue.add.mock.calls[0][1].correlationId).toBe('booking-uuid-1');
  });

  it('short-circuits (returns false, NO queue interaction) when provider is unconfigured', async () => {
    const { svc, queue } = makeService({ isConfigured: false });
    const result = await svc.sendTemplate(baseOpts);
    expect(result).toBe(false);
    expect(queue.add).not.toHaveBeenCalled();
  });

  it('rejects (returns false, NO queue interaction) when phone cannot be normalised', async () => {
    const { svc, queue } = makeService({});
    const result = await svc.sendTemplate({ ...baseOpts, to: 'not-a-phone' });
    expect(result).toBe(false);
    expect(queue.add).not.toHaveBeenCalled();
  });

  it('rejects when buttonSuffixes count does not match template buttons', async () => {
    const { svc, queue } = makeService({});
    // CHEF_BOOKING_REQUEST has 2 buttons; pass only 1 suffix.
    const result = await svc.sendTemplate({
      ...baseOpts,
      buttonSuffixes: ['booking-uuid-1'],
    });
    expect(result).toBe(false);
    expect(queue.add).not.toHaveBeenCalled();
  });

  it('rejects when template has no buttons but caller passes suffixes', async () => {
    const { svc, queue } = makeService({});
    const result = await svc.sendTemplate({
      to: '919876543210',
      template: CUSTOMER_BOOKING_REJECTED, // no buttons
      vars: ['Riya', 'Chef Anjali'],
      buttonSuffixes: ['stray-suffix'],
    });
    expect(result).toBe(false);
    expect(queue.add).not.toHaveBeenCalled();
  });

  it('omits the buttons array entirely for templates without buttons', async () => {
    const { svc, queue } = makeService({});
    const result = await svc.sendTemplate({
      to: '919876543210',
      template: CUSTOMER_BOOKING_REJECTED,
      vars: ['Riya', 'Chef Anjali'],
    });
    expect(result).toBe(true);
    expect(queue.add.mock.calls[0][1].template.buttons).toBeUndefined();
  });

  it('still queues even when var count mismatches the template (Meta is the source of truth)', async () => {
    const { svc, queue } = makeService({});
    // 1 var supplied; CUSTOMER_BOOKING_REJECTED expects 2.
    // We log a warning but don't block — the source of truth is the
    // registered Meta template, which may legitimately diverge from
    // our docs while a copy update is in review.
    const result = await svc.sendTemplate({
      to: '919876543210',
      template: CUSTOMER_BOOKING_REJECTED,
      vars: ['Only one'],
    });
    expect(result).toBe(true);
    expect(queue.add).toHaveBeenCalledTimes(1);
  });
});

describe('WhatsAppService.sendText', () => {
  it('queues a text job in the canonical shape', async () => {
    const { svc, queue } = makeService({});
    const result = await svc.sendText('+919876543210', 'Hello there', 'corr-1');
    expect(result).toBe(true);
    const [jobName, jobData] = queue.add.mock.calls[0];
    expect(jobName).toBe('send-message');
    expect(jobData).toEqual({
      kind: 'text',
      to: '919876543210',
      body: 'Hello there',
      correlationId: 'corr-1',
    });
  });

  it('short-circuits when unconfigured', async () => {
    const { svc, queue } = makeService({ isConfigured: false });
    const result = await svc.sendText('+919876543210', 'Hello');
    expect(result).toBe(false);
    expect(queue.add).not.toHaveBeenCalled();
  });

  it('rejects on empty body or invalid phone', async () => {
    const { svc, queue } = makeService({});
    expect(await svc.sendText('+919876543210', '')).toBe(false);
    expect(await svc.sendText('not-a-phone', 'hello')).toBe(false);
    expect(queue.add).not.toHaveBeenCalled();
  });
});

describe('WhatsAppService — webhook delegation', () => {
  it('delegates verifySignature / verifyChallenge / parseInbound to the provider', () => {
    const { svc, provider } = makeService({});
    const buf = Buffer.from('{}');

    svc.verifySignature(buf, 'sha256=abc');
    expect(provider.verifySignature).toHaveBeenCalledWith(buf, 'sha256=abc');

    svc.verifyChallenge({ 'hub.mode': 'subscribe' });
    expect(provider.verifyChallenge).toHaveBeenCalled();

    svc.parseInbound({});
    expect(provider.parseInbound).toHaveBeenCalled();
  });
});

// Silence the WhatsAppService logger output so jest --verbose reports
// don't fill with the expected warning lines from the no-op cases.
beforeAll(() => {
  jest.spyOn(console, 'warn').mockImplementation(() => undefined);
  jest.spyOn(console, 'log').mockImplementation(() => undefined);
});
afterAll(() => {
  jest.restoreAllMocks();
});

// Suppress unused-import warning for WHATSAPP_PROVIDER which is
// referenced in the typing of the fake provider's mock signature.
void WHATSAPP_PROVIDER;
