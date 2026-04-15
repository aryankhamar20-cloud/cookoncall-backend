import {
  Controller,
  Post,
  UploadedFile,
  UseInterceptors,
  BadRequestException,
} from '@nestjs/common';
import { FileInterceptor } from '@nestjs/platform-express';
import { memoryStorage } from 'multer';
import { Throttle } from '@nestjs/throttler';
import { UploadsService } from './uploads.service';

// NOTE: No @Public() decorator here — ALL upload endpoints require a valid JWT.
// The global JwtAuthGuard blocks unauthenticated requests automatically.
// This prevents anonymous users from burning through Cloudinary storage/bandwidth.

@Controller('uploads')
export class UploadsController {
  constructor(private readonly uploadsService: UploadsService) {}

  // General image upload (e.g. used internally)
  // Strict throttle: max 20 uploads per 60s per IP
  @Post('image')
  @Throttle({ strict: [{ ttl: 60000, limit: 20 }] })
  @UseInterceptors(
    FileInterceptor('file', {
      storage: memoryStorage(),
      limits: { fileSize: 5 * 1024 * 1024 }, // 5MB
      fileFilter: (_req, file, cb) => {
        const allowed = ['image/jpeg', 'image/png', 'image/webp'];
        if (!allowed.includes(file.mimetype)) {
          cb(new BadRequestException('Only JPEG, PNG, and WebP files are allowed'), false);
        } else {
          cb(null, true);
        }
      },
    }),
  )
  async uploadImage(@UploadedFile() file: Express.Multer.File) {
    return this.uploadsService.uploadImage(file);
  }

  // Avatar/profile photo upload — customers and chefs
  @Post('avatar')
  @Throttle({ strict: [{ ttl: 60000, limit: 10 }] })
  @UseInterceptors(
    FileInterceptor('file', {
      storage: memoryStorage(),
      limits: { fileSize: 5 * 1024 * 1024 },
      fileFilter: (_req, file, cb) => {
        const allowed = ['image/jpeg', 'image/png', 'image/webp'];
        if (!allowed.includes(file.mimetype)) {
          cb(new BadRequestException('Only JPEG, PNG, and WebP files are allowed'), false);
        } else {
          cb(null, true);
        }
      },
    }),
  )
  async uploadAvatar(@UploadedFile() file: Express.Multer.File) {
    return this.uploadsService.uploadImage(file, 'cookoncall/avatars');
  }

  // Menu item photo upload — chefs only
  @Post('menu')
  @Throttle({ strict: [{ ttl: 60000, limit: 20 }] })
  @UseInterceptors(
    FileInterceptor('file', {
      storage: memoryStorage(),
      limits: { fileSize: 5 * 1024 * 1024 },
      fileFilter: (_req, file, cb) => {
        const allowed = ['image/jpeg', 'image/png', 'image/webp'];
        if (!allowed.includes(file.mimetype)) {
          cb(new BadRequestException('Only JPEG, PNG, and WebP files are allowed'), false);
        } else {
          cb(null, true);
        }
      },
    }),
  )
  async uploadMenuImage(@UploadedFile() file: Express.Multer.File) {
    return this.uploadsService.uploadImage(file, 'cookoncall/menu');
  }

  // Verification document upload — chefs (Aadhaar, PAN, FSSAI, address proof)
  // Most restrictive: max 10 uploads per 60s per IP (sensitive documents)
  @Post('document')
  @Throttle({ strict: [{ ttl: 60000, limit: 10 }] })
  @UseInterceptors(
    FileInterceptor('file', {
      storage: memoryStorage(),
      limits: { fileSize: 5 * 1024 * 1024 },
      fileFilter: (_req, file, cb) => {
        // Documents can also be PDFs
        const allowed = ['image/jpeg', 'image/png', 'image/webp', 'application/pdf'];
        if (!allowed.includes(file.mimetype)) {
          cb(new BadRequestException('Only JPEG, PNG, WebP, and PDF files are allowed'), false);
        } else {
          cb(null, true);
        }
      },
    }),
  )
  async uploadDocument(@UploadedFile() file: Express.Multer.File) {
    return this.uploadsService.uploadImage(file, 'cookoncall/documents');
  }
}
