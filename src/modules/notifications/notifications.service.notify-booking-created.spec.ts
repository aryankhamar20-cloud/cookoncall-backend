/**
 * NotificationsService.notifyBookingCreated — chef-email regression spec
 *
 * Locks in the bug fix from `fix/notify-cook-on-new-booking`:
 *
 *   The customer reported "I get a booking confirmation email when I
 *   book a chef, but the chef never gets a request email." Diagnosis:
 *   notifyBookingCreated was inserting an in-app notification row for
 *   the chef but never sending an email — every other chef-side stage
 *   (notifyChefAccepted, notifyChefRejected, notifyBookingExpired)
 *   sends a branded Brevo email; the new-booking case was the only
 *   one missing it.
 *
 * What this spec asserts
 * ----------------------
 *   1. Chef in-app notification row is always created.
 *   2. Customer in-app notification row is always created.
 *   3. Chef email is sent when:
 *        - cookEmail is non-null
 *        - the chef hasn't muted the email channel (email_enabled !== false)
 *      The email is fire-and-forget (sendDirectEmail) and channel-gated
 *      via the same `_channelAllowed` helper every other branded email
 *      uses.
 *   4. Chef email is NOT sent when chefDetails is omitted entirely
 *      (legacy callers — none exist today, but the optional-arg shape
 *      is preserved for backward compatibility).
 *   5. Chef email is NOT sent when the chef has muted email
 *      (email_enabled === false on the user row).
 *   6. Chef email is NOT sent when cookEmail is null (Google-only
 *      account that somehow lacks an email — defensive).
 *
 * Why this test matters
 * ---------------------
 * If a future refactor of notifyBookingCreated drops the email send
 * (for instance, by extracting the in-app and email branches into
 * separate helpers and accidentally only calling the in-app one),
 * tests #3 / #5 will fail with a clear "email was supposed to be sent
 * but wasn't" message — caught at PR time, not when chefs start
 * complaining again.
 */
import { NotificationsService } from './notifications.service';
import { NotificationType } from './notification.entity';

interface FakeNotificationRow {
  user_id: string;
  type: NotificationType;
  title: string;
  message: string;
  metadata?: Record<string, any>;
}

function makeService(opts: {
  emailEnabled?: boolean;
  brevoApiKey?: string;
}): {
  service: NotificationsService;
  inAppRows: FakeNotificationRow[];
  sendDirectEmail: jest.SpyInstance;
} {
  const inAppRows: FakeNotificationRow[] = [];

  const notificationsRepo: any = {
    findOne: jest.fn(async () => null),
    create: jest.fn((row: FakeNotificationRow) => row),
    save: jest.fn(async (row: FakeNotificationRow) => {
      inAppRows.push(row);
      return row;
    }),
  };

  // _channelAllowed reads `email_enabled` off the user row. Default to
  // allowed unless the test explicitly opts out.
  const usersRepo: any = {
    findOne: jest.fn(async () => ({
      id: 'cook-user-id',
      email_enabled: opts.emailEnabled ?? true,
      sms_enabled: true,
      push_enabled: true,
    })),
  };

  const noopQueue: any = { add: jest.fn() };
  const config: any = {
    get: jest.fn(() => opts.brevoApiKey ?? 'test-brevo-api-key'),
  };
  const analytics: any = { recordEvent: jest.fn() };

  const service = new NotificationsService(
    notificationsRepo,
    usersRepo,
    noopQueue,
    noopQueue,
    config,
    analytics,
  );

  // Spy on sendDirectEmail rather than letting it actually call fetch.
  // The method is async but fire-and-forget at the call site, so a
  // simple resolved-promise stub is enough.
  const sendDirectEmail = jest
    .spyOn(service, 'sendDirectEmail')
    .mockImplementation(async () => undefined);

  return { service, inAppRows, sendDirectEmail };
}

