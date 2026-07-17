import {
  Injectable,
  NotFoundException,
  BadRequestException,
  ForbiddenException,
} from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { Repository } from 'typeorm';
import { Dispute, DisputeStatus, DisputeParty } from './dispute.entity';
import { Booking } from '../bookings/booking.entity';

@Injectable()
export class DisputesService {
  constructor(
    @InjectRepository(Dispute)
    private readonly disputeRepo: Repository<Dispute>,
    @InjectRepository(Booking)
    private readonly bookingRepo: Repository<Booking>,
  ) {}

  /** Raise a dispute on a booking the caller is a party to. */
  async raise(
    userId: string,
    dto: { booking_id: string; reason: string; description: string },
  ): Promise<Dispute> {
    const booking = await this.bookingRepo.findOne({
      where: { id: dto.booking_id },
      relations: ['cook'],
    });
    if (!booking) throw new NotFoundException('Booking not found');

    // Determine which party the caller is — and reject strangers (no IDOR).
    let role: DisputeParty;
    if (booking.user_id === userId) {
      role = DisputeParty.CUSTOMER;
    } else if (booking.cook?.user_id === userId) {
      role = DisputeParty.COOK;
    } else {
      throw new ForbiddenException('You are not a party to this booking');
    }

    // One open dispute per user per booking.
    const existing = await this.disputeRepo.findOne({
      where: {
        booking_id: dto.booking_id,
        raised_by_user_id: userId,
        status: DisputeStatus.OPEN,
      },
    });
    if (existing) {
      throw new BadRequestException('You already have an open dispute on this booking');
    }

    const dispute = this.disputeRepo.create({
      booking_id: dto.booking_id,
      raised_by_user_id: userId,
      raised_by_role: role,
      reason: dto.reason,
      description: dto.description,
      status: DisputeStatus.OPEN,
    });
    return this.disputeRepo.save(dispute);
  }

  /** Disputes the caller raised. */
  async listForUser(userId: string): Promise<Dispute[]> {
    return this.disputeRepo.find({
      where: { raised_by_user_id: userId },
      order: { created_at: 'DESC' },
    });
  }

  // ─── ADMIN ───────────────────────────────────────────
  async adminList(status?: DisputeStatus, page = 1, limit = 20) {
    const where = status ? { status } : {};
    const [disputes, total] = await this.disputeRepo.findAndCount({
      where,
      relations: ['raised_by', 'booking'],
      order: { created_at: 'DESC' },
      skip: (page - 1) * limit,
      take: limit,
    });
    return { disputes, total };
  }

  async resolve(
    id: string,
    adminId: string,
    dto: {
      status: DisputeStatus.RESOLVED | DisputeStatus.REJECTED | DisputeStatus.UNDER_REVIEW;
      resolution_note?: string;
      refund_amount?: number;
    },
  ): Promise<Dispute> {
    const dispute = await this.disputeRepo.findOne({ where: { id } });
    if (!dispute) throw new NotFoundException('Dispute not found');

    dispute.status = dto.status;
    if (dto.resolution_note !== undefined) dispute.resolution_note = dto.resolution_note;
    if (dto.refund_amount !== undefined) dispute.refund_amount = dto.refund_amount;

    if (dto.status === DisputeStatus.RESOLVED || dto.status === DisputeStatus.REJECTED) {
      dispute.resolved_by = adminId;
      dispute.resolved_at = new Date();
    }
    return this.disputeRepo.save(dispute);
  }
}
