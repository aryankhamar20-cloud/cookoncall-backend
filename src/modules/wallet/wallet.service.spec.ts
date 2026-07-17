/**
 * WalletService — money-critical unit spec.
 *
 *   1. Balance = SUM(signed amounts).
 *   2. credit() increases balance; debit() decreases it.
 *   3. A debit can NEVER drive the balance below zero (insufficient-balance
 *      guard) — this is the guard that stops a user spending money they
 *      don't have.
 *
 * The service runs credit/debit inside a DataSource transaction; the test
 * fakes an in-memory ledger so we exercise the real balance maths + guard.
 */
import { WalletService } from './wallet.service';
import { WalletTxnType } from './wallet-transaction.entity';
import { BadRequestException } from '@nestjs/common';

function makeService() {
  const ledger: Array<{ amount: number }> = [];
  const sum = () => ledger.reduce((s, r) => s + Number(r.amount), 0);
  const qb = () => ({
    select: () => qb(),
    where: () => qb(),
    getRawOne: async () => ({ bal: String(sum()) }),
  });
  const managerRepo = {
    createQueryBuilder: qb,
    create: (x: { amount: number }) => x,
    save: async (x: { amount: number }) => {
      ledger.push(x);
      return { id: 'txn', ...x };
    },
  };
  const repo = {
    createQueryBuilder: qb,
    find: async () => [...ledger].reverse(),
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
  } as any;
  const dataSource = {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    transaction: async (cb: any) => cb({ getRepository: () => managerRepo }),
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
  } as any;
  return { service: new WalletService(repo, dataSource), ledger };
}

describe('WalletService', () => {
  it('starts at zero', async () => {
    const { service } = makeService();
    expect(await service.getBalance('u1')).toBe(0);
  });

  it('credit increases balance', async () => {
    const { service } = makeService();
    await service.credit('u1', 100, WalletTxnType.REFERRAL_REWARD);
    expect(await service.getBalance('u1')).toBe(100);
  });

  it('debit decreases balance', async () => {
    const { service } = makeService();
    await service.credit('u1', 100, WalletTxnType.REFERRAL_REWARD);
    await service.debit('u1', 30, WalletTxnType.BOOKING_PAYMENT);
    expect(await service.getBalance('u1')).toBe(70);
  });

  it('refuses a debit that would go negative', async () => {
    const { service } = makeService();
    await service.credit('u1', 50, WalletTxnType.REFEREE_DISCOUNT);
    await expect(
      service.debit('u1', 80, WalletTxnType.BOOKING_PAYMENT),
    ).rejects.toBeInstanceOf(BadRequestException);
    // Balance unchanged after the rejected debit.
    expect(await service.getBalance('u1')).toBe(50);
  });

  it('normalises sign: credit is always +, debit always −', async () => {
    const { service } = makeService();
    await service.credit('u1', -100, WalletTxnType.ADJUSTMENT); // abs → +100
    await service.debit('u1', -40, WalletTxnType.BOOKING_PAYMENT); // abs → −40
    expect(await service.getBalance('u1')).toBe(60);
  });
});
