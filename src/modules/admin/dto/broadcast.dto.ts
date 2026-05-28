import {
  IsEnum,
  IsOptional,
  IsString,
  Length,
  Matches,
  ValidateIf,
} from 'class-validator';
import { BroadcastAudience } from '../notification-broadcast.entity';

/**
 * Round 3 — payload for POST /admin/notifications/broadcast.
 *
 * - `title` and `body` length caps mirror Apple/Google guidance:
 *   65 chars title, 240 chars body — anything longer gets truncated
 *   on the lock screen anyway, and we want the admin UI to show what
 *   the user will actually see.
 * - When `audience='area'`, `area_slug` is required. The validator
 *   uses ValidateIf so the field is allowed to be absent for the
 *   other audiences.
 * - `deep_link` is a relative app path — we whitelist a small set of
 *   characters so admins can't accidentally inject HTML or JS.
 */
export class CreateBroadcastDto {
  @IsString()
  @Length(1, 65)
  title: string;

  @IsString()
  @Length(1, 240)
  body: string;

  @IsEnum(BroadcastAudience)
  audience: BroadcastAudience;

  @ValidateIf((o) => o.audience === BroadcastAudience.AREA)
  @IsString()
  @Length(1, 64)
  @Matches(/^[a-z0-9-]+$/, {
    message: 'area_slug must be lowercase letters, digits and hyphens only.',
  })
  area_slug?: string;

  @IsOptional()
  @IsString()
  @Length(1, 255)
  @Matches(/^[A-Za-z0-9/_:?&=#.\-]+$/, {
    message: 'deep_link contains invalid characters.',
  })
  deep_link?: string;
}
