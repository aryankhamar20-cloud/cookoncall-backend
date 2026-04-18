import {
  IsEnum,
  IsNotEmpty,
  IsNumber,
  IsOptional,
  IsString,
  Length,
  Matches,
  MaxLength,
} from 'class-validator';
import { AddressLabel } from '../address.entity';

export class CreateAddressDto {
  @IsOptional()
  @IsEnum(AddressLabel)
  label?: AddressLabel;

  @IsOptional()
  @IsString()
  @MaxLength(100)
  contact_name?: string;

  @IsOptional()
  @IsString()
  @Matches(/^[0-9]{10}$/, { message: 'contact_phone must be a 10-digit number' })
  contact_phone?: string;

  @IsString()
  @IsNotEmpty()
  @MaxLength(100)
  house_no: string;

  @IsString()
  @IsNotEmpty()
  @MaxLength(200)
  street: string;

  @IsOptional()
  @IsString()
  @MaxLength(100)
  landmark?: string;

  @IsString()
  @IsNotEmpty()
  @MaxLength(100)
  area: string;

  @IsString()
  @IsNotEmpty()
  @MaxLength(100)
  city: string;

  @IsString()
  @IsNotEmpty()
  @MaxLength(100)
  state: string;

  @IsString()
  @IsNotEmpty()
  @Length(6, 6, { message: 'pincode must be exactly 6 digits' })
  @Matches(/^[1-9][0-9]{5}$/, { message: 'pincode must be a valid 6-digit Indian pincode' })
  pincode: string;

  @IsOptional()
  @IsNumber()
  latitude?: number;

  @IsOptional()
  @IsNumber()
  longitude?: number;

  @IsOptional()
  is_default?: boolean;
}

export class UpdateAddressDto {
  @IsOptional()
  @IsEnum(AddressLabel)
  label?: AddressLabel;

  @IsOptional()
  @IsString()
  @MaxLength(100)
  contact_name?: string;

  @IsOptional()
  @IsString()
  @Matches(/^[0-9]{10}$/, { message: 'contact_phone must be a 10-digit number' })
  contact_phone?: string;

  @IsOptional()
  @IsString()
  @MaxLength(100)
  house_no?: string;

  @IsOptional()
  @IsString()
  @MaxLength(200)
  street?: string;

  @IsOptional()
  @IsString()
  @MaxLength(100)
  landmark?: string;

  @IsOptional()
  @IsString()
  @MaxLength(100)
  area?: string;

  @IsOptional()
  @IsString()
  @MaxLength(100)
  city?: string;

  @IsOptional()
  @IsString()
  @MaxLength(100)
  state?: string;

  @IsOptional()
  @IsString()
  @Length(6, 6)
  @Matches(/^[1-9][0-9]{5}$/)
  pincode?: string;

  @IsOptional()
  @IsNumber()
  latitude?: number;

  @IsOptional()
  @IsNumber()
  longitude?: number;

  @IsOptional()
  is_default?: boolean;
}
