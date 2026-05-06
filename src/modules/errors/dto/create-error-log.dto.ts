import { IsOptional, IsString, IsUUID } from 'class-validator';

export class CreateErrorLogDto {
  @IsString()
  message: string;

  @IsOptional()
  @IsString()
  stack?: string;

  @IsOptional()
  @IsString()
  component_stack?: string;

  @IsOptional()
  @IsString()
  url?: string;

  @IsOptional()
  @IsString()
  user_agent?: string;

  // Sent by the frontend when the user is logged in.
  // Not a security risk — just a convenience for tracing errors back to users.
  @IsOptional()
  @IsUUID()
  user_id?: string;
}
