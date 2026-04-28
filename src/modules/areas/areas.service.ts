import {
  BadRequestException,
  ConflictException,
  Injectable,
  NotFoundException,
} from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { Repository } from 'typeorm';
import { ServiceArea, AreaRequest, RequesterRole } from './area.entity';
import { ApproveAreaDto, RequestAreaDto, slugifyAreaName } from './dto/area.dto';

@Injectable()
export class AreasService {
  constructor(
    @InjectRepository(ServiceArea)
    private areasRepo: Repository<ServiceArea>,
    @InjectRepository(AreaRequest)
    private requestsRepo: Repository<AreaRequest>,
  ) {}

  // ─── PUBLIC: list active areas ─────────────────────────
  async listActive(city?: string) {
    const where: any = { is_active: true };
    if (city) where.city = city;
    return this.areasRepo.find({
      where,
      order: { sort_order: 'ASC', name: 'ASC' },
    });
  }

  async listAll() {
    return this.areasRepo.find({
      order: { is_active: 'DESC', sort_order: 'ASC', name: 'ASC' },
    });
  }

  async getBySlug(slug: string) {
    return this.areasRepo.findOne({ where: { slug } });
  }

  // ─── HYBRID: customer/chef requests a new area ────────
  async requestArea(
    requesterId: string,
    requesterRole: RequesterRole,
    dto: RequestAreaDto,
  ) {
    const proposedSlug = slugifyAreaName(dto.name);
    if (!proposedSlug) {
      throw new BadRequestException('Area name must contain at least one letter or number.');
    }

    // If an active area already exists with this slug or name, return it
    const existing = await this.areasRepo.findOne({ where: { slug: proposedSlug } });
    if (existing && existing.is_active) {
      return {
        already_exists: true,
        area: existing,
      };
    }

    // Check if this requester already has a pending request for this name
    const dupe = await this.requestsRepo.findOne({
      where: {
        requester_id: requesterId,
        status: 'pending',
        name: dto.name.trim(),
      },
    });
    if (dupe) {
      return {
        already_requested: true,
        request: dupe,
      };
    }

    const request = this.requestsRepo.create({
      requester_id: requesterId,
      requester_role: requesterRole,
      name: dto.name.trim(),
      city: dto.city?.trim() || 'Ahmedabad',
      status: 'pending',
    });
    const saved = await this.requestsRepo.save(request);
    return {
      created: true,
      request: saved,
    };
  }

  // ─── ADMIN: list pending area requests ────────────────
  async listRequests(status?: 'pending' | 'approved' | 'rejected') {
    const where: any = {};
    if (status) where.status = status;
    return this.requestsRepo.find({
      where,
      relations: ['requester'],
      order: { created_at: 'DESC' },
      take: 100,
    });
  }

  // ─── ADMIN: approve a request → creates active area ───
  async approveRequest(
    requestId: string,
    adminId: string,
    dto: ApproveAreaDto,
  ) {
    const req = await this.requestsRepo.findOne({ where: { id: requestId } });
    if (!req) throw new NotFoundException('Area request not found.');
    if (req.status !== 'pending') {
      throw new BadRequestException(`Request already ${req.status}.`);
    }

    const slug = slugifyAreaName(dto.slug);
    if (!slug) throw new BadRequestException('Invalid slug.');

    // Make sure slug isn't taken
    const taken = await this.areasRepo.findOne({ where: { slug } });
    if (taken) {
      throw new ConflictException(
        `Slug '${slug}' is already used by '${taken.name}'. Pick another slug.`,
      );
    }

    // Find the next sort_order in this region
    const lastInRegion = await this.areasRepo
      .createQueryBuilder('a')
      .where('a.region = :region', { region: dto.region })
      .orderBy('a.sort_order', 'DESC')
      .getOne();
    const nextSortOrder = (lastInRegion?.sort_order ?? 0) + 1;

    const area = this.areasRepo.create({
      slug,
      name: req.name,
      region: dto.region,
      city: req.city,
      is_active: true,
      sort_order: nextSortOrder,
    });
    const savedArea = await this.areasRepo.save(area);

    req.status = 'approved';
    req.approved_slug = slug;
    req.reviewed_by = adminId;
    req.reviewed_at = new Date();
    await this.requestsRepo.save(req);

    return { area: savedArea, request: req };
  }

  // ─── ADMIN: reject a request ──────────────────────────
  async rejectRequest(requestId: string, adminId: string, reason: string) {
    const req = await this.requestsRepo.findOne({ where: { id: requestId } });
    if (!req) throw new NotFoundException('Area request not found.');
    if (req.status !== 'pending') {
      throw new BadRequestException(`Request already ${req.status}.`);
    }
    req.status = 'rejected';
    req.reject_reason = reason;
    req.reviewed_by = adminId;
    req.reviewed_at = new Date();
    return this.requestsRepo.save(req);
  }
}
