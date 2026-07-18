import { Injectable, BadRequestException } from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { DataSource, EntityManager, Repository } from 'typeorm';
import { WalletTransaction, WalletTxnType } from './wallet-transaction.entity';

interface TxnOpts {
  referenceType?: string;
  referenceId?: string;
  description?: string;
}

@Injectable()
export class WalletService {
  constructor(
    @InjectRepository(WalletTransaction)
    private readonly repo: Repository<WalletTransaction>,
    private readonly dataSource: DataSource,
  ) {}

  /** Current balance = SUM of signed amounts. */
  async getBalance(userId: string): Promise<number> {
    const row = await this.repo
      .createQueryBuilder('w')
      .select('COALESCE(SUM(w.amount), 0)', 'bal')
      .where('w.user_id = :userId', { userId })
      .getRawOne<{ bal: string }>();
    return +Number(row?.bal ?? 0).toFixed(2);
  }

  async getTransactions(userId: string, limit = 50): Promise<WalletTransaction[]> {
    return this.repo.find({
      where: { user_id: userId },
      order: { created_at: 'DESC' },
      take: limit,
    });
  }

  /** Add balance (referral reward, refund credit, admin adjustment). */
  credit(userId: string, amount: number, type: WalletTxnType, opts?: TxnOpts) {
    return this.apply(userId, Math.abs(amount), type, opts);
  }

  /** Spend balance (pay-with-wallet). Throws if it would go negative. */
  debit(userId: string, amount: number, type: WalletTxnType, opts?: TxnOpts) {
    return this.apply(userId, -Math.abs(amount), type, opts);
  }

  /**
   * Applies a signed amount inside its own DB transaction. Thin wrapper
   * around applyWithManager so standalone credits/debits stay one-liners.
   */
  private async apply(
    userId: string,
    signedAmount: number,
    type: WalletTxnType,
    opts?: TxnOpts,
  ): Promise<WalletTransaction> {
    return this.dataSource.transaction((mgr) =>
      this.applyWithManager(mgr, userId, signedAmount, type, opts),
    );
  }

  /**
   * Debit inside a caller-supplied transaction/EntityManager. Lets a
   * larger operation (e.g. pay-from-wallet) debit the wallet AND write
   * its payment row in ONE atomic transaction — if the payment write
   * fails, the debit rolls back with it, so no compensating credit is
   * ever needed.
   */
  debitWithManager(
    mgr: EntityManager,
    userId: string,
    amount: number,
    type: WalletTxnType,
    opts?: TxnOpts,
  ): Promise<WalletTransaction> {
    return this.applyWithManager(mgr, userId, -Math.abs(amount), type, opts);
  }

  /** Credit inside a caller-supplied transaction/EntityManager. */
  creditWithManager(
    mgr: EntityManager,
    userId: string,
    amount: number,
    type: WalletTxnType,
    opts?: TxnOpts,
  ): Promise<WalletTransaction> {
    return this.applyWithManager(mgr, userId, Math.abs(amount), type, opts);
  }

  /**
   * Core ledger write. Runs inside the supplied transaction and takes a
   * per-user Postgres advisory lock FIRST, so two concurrent debits for
   * the same user can't both read a stale balance and over-spend. The
   * lock is transaction-scoped (pg_advisory_xact_lock) and released
   * automatically on commit/rollback, and is re-entrant within the same
   * transaction. Balance can never drop below zero.
   */
  async applyWithManager(
    mgr: EntityManager,
    userId: string,
    signedAmount: number,
    type: WalletTxnType,
    opts?: TxnOpts,
  ): Promise<WalletTransaction> {
    if (!signedAmount || Number.isNaN(signedAmount)) {
      throw new BadRequestException('Invalid wallet amount');
    }
    // Serialize all balance mutations for this user.
    await mgr.query('SELECT pg_advisory_xact_lock(hashtext($1))', [
      `wallet:${userId}`,
    ]);
    const repo = mgr.getRepository(WalletTransaction);
    const cur = await repo
      .createQueryBuilder('w')
      .select('COALESCE(SUM(w.amount), 0)', 'bal')
      .where('w.user_id = :userId', { userId })
      .getRawOne<{ bal: string }>();
    const balance = Number(cur?.bal ?? 0);
    const next = +(balance + signedAmount).toFixed(2);
    if (next < 0) {
      throw new BadRequestException('Insufficient wallet balance');
    }
    const txn = repo.create({
      user_id: userId,
      amount: +signedAmount.toFixed(2),
      balance_after: next,
      type,
      reference_type: opts?.referenceType ?? null,
      reference_id: opts?.referenceId ?? null,
      description: opts?.description ?? null,
    });
    return repo.save(txn);
  }
}
