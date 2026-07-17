import { Controller, Get, Query, UseGuards } from '@nestjs/common';
import { ApiTags, ApiBearerAuth, ApiOperation } from '@nestjs/swagger';
import { WalletService } from './wallet.service';
import { CurrentUser } from '../../common/decorators/current-user.decorator';
import { JwtAuthGuard } from '../auth/guards/jwt-auth.guard';
import { User } from '../users/user.entity';

@ApiTags('Wallet')
@ApiBearerAuth('access-token')
@Controller('wallet')
@UseGuards(JwtAuthGuard)
export class WalletController {
  constructor(private readonly walletService: WalletService) {}

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
  async transactions(
    @CurrentUser() user: User,
    @Query('limit') limit = 50,
  ) {
    return this.walletService.getTransactions(user.id, Number(limit));
  }
}
