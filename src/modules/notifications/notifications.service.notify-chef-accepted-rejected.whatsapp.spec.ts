/**
 * NotificationsService.notifyChefAccepted / notifyChefRejected —
 * WhatsApp branch contract (Phase 4, May 29 2026).
 *
 * What this spec locks in
 * -----------------------
 *
 * notifyChefAccepted:
 *   1. Customer-side WhatsApp uses CUSTOMER_BOOKING_CONFIRMED with vars
 *      [customer_name, chef_name, date_str, time_str, booking_id_short]
 *      (matching templates.ts).
 *
 *   2. Chef-side WhatsApp uses CHEF_BOOKING_CONFIRMED with vars
 *      [chef_name, customer_name, date_str, time_str, booking_id_short].
 *      Sent regardless of which channel the chef accepted through —
 *      Phase 3 webhook taps don't auto-acknowledge in chat, so this
 *      template IS the visible "we got your accept" receipt.
 *
 *   3. Two independent gates: customer phone + customer
 *      whatsapp_enabled gates the customer send; chef phone + chef
 *      whatsapp_enabled gates the chef send. One channel failing /
 *      muting must NOT mute the other.
 *
 *   4. Send failure on either branch is fire-and-forget — booking
 *      flow stays intact. In-app + email completion is byte-identical
 *      to pre-Phase-4 even when WhatsApp throws.
 *
 *   5. whatsappDetails omitted entirely → no WhatsApp call. Legacy
 *      callers (none today, but the optional-arg shape is preserved
 *      for backward compatibility) get the existing in-app + email
 *      behaviour exactly.
 *
 * notifyChefRejected:
 *   1. Customer-side WhatsApp uses CUSTOMER_BOOKING_REJECTED with vars
 *      [customer_name, chef_name]. NO reason exposed (matches the
 *      admin-only `bookings.rejection_reason` contract).
 *
 *   2. Chef-side WhatsApp is intentionally NOT sent — the chef's
 *      decline tap (or web-app click) is its own confirmation.
 *      Sending another message saying "you declined" would clutter
 *      the thread.
 *
 *   3. Same gating + failure semantics as accept.
 *
 * Why these tests matter
 * ----------------------
 * The two notify helpers are the only Phase 4 surface; a regression
 * in either silently breaks the customer-facing confirmation/rejection
 * UX. The chef-side accept-confirmation also matters operationally —
 * without it, a chef who tapped Approve in WhatsApp would see their
 * own button tap and then NOTHING in the chat, and would have to
 * trust that the booking actually moved.
 */
import { NotificationsService } from './notifications.service';
import {
  CHEF_BOOKING_CONFIRMED,
  CUSTOMER_BOOKING_CONFIRMED,
  CUSTOMER_BOOKING_REJECTED,
} from '../whatsapp/templates';

interface ServiceFixture {
  service: NotificationsService;
  sendTemplateSpy: jest.Mock;
  sendDirectEmail: jest.SpyInstance;
  inAppRowCount: () => number;
}

