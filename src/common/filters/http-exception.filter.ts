import {
  ExceptionFilter,
  Catch,
  ArgumentsHost,
  HttpException,
  HttpStatus,
  Logger,
} from '@nestjs/common';
import { Request, Response } from 'express';

@Catch()
export class HttpExceptionFilter implements ExceptionFilter {
  private readonly logger = new Logger(HttpExceptionFilter.name);

  catch(exception: unknown, host: ArgumentsHost) {
    const ctx = host.switchToHttp();
    const response = ctx.getResponse<Response>();
    const request = ctx.getRequest<Request>();

    let status = HttpStatus.INTERNAL_SERVER_ERROR;
    let message = 'Internal server error';
    let errors: any = null;

    if (exception instanceof HttpException) {
      status = exception.getStatus();
      const exceptionResponse = exception.getResponse();

      if (typeof exceptionResponse === 'string') {
        message = exceptionResponse;
      } else if (typeof exceptionResponse === 'object') {
        const resp = exceptionResponse as any;
        message = resp.message || resp.error || message;
        errors = resp.errors || null;

        // ValidationPipe returns array of messages
        if (Array.isArray(message)) {
          errors = message;
          message = 'Validation failed';
        }
      }
    } else if (exception instanceof Error) {
      // Log the real error server-side for debugging
      this.logger.error(
        `Unhandled error on ${request.method} ${request.url}: ${exception.message}`,
        exception.stack,
      );
      // NEVER leak raw DB / runtime errors to the client.
      // Common offenders: TypeORM QueryFailedError ("column X does not exist"),
      // EntityNotFoundError, raw Postgres errors, network errors.
      const isInternal =
        /QueryFailed|TypeORM|EntityNotFound|column .* does not exist|relation .* does not exist|ECONN|ETIMEDOUT|ENOTFOUND/i.test(
          exception.message,
        );
      message = isInternal
        ? 'Something went wrong on our end. Please try again in a moment.'
        : exception.message;
    }

    response.status(status).json({
      success: false,
      statusCode: status,
      message,
      errors,
      timestamp: new Date().toISOString(),
      path: request.url,
    });
  }
}
