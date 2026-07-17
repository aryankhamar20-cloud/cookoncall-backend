/**
 * PayoutsService — unit spec for the money-critical paths.
 *
 * Locks in three properties an admin recording chef payouts relies on:
 *
 *   1. A payout amount must be positive.
 *   2. A payout can NEVER exceed the chef's outstanding balance
 *      (earned − already-paid), with a 1-paisa epsilon for rounding.
 *      This is the guard that stops an admin over-paying a chef by
 *      mistake (or a UI bug double-submitting).
 *   3. Marking a payout paid is idempotent-safe: a payout already 'paid'
 *      can't be re-marked (which would corrupt the balance).
 *
 * balanceForCook itself is exercised via the create() guard by stubbing
 * it, since its internals are just two SUM query-builders.
 */
import { PayoutsService } from './payouts.service';
import { PayoutStatus, PayoutMethod } from './payout.entity';
import { BadRequestException, NotFoundException } from '@nestjs/common';

// eslint-disable-next-line @typescript-eslint/no-explicit-any
type AnyRepo = any;

function makeService() {
  const payoutRepo = {
    create: jest.fn((x) => x),
    save: jest.fn((x) => Promise.resolve({ id: 'p1', ...x })),
    findOne: jest.fn(),
    createQueryBuilder: jest.fn(),
  };
  const cookRepo = { findOne: jest.fn(), find: jest.fn() };
  const bookingRepo = { createQueryBuilder: jest.fn() };
  const service = new PayoutsService(
    payoutRepo as AnyRepo,
    cookRepo as AnyRepo,
    bookingRepo as AnyRepo,
  );
  return { service, payoutRepo, cookRepo, bookingRepo };
}

describe('PayoutsService.create — over-pay guard', () => {
  const balance = {
    cook_id: 'cook1',
    cook_name: 'Asha',
    total_earned: 500,
    total_paid: 200,
    outstanding: 300,
    completed_bookings: 4,
  };

  it('rejects a non-positive amount', async () => {
    const { service } = makeService();
    jest.spyOn(service, 'balanceForCook').mockResolvedValue(balance);
    await expect(
      service.create('admin1', { cook_id: 'cook1', amount: 0 }),
    ).rejects.toBeInstanceOf(BadRequestException);
  });

  it('rejects an amount above the outstanding balance', async () => {
    const { service } = makeService();
    jest.spyOn(service, 'balanceForCook').mockResolvedValue(balance);
    await expect(
      service.create('admin1', { cook_id: 'cook1', amount: 300.5 }),
    ).rejects.toBeInstanceOf(BadRequestException);
  });

  it('allows an amount within the balance and records it paid when mark_paid', async () => {
    const { service, payoutRepo } = makeService();
    jest.spyOn(service, 'balanceForCook').mockResolvedValue(balance);
    const result = await service.create('admin1', {
      cook_id: 'cook1',
      amount: 300,
      method: PayoutMethod.UPI,
      reference: 'UTR123',
      mark_paid: true,
    });
    expect(payoutRepo.save).toHaveBeenCalledTimes(1);
    expect(result.status).toBe(PayoutStatus.PAID);
    expect(result.paid_at).toBeInstanceOf(Date);
    expect(result.created_by).toBe('admin1');
    expect(Number(result.amount)).toBe(300);
  });

  it('allows exactly the outstanding amount (epsilon boundary)', async () => {
    const { service } = makeService();
    jest.spyOn(service, 'balanceForCook').mockResolvedValue(balance);
    await expect(
      service.create('admin1', { cook_id: 'cook1', amount: 300 }),
    ).resolves.toBeDefined();
  });
});

describe('PayoutsService.markPaid — state machine', () => {
  it('throws NotFound when the payout does not exist', async () => {
    const { service, payoutRepo } = makeService();
    payoutRepo.findOne.mockResolvedValue(null);
    await expect(service.markPaid('missing', {})).rejects.toBeInstanceOf(
      NotFoundException,
    );
  });

  it('refuses to re-mark an already-paid payout', async () => {
    const { service, payoutRepo } = makeService();
    payoutRepo.findOne.mockResolvedValue({ id: 'p1', status: PayoutStatus.PAID });
    await expect(service.markPaid('p1', {})).rejects.toBeInstanceOf(
      BadRequestException,
    );
  });

  it('marks a pending payout paid with method + reference', async () => {
    const { service, payoutRepo } = makeService();
    payoutRepo.findOne.mockResolvedValue({ id: 'p1', status: PayoutStatus.PENDING });
    const result = await service.markPaid('p1', {
      method: PayoutMethod.BANK_TRANSFER,
      reference: 'NEFT-9',
    });
    expect(result.status).toBe(PayoutStatus.PAID);
    expect(result.paid_at).toBeInstanceOf(Date);
    expect(result.method).toBe(PayoutMethod.BANK_TRANSFER);
    expect(result.reference).toBe('NEFT-9');
  });
});