function makeService(opts: {
  customerWhatsAppEnabled?: boolean;
  chefWhatsAppEnabled?: boolean;
  customerEmailEnabled?: boolean;
  sendTemplateImpl?: jest.Mock;
} = {}): ServiceFixture {
  const inAppRows: any[] = [];

  const notificationsRepo: any = {
    findOne: jest.fn(async () => null),
    create: jest.fn((row: any) => row),
    save: jest.fn(async (row: any) => {
      inAppRows.push(row);
      return row;
    }),
  };

  // Per-userId pref lookup. The notify helper makes two _channelAllowed
  // calls — one for customer (customerUserId), one for chef
  // (whatsappDetails.chefUserId). The mock returns different prefs
  // depending on which user is being asked about.
  const usersRepo: any = {
    findOne: jest.fn(async ({ where }: any) => {
      if (where.id === CUSTOMER_USER_ID) {
        return {
          id: CUSTOMER_USER_ID,
          email_enabled: opts.customerEmailEnabled ?? true,
          sms_enabled: true,
          push_enabled: true,
          whatsapp_enabled: opts.customerWhatsAppEnabled ?? true,
        };
      }
      if (where.id === CHEF_USER_ID) {
        return {
          id: CHEF_USER_ID,
          email_enabled: true,
          sms_enabled: true,
          push_enabled: true,
          whatsapp_enabled: opts.chefWhatsAppEnabled ?? true,
        };
      }
      return null;
    }),
  };

  const noopQueue: any = { add: jest.fn() };
  const config: any = { get: jest.fn(() => 'test-brevo-api-key') };
  const analytics: any = { track: jest.fn() };

  const sendTemplateSpy =
    opts.sendTemplateImpl ?? jest.fn(async () => true);
  const whatsapp: any = {
    sendTemplate: sendTemplateSpy,
    sendText: jest.fn(),
    isConfigured: jest.fn(() => true),
    verifySignature: jest.fn(),
    verifyChallenge: jest.fn(),
    parseInbound: jest.fn(),
  };

  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const fcm: any = { sendToToken: jest.fn(), sendToMultiple: jest.fn() };

  const service = new NotificationsService(
    notificationsRepo,
    usersRepo,
    noopQueue,
    noopQueue,
    config,
    analytics,
    whatsapp,
    // FcmService — push fan-out. Stubbed: these specs assert on the
    // in-app / email / WhatsApp branches, not on push delivery.
    fcm,
  );

  const sendDirectEmail = jest
    .spyOn(service, 'sendDirectEmail')
    .mockImplementation(async () => undefined);

  return {
    service,
    sendTemplateSpy: sendTemplateSpy as jest.Mock,
    sendDirectEmail,
    inAppRowCount: () => inAppRows.length,
  };
}

const CUSTOMER_USER_ID = '11111111-1111-1111-1111-111111111111';
const CHEF_USER_ID = '22222222-2222-2222-2222-222222222222';
const BOOKING_ID = '33333333-3333-3333-3333-333333333333';
const SCHEDULED_AT = new Date('2026-06-15T19:30:00.000Z');
const baseDetails = {
  customerName: 'Riya',
  customerPhone: '+919876543210',
  chefUserId: CHEF_USER_ID,
  chefPhone: '+919812345678',
  scheduledAt: SCHEDULED_AT,
};

