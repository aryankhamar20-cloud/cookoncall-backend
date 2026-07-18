/**
 * UsersService.deleteAccount — self-service account deletion.
 *
 * Locks in the security + data-integrity guarantees:
 *   1. Password accounts must supply the correct current password.
 *   2. Wrong password is rejected (Unauthorized).
 *   3. A live booking blocks deletion (Forbidden).
 *   4. Correct password -> soft delete: is_active=false + every PII
 *      field scrubbed, email rewritten to a unique tombstone.
 *   5. Google-only account (no password): needs confirm=true, else
 *      BadRequest; with confirm=true it soft-deletes.
 *
 * Pure unit test — repositories are stubbed, bcrypt is mocked so the
 * branching logic runs on any platform (no native addon needed).
 */
import {
  BadRequestException,
  ForbiddenException,
  UnauthorizedException,
} from '@nestjs/common';
import { UsersService } from './users.service';

// compare() treats 'Secret123' as the one correct password.
jest.mock('bcrypt', () => ({
  hash: jest.fn(async (v: string) => `hashed:${v}`),
  compare: jest.fn(async (plain: string, hash: string) => hash === `hashed:${plain}`),
}));

function makeService(opts: {
  user: Partial<{ id: string; password: string | null; google_id: string | null }>;
  liveBookings?: number;
}) {
  const update = jest.fn().mockResolvedValue({ affected: 1 });
  const usersRepo: any = {
    findOne: jest.fn().mockResolvedValue(opts.user),
    update,
  };
  const bookingsRepo: any = {
    count: jest.fn().mockResolvedValue(opts.liveBookings ?? 0),
  };
  const service = new UsersService(usersRepo, bookingsRepo);
  return { service, update, usersRepo, bookingsRepo };
}

const USER_ID = '11111111-1111-1111-1111-111111111111';

describe('UsersService.deleteAccount', () => {
  it('rejects a password account with no current_password', async () => {
    const { service, update } = makeService({
      user: { id: USER_ID, password: 'hashed:Secret123' },
    });
    await expect(service.deleteAccount(USER_ID, {})).rejects.toBeInstanceOf(
      BadRequestException,
    );
    expect(update).not.toHaveBeenCalled();
  });

  it('rejects a wrong password', async () => {
    const { service, update } = makeService({
      user: { id: USER_ID, password: 'hashed:Secret123' },
    });
    await expect(
      service.deleteAccount(USER_ID, { current_password: 'WrongPass9' }),
    ).rejects.toBeInstanceOf(UnauthorizedException);
    expect(update).not.toHaveBeenCalled();
  });

  it('blocks deletion when a live booking exists', async () => {
    const { service, update } = makeService({
      user: { id: USER_ID, password: 'hashed:Secret123' },
      liveBookings: 2,
    });
    await expect(
      service.deleteAccount(USER_ID, { current_password: 'Secret123' }),
    ).rejects.toBeInstanceOf(ForbiddenException);
    expect(update).not.toHaveBeenCalled();
  });

  it('soft-deletes and scrubs PII on correct password', async () => {
    const { service, update } = makeService({
      user: { id: USER_ID, password: 'hashed:Secret123' },
    });
    const res = await service.deleteAccount(USER_ID, {
      current_password: 'Secret123',
    });
    expect(res).toEqual({ message: 'Your account has been deleted.' });
    expect(update).toHaveBeenCalledTimes(1);
    const [id, patch] = update.mock.calls[0];
    expect(id).toBe(USER_ID);
    expect(patch.is_active).toBe(false);
    expect(patch.password).toBeNull();
    expect(patch.phone).toBeNull();
    expect(patch.address).toBeNull();
    expect(patch.fcm_token).toBeNull();
    expect(patch.email).toBe(`deleted+${USER_ID}@deleted.cookoncall.com`);
    expect(patch.name).toBe('Deleted User');
  });

  it('requires confirm=true for a Google-only account', async () => {
    const { service, update } = makeService({
      user: { id: USER_ID, password: null, google_id: 'g-123' },
    });
    await expect(service.deleteAccount(USER_ID, {})).rejects.toBeInstanceOf(
      BadRequestException,
    );
    expect(update).not.toHaveBeenCalled();
  });

  it('soft-deletes a Google-only account when confirm=true', async () => {
    const { service, update } = makeService({
      user: { id: USER_ID, password: null, google_id: 'g-123' },
    });
    const res = await service.deleteAccount(USER_ID, { confirm: true });
    expect(res).toEqual({ message: 'Your account has been deleted.' });
    expect(update).toHaveBeenCalledTimes(1);
    expect(update.mock.calls[0][1].google_id).toBeNull();
  });
});
