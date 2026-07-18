/**
 * NotificationsService._channelAllowed — gating contract for the
 * 'whatsapp' channel (Phase 1, May 29 2026).
 *
 * Why this test exists
 * --------------------
 * `_channelAllowed` is the single chokepoint that decides whether
 * an outbound channel fires. Email + SMS + push were already covered
 * indirectly (the `notify-booking-created.spec.ts` exercises email).
 * WhatsApp is a NEW channel; it must follow EXACTLY the same default
 * + opt-out semantics as the others, otherwise some users will get
 * WhatsApp messages they expected to be muted (or worse — won't get
 * them when they expect to).
 *
 * What this spec locks in
 * -----------------------
 *   1. Default-allow: a user row with whatsapp_enabled=true (the
 *      column default) returns true.
 *   2. Opt-out: a user row with whatsapp_enabled=false returns false.
 *   3. Defensive default-allow: when the User row is missing /
 *      undefined / can't be read, we default to ALLOW (matching the
 *      other channels — a transient DB hiccup must not silently
 *      drop a chef's booking-request notification).
 *   4. Anonymous (userId=null) returns true — same as other channels;
 *      callers like the password-reset flow have no user_id at the
 *      point of send.
 *   5. The `select` clause asks for `whatsapp_enabled` so the field
 *      is actually populated on the entity instance — without this,
 *      every WhatsApp send would be dropped because the column
 *      defaults to undefined on a partial select.
 *
 * Implementation note — why we use the private method directly:
 *   `_channelAllowed` is private but is the unit under test here.
 *   Casting to `any` to call it is the standard Jest pattern for
 *   testing private helpers without polluting the public API. The
 *   alternative — testing through `notifyBookingCreated` — would
 *   couple us to that helper's behavior + the in-app create paths.
 */
import { NotificationsService } from './notifications.service';

function makeService(usersFindOne: jest.Mock) {
  const notificationsRepo: any = {
    findOne: jest.fn(),
    create: jest.fn(),
    save: jest.fn(),
    findAndCount: jest.fn(),
    count: jest.fn(),
    update: jest.fn(),
  };
  const usersRepo: any = { findOne: usersFindOne };
  const noopQueue: any = { add: jest.fn() };
  const config: any = { get: jest.fn(() => '') };
  const analytics: any = { track: jest.fn() };
  // Phase 2 — NotificationsService constructor takes a WhatsAppService
  // dep too; mocked here to a no-op since this spec only exercises
  // _channelAllowed (no actual WhatsApp send happens).
  const whatsapp: any = {
    sendTemplate: jest.fn(async () => true),
    sendText: jest.fn(),
    isConfigured: jest.fn(() => true),
    verifySignature: jest.fn(),
    verifyChallenge: jest.fn(),
    parseInbound: jest.fn(),
  };

  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const fcm: any = { sendToToken: jest.fn(), sendToMultiple: jest.fn() };

  return new NotificationsService(
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
}

describe('NotificationsService._channelAllowed("whatsapp")', () => {
  it('returns true when User.whatsapp_enabled=true (default ON)', async () => {
    const findOne = jest.fn().mockResolvedValue({
      id: 'u-1',
      email_enabled: true,
      sms_enabled: true,
      push_enabled: true,
      whatsapp_enabled: true,
    });
    const svc = makeService(findOne) as any;
    expect(await svc._channelAllowed('u-1', 'whatsapp')).toBe(true);
  });

  it('returns false when User.whatsapp_enabled=false (opt-out)', async () => {
    const findOne = jest.fn().mockResolvedValue({
      id: 'u-1',
      email_enabled: true,
      sms_enabled: true,
      push_enabled: true,
      whatsapp_enabled: false,
    });
    const svc = makeService(findOne) as any;
    expect(await svc._channelAllowed('u-1', 'whatsapp')).toBe(false);
  });

  it('returns true (defensive default) when User row not found', async () => {
    const findOne = jest.fn().mockResolvedValue(null);
    const svc = makeService(findOne) as any;
    expect(await svc._channelAllowed('u-1', 'whatsapp')).toBe(true);
  });

  it('returns true (defensive default) when DB read throws', async () => {
    const findOne = jest.fn().mockRejectedValue(new Error('DB hiccup'));
    const svc = makeService(findOne) as any;
    expect(await svc._channelAllowed('u-1', 'whatsapp')).toBe(true);
  });

  it('returns true (defensive default) when whatsapp_enabled is undefined on the row', async () => {
    // Simulates a stale code path that didn't ask for the column in the
    // SELECT — the channel must default to ALLOW so a partial-select
    // bug never silently mutes WhatsApp sitewide.
    const findOne = jest.fn().mockResolvedValue({
      id: 'u-1',
      email_enabled: true,
      sms_enabled: true,
      push_enabled: true,
    });
    const svc = makeService(findOne) as any;
    expect(await svc._channelAllowed('u-1', 'whatsapp')).toBe(true);
  });

  it('returns true when userId is null (anonymous send path)', async () => {
    const findOne = jest.fn();
    const svc = makeService(findOne) as any;
    expect(await svc._channelAllowed(null, 'whatsapp')).toBe(true);
    expect(findOne).not.toHaveBeenCalled();
  });

  it('asks the DB for whatsapp_enabled in the SELECT clause', async () => {
    const findOne = jest.fn().mockResolvedValue({
      id: 'u-1',
      whatsapp_enabled: true,
    });
    const svc = makeService(findOne) as any;
    await svc._channelAllowed('u-1', 'whatsapp');

    expect(findOne).toHaveBeenCalledTimes(1);
    const arg = findOne.mock.calls[0][0];
    expect(arg.select).toEqual(
      expect.arrayContaining(['whatsapp_enabled']),
    );
  });

  // Regression guard: the existing channels MUST still gate correctly
  // after we added the new branch. The grep target if this fails is
  // notifications.service.ts > _channelAllowed.
  it.each<['email' | 'sms' | 'push', string]>([
    ['email', 'email_enabled'],
    ['sms', 'sms_enabled'],
    ['push', 'push_enabled'],
  ])('still gates the legacy %s channel via %s', async (channel, col) => {
    const findOne = jest
      .fn()
      .mockResolvedValueOnce({ id: 'u-1', [col]: false })
      .mockResolvedValueOnce({ id: 'u-1', [col]: true });
    const svc = makeService(findOne) as any;
    expect(await svc._channelAllowed('u-1', channel)).toBe(false);
    expect(await svc._channelAllowed('u-1', channel)).toBe(true);
  });
});
