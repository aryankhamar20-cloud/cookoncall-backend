import {
  Controller,
  Get,
  Post,
  Body,
  Param,
  Query,
  ParseUUIDPipe,
  UseGuards,
} from '@nestjs/common';
import { IsNumber, IsOptional, IsString, MaxLength } from 'class-validator';
import { ApiTags, ApiBearerAuth, ApiOperation } from '@nestjs/swagger';
import { WalletService } from './wallet.service';
import { WalletTxnType } from './wallet-transaction.entity';
import { CurrentUser } from '../../common/decorators/current-user.decorator';
import { Roles } from '../../common/decorators/roles.decorator';
import { RolesGuard } from '../../common/guards/roles.guard';
import { JwtAuthGuard } from '../auth/guards/jwt-auth.guard';
import { User, UserRole } from '../users/user.entity';

class AdjustWalletDto {
  /** Positive = credit the user, negative = debit. */
  @IsNumber({ maxDecimalPlaces: 2 })
  amount: number;

  @IsOptional()
  @IsString()
  @MaxLength(200)
  description?: string;
}

@ApiTags('Wallet')
@ApiBearerAuth('access-token')
@Controller('wallet')
@UseGuards(JwtAuthGuard, RolesGuard)
export class WalletController {
  constructor(private readonly walletService: WalletService) {}

  // ─── CUSTOMER ────────────────────────────────────────
  @Get()
  @ApiOperation({ summary: 'My wallet balance + recent transactions' })
  async myWallet(@CurrentUser() user: User) {
    const [balance, transactions] = await Promise.all([
      this.walletService.getBalance(user.id),
      this.walletService.getTransactions(user.id, 20),
    ]);
    return { balance, transactions };
  }

  @Get('transactions')
  @ApiOperation({ summary: 'My wallet transaction history' })
  async transactions(@CurrentUser() user: User, @Query('limit') limit = 50) {
    return this.walletService.getTransactions(user.id, Number(limit));
  }

  // ─── ADMIN ───────────────────────────────────────────
  @Get('admin/:userId')
  @Roles(UserRole.ADMIN)
  @ApiOperation({ summary: 'Admin — a user’s wallet balance + transactions' })
  async adminUserWallet(@Param('userId', ParseUUIDPipe) userId: string) {
    const [balance, transactions] = await Promise.all([
      this.walletService.getBalance(userId),
      this.walletService.getTransactions(userId, 50),
    ]);
    return { balance, transactions };
  }

  @Post('admin/:userId/adjust')
  @Roles(UserRole.ADMIN)
  @ApiOperation({ summary: 'Admin — credit/debit a user’s wallet (adjustment)' })
  async adminAdjust(
    @CurrentUser() admin: User,
    @Param('userId', ParseUUIDPipe) userId: string,
    @Body() dto: AdjustWalletDto,
  ) {
    const desc = dto.description || `Admin adjustment`;
    const opts = { referenceType: 'manual', referenceId: admin.id, description: desc };
    const txn =
      dto.amount >= 0
        ? await this.walletService.credit(userId, dto.amount, WalletTxnType.ADJUSTMENT, opts)
        : await this.walletService.debit(userId, Math.abs(dto.amount), WalletTxnType.ADJUSTMENT, opts);
    const balance = await this.walletService.getBalance(userId);
    return { transaction: txn, balance };
  }
}