describe('notifyChefAccepted → WhatsApp branches', () => {
  it('sends BOTH customer and chef confirmation templates with the correct var orders', async () => {
    const f = makeService({});

    await f.service.notifyChefAccepted(
      CUSTOMER_USER_ID,
      'rider@example.com',
      BOOKING_ID,
      'Chef Anjali',
      baseDetails,
    );

    expect(f.sendTemplateSpy).toHaveBeenCalledTimes(2);

    // Order is implementation-defined (customer first, then chef in
    // the current implementation) — assert by template identity, not
    // by call index, so a future re-order won't break this test.
    const customerCall = f.sendTemplateSpy.mock.calls.find(
      (c) => c[0].template === CUSTOMER_BOOKING_CONFIRMED,
    );
    const chefCall = f.sendTemplateSpy.mock.calls.find(
      (c) => c[0].template === CHEF_BOOKING_CONFIRMED,
    );
    expect(customerCall).toBeDefined();
    expect(chefCall).toBeDefined();

    // CUSTOMER_BOOKING_CONFIRMED.vars =
    //   [customer_name, chef_name, date_str, time_str, booking_id_short]
    expect(customerCall![0].to).toBe('+919876543210');
    expect(customerCall![0].vars[0]).toBe('Riya');
    expect(customerCall![0].vars[1]).toBe('Chef Anjali');
    expect(customerCall![0].vars[2]).toMatch(/2026/);
    expect(customerCall![0].vars[3]).toMatch(/\d{1,2}:\d{2}/);
    expect(customerCall![0].vars[4]).toBe('33333333');
    expect(customerCall![0].correlationId).toBe(BOOKING_ID);

    // CHEF_BOOKING_CONFIRMED.vars =
    //   [chef_name, customer_name, date_str, time_str, booking_id_short]
    expect(chefCall![0].to).toBe('+919812345678');
    expect(chefCall![0].vars[0]).toBe('Chef Anjali');
    expect(chefCall![0].vars[1]).toBe('Riya');
    expect(chefCall![0].vars[4]).toBe('33333333');
  });

  it('skips customer WhatsApp when customer phone is null but still sends chef WhatsApp', async () => {
    const f = makeService({});

    await f.service.notifyChefAccepted(
      CUSTOMER_USER_ID,
      'rider@example.com',
      BOOKING_ID,
      'Chef Anjali',
      { ...baseDetails, customerPhone: null },
    );

    const calls = f.sendTemplateSpy.mock.calls;
    const customerCall = calls.find(
      (c) => c[0].template === CUSTOMER_BOOKING_CONFIRMED,
    );
    const chefCall = calls.find(
      (c) => c[0].template === CHEF_BOOKING_CONFIRMED,
    );
    expect(customerCall).toBeUndefined();
    expect(chefCall).toBeDefined();
  });

  it('skips chef WhatsApp when chef phone is null but still sends customer WhatsApp', async () => {
    const f = makeService({});

    await f.service.notifyChefAccepted(
      CUSTOMER_USER_ID,
      'rider@example.com',
      BOOKING_ID,
      'Chef Anjali',
      { ...baseDetails, chefPhone: null },
    );

    const calls = f.sendTemplateSpy.mock.calls;
    expect(
      calls.find((c) => c[0].template === CUSTOMER_BOOKING_CONFIRMED),
    ).toBeDefined();
    expect(
      calls.find((c) => c[0].template === CHEF_BOOKING_CONFIRMED),
    ).toBeUndefined();
  });

  it('skips customer WhatsApp when customer opted out (whatsapp_enabled=false), chef still sent', async () => {
    const f = makeService({ customerWhatsAppEnabled: false });

    await f.service.notifyChefAccepted(
      CUSTOMER_USER_ID,
      'rider@example.com',
      BOOKING_ID,
      'Chef Anjali',
      baseDetails,
    );

    const calls = f.sendTemplateSpy.mock.calls;
    expect(
      calls.find((c) => c[0].template === CUSTOMER_BOOKING_CONFIRMED),
    ).toBeUndefined();
    expect(
      calls.find((c) => c[0].template === CHEF_BOOKING_CONFIRMED),
    ).toBeDefined();
  });

  it('skips chef WhatsApp when chef opted out (whatsapp_enabled=false), customer still sent', async () => {
    const f = makeService({ chefWhatsAppEnabled: false });

    await f.service.notifyChefAccepted(
      CUSTOMER_USER_ID,
      'rider@example.com',
      BOOKING_ID,
      'Chef Anjali',
      baseDetails,
    );

    const calls = f.sendTemplateSpy.mock.calls;
    expect(
      calls.find((c) => c[0].template === CUSTOMER_BOOKING_CONFIRMED),
    ).toBeDefined();
    expect(
      calls.find((c) => c[0].template === CHEF_BOOKING_CONFIRMED),
    ).toBeUndefined();
  });

  it('omits all WhatsApp sends when whatsappDetails is omitted (legacy callers)', async () => {
    const f = makeService({});

    await f.service.notifyChefAccepted(
      CUSTOMER_USER_ID,
      'rider@example.com',
      BOOKING_ID,
      'Chef Anjali',
    );

    expect(f.sendTemplateSpy).not.toHaveBeenCalled();
    expect(f.sendDirectEmail).toHaveBeenCalled(); // legacy email path intact
  });

  it('does not bubble WhatsApp send failures — in-app + email still complete', async () => {
    const throwingSend = jest.fn(async () => {
      throw new Error('Meta is sad');
    });
    const f = makeService({ sendTemplateImpl: throwingSend });

    await expect(
      f.service.notifyChefAccepted(
        CUSTOMER_USER_ID,
        'rider@example.com',
        BOOKING_ID,
        'Chef Anjali',
        baseDetails,
      ),
    ).resolves.toBeUndefined();

    // Both branches attempted, both threw, neither broke the flow.
    expect(throwingSend).toHaveBeenCalledTimes(2);
    expect(f.inAppRowCount()).toBe(1); // customer in-app row
    expect(f.sendDirectEmail).toHaveBeenCalled();
  });

  it('sanitises customer name + chef name into both templates', async () => {
    const f = makeService({});

    await f.service.notifyChefAccepted(
      CUSTOMER_USER_ID,
      'rider@example.com',
      BOOKING_ID,
      'Chef\nAnjali  Patel', // newline + multi-space
      {
        ...baseDetails,
        customerName: 'Riya\tDoshi', // tab
      },
    );

    const calls = f.sendTemplateSpy.mock.calls;
    for (const c of calls) {
      // Free-text vars (chef_name + customer_name) are at indexes 0+1
      // in both templates (just swapped between them). Neither should
      // carry a raw control char.
      expect(c[0].vars[0]).not.toMatch(/[\r\n\t]/);
      expect(c[0].vars[1]).not.toMatch(/[\r\n\t]/);
    }
  });
});

