import { Injectable, BadRequestException } from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { DataSource, Repository } from 'typeorm';
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
   * Applies a signed amount inside a DB transaction so concurrent debits
   * can't over-spend. Balance can never drop below zero.
   */
  private async apply(
    userId: string,
    signedAmount: number,
    type: WalletTxnType,
    opts?: TxnOpts,
  ): Promise<WalletTransaction> {
    if (!signedAmount || Number.isNaN(signedAmount)) {
      throw new BadRequestException('Invalid wallet amount');
    }
    return this.dataSource.transaction(async (mgr) => {
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
    });
  }
}
