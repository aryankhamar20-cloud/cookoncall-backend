import { Process, Processor } from '@nestjs/bull';
import { Logger } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { Job } from 'bull';
import * as nodemailer from 'nodemailer';

@Processor('email')
export class EmailProcessor {
  private readonly logger = new Logger(EmailProcessor.name);
  private transporter: nodemailer.Transporter;

  constructor(private configService: ConfigService) {
    this.transporter = nodemailer.createTransport({
      host: this.configService.get<string>('SMTP_HOST', 'smtp.gmail.com'),
      port: this.configService.get<number>('SMTP_PORT', 587),
      secure: false,
      auth: {
        user: this.configService.get<string>('SMTP_USER'),
        pass: this.configService.get<string>('SMTP_PASS'),
      },
    });
  }

  @Process('send-email')
  async handleSendEmail(
    job: Job<{ to: string; subject: string; html: string }>,
  ) {
    const { to, subject, html } = job.data;

    try {
      await this.transporter.sendMail({
        from: `"CookOnCall" <${this.configService.get<string>('SMTP_FROM', 'noreply@cookoncall.in')}>`,
        to,
        subject,
        html,
      });

      this.logger.log(`Email sent to ${to}: ${subject}`);
    } catch (error) {
      this.logger.error(`Email send failed to ${to}`, error);
      throw error; // Bull will retry
    }
  }
}
