import {
  BadRequestException,
  ForbiddenException,
  Injectable,
  NotFoundException,
} from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { Repository } from 'typeorm';
import { Address } from './address.entity';
import { CreateAddressDto, UpdateAddressDto } from './dto/address.dto';

const MAX_ADDRESSES_PER_USER = 5;

@Injectable()
export class AddressesService {
  constructor(
    @InjectRepository(Address)
    private readonly addressesRepository: Repository<Address>,
  ) {}

  /** List all addresses for the current user (default first, newest next) */
  async findAllForUser(userId: string): Promise<Address[]> {
    return this.addressesRepository.find({
      where: { user_id: userId },
      order: { is_default: 'DESC', created_at: 'DESC' },
    });
  }

  /** Get one address, scoped to the owner */
  async findOne(id: string, userId: string): Promise<Address> {
    const address = await this.addressesRepository.findOne({ where: { id } });
    if (!address) throw new NotFoundException('Address not found');
    if (address.user_id !== userId) {
      throw new ForbiddenException('You do not have access to this address');
    }
    return address;
  }

  /** Create address (max 5 per user, first one becomes default) */
  async create(userId: string, dto: CreateAddressDto): Promise<Address> {
    const count = await this.addressesRepository.count({ where: { user_id: userId } });
    if (count >= MAX_ADDRESSES_PER_USER) {
      throw new BadRequestException(
        `You can save a maximum of ${MAX_ADDRESSES_PER_USER} addresses. Please delete one before adding a new address.`,
      );
    }

    // First address is automatically default, or if caller explicitly asks
    const shouldBeDefault = count === 0 || dto.is_default === true;

    if (shouldBeDefault) {
      await this.clearDefaultForUser(userId);
    }

    const address = this.addressesRepository.create({
      ...dto,
      user_id: userId,
      is_default: shouldBeDefault,
    });
    return this.addressesRepository.save(address);
  }

  /** Update address */
  async update(id: string, userId: string, dto: UpdateAddressDto): Promise<Address> {
    const address = await this.findOne(id, userId);

    if (dto.is_default === true && !address.is_default) {
      await this.clearDefaultForUser(userId);
    }

    Object.assign(address, dto);
    return this.addressesRepository.save(address);
  }

  /** Delete address. If it was default and others exist, promote the newest to default. */
  async delete(id: string, userId: string): Promise<{ success: boolean }> {
    const address = await this.findOne(id, userId);
    const wasDefault = address.is_default;
    await this.addressesRepository.remove(address);

    if (wasDefault) {
      const remaining = await this.addressesRepository.find({
        where: { user_id: userId },
        order: { created_at: 'DESC' },
        take: 1,
      });
      if (remaining.length > 0) {
        remaining[0].is_default = true;
        await this.addressesRepository.save(remaining[0]);
      }
    }

    return { success: true };
  }

  /** Explicitly mark an address as default (unsets all others for that user) */
  async setDefault(id: string, userId: string): Promise<Address> {
    const address = await this.findOne(id, userId);
    if (address.is_default) return address;

    await this.clearDefaultForUser(userId);
    address.is_default = true;
    return this.addressesRepository.save(address);
  }

  /** Internal: unset default flag across all of user's addresses */
  private async clearDefaultForUser(userId: string): Promise<void> {
    await this.addressesRepository.update(
      { user_id: userId, is_default: true },
      { is_default: false },
    );
  }
}
