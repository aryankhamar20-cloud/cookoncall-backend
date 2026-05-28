import { IsBoolean, IsOptional } from 'class-validator';
import { ApiPropertyOptional } from '@nestjs/swagger';

/**
 * Round 4 — Settings → Notifications screen on web + Flutter both
 * patch this DTO. Every field is optional so the UI can flip a single
 * toggle without sending the others. Booleans only — server stores
 * exactly what the user chose.
 */
export class UpdateNotificationPreferencesDto {
  @ApiPropertyOptional({ example: true })
  @IsOptional()
  @IsBoolean()
  push_enabled?: boolean;

  @ApiPropertyOptional({ example: true })
  @IsOptional()
  @IsBoolean()
  email_enabled?: boolean;

  @ApiPropertyOptional({ example: true })
  @IsOptional()
  @IsBoolean()
  sms_enabled?: boolean;
}