describe('notifyChefRejected → WhatsApp branch', () => {
  it('sends customer rejection template with vars [customer_name, chef_name] only', async () => {
    const f = makeService({});

    await f.service.notifyChefRejected(
      CUSTOMER_USER_ID,
      'rider@example.com',
      BOOKING_ID,
      'Chef Anjali',
      {
        customerName: 'Riya',
        customerPhone: '+919876543210',
      },
    );

    expect(f.sendTemplateSpy).toHaveBeenCalledTimes(1);
    const arg = f.sendTemplateSpy.mock.calls[0][0];
    expect(arg.template).toBe(CUSTOMER_BOOKING_REJECTED);
    expect(arg.to).toBe('+919876543210');
    expect(arg.vars).toEqual(['Riya', 'Chef Anjali']);
    expect(arg.correlationId).toBe(BOOKING_ID);
  });

  it('does NOT send any chef-side WhatsApp on rejection — decline tap is its own ack', async () => {
    const f = makeService({});

    await f.service.notifyChefRejected(
      CUSTOMER_USER_ID,
      'rider@example.com',
      BOOKING_ID,
      'Chef Anjali',
      {
        customerName: 'Riya',
        customerPhone: '+919876543210',
      },
    );

    // Only ONE call total — the customer side. Phase 4 deliberately
    // does NOT add a chef rejection-confirmation template.
    expect(f.sendTemplateSpy).toHaveBeenCalledTimes(1);
    expect(
      f.sendTemplateSpy.mock.calls[0][0].template,
    ).toBe(CUSTOMER_BOOKING_REJECTED);
  });

  it('skips when customer phone is null', async () => {
    const f = makeService({});

    await f.service.notifyChefRejected(
      CUSTOMER_USER_ID,
      'rider@example.com',
      BOOKING_ID,
      'Chef Anjali',
      { customerName: 'Riya', customerPhone: null },
    );

    expect(f.sendTemplateSpy).not.toHaveBeenCalled();
    expect(f.sendDirectEmail).toHaveBeenCalled(); // email still goes
  });

  it('skips when customer opted out of WhatsApp', async () => {
    const f = makeService({ customerWhatsAppEnabled: false });

    await f.service.notifyChefRejected(
      CUSTOMER_USER_ID,
      'rider@example.com',
      BOOKING_ID,
      'Chef Anjali',
      { customerName: 'Riya', customerPhone: '+919876543210' },
    );

    expect(f.sendTemplateSpy).not.toHaveBeenCalled();
  });

  it('omits WhatsApp send when whatsappDetails is omitted (legacy callers)', async () => {
    const f = makeService({});

    await f.service.notifyChefRejected(
      CUSTOMER_USER_ID,
      'rider@example.com',
      BOOKING_ID,
      'Chef Anjali',
    );

    expect(f.sendTemplateSpy).not.toHaveBeenCalled();
    expect(f.sendDirectEmail).toHaveBeenCalled();
  });

  it('does not bubble WhatsApp failure — email + in-app still complete', async () => {
    const throwingSend = jest.fn(async () => {
      throw new Error('Meta is sad');
    });
    const f = makeService({ sendTemplateImpl: throwingSend });

    await expect(
      f.service.notifyChefRejected(
        CUSTOMER_USER_ID,
        'rider@example.com',
        BOOKING_ID,
        'Chef Anjali',
        { customerName: 'Riya', customerPhone: '+919876543210' },
      ),
    ).resolves.toBeUndefined();

    expect(throwingSend).toHaveBeenCalledTimes(1);
    expect(f.inAppRowCount()).toBe(1);
    expect(f.sendDirectEmail).toHaveBeenCalled();
  });
});