describe('NotificationsService.notifyBookingCreated', () => {
  const userId = '11111111-1111-1111-1111-111111111111';
  const cookUserId = '22222222-2222-2222-2222-222222222222';
  const bookingId = '33333333-3333-3333-3333-333333333333';
  const chefDetails = {
    cookEmail: 'chef@example.com',
    chefName: 'Chef Anjali',
    scheduledAt: new Date('2026-06-15T19:30:00.000Z'),
    address: 'Flat 4B, Sky Heights, Ahmedabad',
    totalPrice: 1234.56,
  };

  it('writes BOTH the chef and customer in-app notification rows (always)', async () => {
    const { service, inAppRows } = makeService({});

    await service.notifyBookingCreated(
      userId,
      cookUserId,
      bookingId,
      'Riya',
      chefDetails,
    );

    expect(inAppRows).toHaveLength(2);

    const chefRow = inAppRows.find((r) => r.user_id === cookUserId);
    expect(chefRow).toBeDefined();
    expect(chefRow!.type).toBe(NotificationType.BOOKING_CREATED);
    expect(chefRow!.title).toBe('New Booking Request');
    expect(chefRow!.message).toContain('Riya');
    expect(chefRow!.metadata).toEqual({ booking_id: bookingId });

    const customerRow = inAppRows.find((r) => r.user_id === userId);
    expect(customerRow).toBeDefined();
    expect(customerRow!.title).toBe('Booking Placed');
  });

  it('sends an email to the chef when cookEmail is set and channel is allowed', async () => {
    const { service, sendDirectEmail } = makeService({ emailEnabled: true });

    await service.notifyBookingCreated(
      userId,
      cookUserId,
      bookingId,
      'Riya',
      chefDetails,
    );

    expect(sendDirectEmail).toHaveBeenCalledTimes(1);
    const [to, subject, html] = sendDirectEmail.mock.calls[0];
    expect(to).toBe('chef@example.com');
    // Subject names the booking and identifies the brand.
    expect(subject).toMatch(/New Booking Request/);
    expect(subject).toMatch(/CookOnCall/);
    // Body must address the chef by name and surface the customer + the
    // 3-hour SLA. It must contain the address so the chef can decide
    // before accepting.
    expect(html).toContain('Chef Anjali');
    expect(html).toContain('Riya');
    expect(html).toMatch(/3\s*hours/i);
    expect(html).toContain('Flat 4B, Sky Heights, Ahmedabad');
  });

  it('does NOT send the chef email when chefDetails is omitted', async () => {
    const { service, sendDirectEmail, inAppRows } = makeService({});

    await service.notifyBookingCreated(userId, cookUserId, bookingId, 'Riya');

    // In-app rows still written (channel matrix said in-app is always).
    expect(inAppRows).toHaveLength(2);
    // Email skipped because we have nothing to address it to.
    expect(sendDirectEmail).not.toHaveBeenCalled();
  });

  it('does NOT send the chef email when the chef has email_enabled=false', async () => {
    const { service, sendDirectEmail } = makeService({ emailEnabled: false });

    await service.notifyBookingCreated(
      userId,
      cookUserId,
      bookingId,
      'Riya',
      chefDetails,
    );

    expect(sendDirectEmail).not.toHaveBeenCalled();
  });

  it('does NOT send the chef email when cookEmail is null', async () => {
    const { service, sendDirectEmail } = makeService({});

    await service.notifyBookingCreated(userId, cookUserId, bookingId, 'Riya', {
      ...chefDetails,
      cookEmail: null,
    });

    expect(sendDirectEmail).not.toHaveBeenCalled();
  });

  it('always passes a friendly customer name (defaulted upstream) into the email body', async () => {
    const { service, sendDirectEmail } = makeService({});

    await service.notifyBookingCreated(
      userId,
      cookUserId,
      bookingId,
      'A customer', // upstream default when User row has no name
      chefDetails,
    );

    const [, , html] = sendDirectEmail.mock.calls[0];
    expect(html).toContain('A customer');
  });
});
