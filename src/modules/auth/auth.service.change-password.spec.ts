/**
 * AuthService.changePassword — unit tests
 *
 * Locks in the security guards documented at the method:
 *   1. Rejects when current_password doesn't match the stored hash.
 *   2. Rejects when current_password === new_password.
 *   3. Rejects when the user has no password (Google-only signup).
 *   4. On success, hashes the new password (cost 12) and clears
 *      the refresh_token to invalidate other sessions.
 *
 * Pure unit test — no DB, no JWT, no email. Repository is stubbed
 * with a mutable in-memory user so we can assert that save() was
 * called with the right mutations.
 */
import {
  BadRequestException,
  UnauthorizedException,
} from '@nestjs/common';
import * as bcrypt from 'bcrypt';
import { AuthService } from './auth.service';

interface FakeUser {
  id: string;
  email: string;
  password: string | null;
  refresh_token: string | null;
  is_active: boolean;
}

function makeService(initialUser: FakeUser) {
  // Mutable copy so save() can mutate freely.
  const user = { ...initialUser };

  const usersRepo: any = {
    findOne: jest.fn(async (q: any) => {
      // Match either { where: { id } } or { where: { email } }
      if (q?.where?.id && q.where.id === user.id) return user;
      if (q?.where?.email && q.where.email === user.email) return user;
      return null;
    }),
    save: jest.fn(async (u: FakeUser) => {
      Object.assign(user, u);
      return user;
    }),
    update: jest.fn(),
  };

  const cooksRepo: any = { findOne: jest.fn() };
  const jwt: any = { sign: jest.fn(), verify: jest.fn() };
  const cfg: any = { get: jest.fn(() => undefined) };
  const limiter: any = { checkAndRecord: jest.fn() };

  const service = new AuthService(
    usersRepo,
    cooksRepo,
    jwt,
    cfg,
    limiter,
  );

  return { service, user, usersRepo };
}

describe('AuthService.changePassword', () => {
  const userId = '11111111-1111-1111-1111-111111111111';
  const currentPlain = 'CurrentP@ss1';
  const newPlain = 'BrandNewP@ss1';

  let initialUser: FakeUser;

  beforeEach(async () => {
    const hashed = await bcrypt.hash(currentPlain, 12);
    initialUser = {
      id: userId,
      email: 'admin@example.com',
      password: hashed,
      refresh_token: 'old-refresh-token-hash',
      is_active: true,
    };
  });

  it('changes the password and invalidates refresh token on success', async () => {
    const { service, user, usersRepo } = makeService(initialUser);

    const result = await service.changePassword(userId, {
      current_password: currentPlain,
      new_password: newPlain,
    });

    expect(result).toEqual({ message: 'Password changed successfully' });
    // bcrypt hash always changes — verify via compare, not equality
    expect(user.password).not.toBe(initialUser.password);
    expect(user.password).not.toBeNull();
    if (user.password) {
      expect(await bcrypt.compare(newPlain, user.password)).toBe(true);
    }
    // refresh_token nulled — other sessions can no longer refresh
    expect(user.refresh_token).toBeNull();
    expect(usersRepo.save).toHaveBeenCalledTimes(1);
  });

  it('rejects when current password is wrong', async () => {
    const { service, user, usersRepo } = makeService(initialUser);

    await expect(
      service.changePassword(userId, {
        current_password: 'NotTheRealPassword1',
        new_password: newPlain,
      }),
    ).rejects.toBeInstanceOf(UnauthorizedException);
    await expect(
      service.changePassword(userId, {
        current_password: 'NotTheRealPassword1',
        new_password: newPlain,
      }),
    ).rejects.toThrow(/Current password is incorrect/i);

    // Original password hash and refresh token must be untouched.
    expect(user.password).toBe(initialUser.password);
    expect(user.refresh_token).toBe(initialUser.refresh_token);
    expect(usersRepo.save).not.toHaveBeenCalled();
  });

  it('rejects when current password equals new password', async () => {
    const { service, user, usersRepo } = makeService(initialUser);

    await expect(
      service.changePassword(userId, {
        current_password: currentPlain,
        new_password: currentPlain,
      }),
    ).rejects.toBeInstanceOf(BadRequestException);
    await expect(
      service.changePassword(userId, {
        current_password: currentPlain,
        new_password: currentPlain,
      }),
    ).rejects.toThrow(/must differ/i);

    expect(user.password).toBe(initialUser.password);
    expect(usersRepo.save).not.toHaveBeenCalled();
  });

  it('rejects accounts without a stored password (Google-only signups)', async () => {
    const googleUser: FakeUser = {
      ...initialUser,
      password: null,
    };
    const { service, usersRepo } = makeService(googleUser);

    await expect(
      service.changePassword(userId, {
        current_password: 'AnyValue1',
        new_password: newPlain,
      }),
    ).rejects.toBeInstanceOf(BadRequestException);
    await expect(
      service.changePassword(userId, {
        current_password: 'AnyValue1',
        new_password: newPlain,
      }),
    ).rejects.toThrow(/No password is set/i);

    expect(usersRepo.save).not.toHaveBeenCalled();
  });

  it('rejects when the user does not exist', async () => {
    const { service, usersRepo } = makeService(initialUser);

    await expect(
      service.changePassword('00000000-0000-0000-0000-000000000000', {
        current_password: currentPlain,
        new_password: newPlain,
      }),
    ).rejects.toBeInstanceOf(UnauthorizedException);

    expect(usersRepo.save).not.toHaveBeenCalled();
  });
});
