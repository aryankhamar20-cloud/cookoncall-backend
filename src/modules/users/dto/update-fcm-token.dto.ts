import { IsString, IsNotEmpty } from 'class-validator';
import { ApiProperty } from '@nestjs/swagger';

export class UpdateFcmTokenDto {
  @ApiProperty({ example: 'eXpL0iT_fcm_token_here', description: 'Firebase Cloud Messaging device token' })
  @IsString()
  @IsNotEmpty()
  fcm_token: string;
}
