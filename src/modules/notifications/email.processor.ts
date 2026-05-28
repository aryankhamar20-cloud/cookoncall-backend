import { Process, Processor } from '@nestjs/bull';
import { Logger } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { Job } from 'bull';

/**
 * Email processor — uses Brevo HTTP API (NOT nodemailer/SMTP).
 * Railway blocks outbound SMTP (port 25/587), so we use Brevo's REST API
 * which works over HTTPS port 443 from any host.
 * Free tier: 300 emails/day, any recipient.
 */
@Processor('email')
export class EmailProcessor {
  private readonly logger = new Logger(EmailProcessor.name);
  private readonly brevoApiKey: string;

  constructor(private configService: ConfigService) {
    this.brevoApiKey = this.configService.get<string>('BREVO_API_KEY', '');
  }

  @Process('send-email')
  async handleSendEmail(
    job: Job<{ to: string; subject: string; html: string }>,
  ) {
    const { to, subject, html } = job.data;

    if (!this.brevoApiKey) {
      this.logger.warn(`BREVO_API_KEY not set — skipping queued email to ${to}`);
      return;
    }

    try {
      const response = await fetch('https://api.brevo.com/v3/smtp/email', {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'api-key': this.brevoApiKey,
        },
        body: JSON.stringify({
          sender: { name: 'CookOnCall', email: 'support@thecookoncall.com' },
          to: [{ email: to }],
          subject,
          htmlContent: html,
        }),
      });

      const result = await response.json();

      if (response.ok) {
        this.logger.log(`Queued email sent via Brevo to ${to} — messageId: ${result.messageId}`);
      } else {
        this.logger.error(`Brevo API error for queued email to ${to}: ${JSON.stringify(result)}`);
        throw new Error(`Brevo error ${response.status}: ${JSON.stringify(result)}`);
      }
    } catch (error) {
      this.logger.error(`Queued email failed for ${to}: ${error.message}`);
      throw error; // Bull will retry (3 attempts with exponential backoff)
    }
  }
}
