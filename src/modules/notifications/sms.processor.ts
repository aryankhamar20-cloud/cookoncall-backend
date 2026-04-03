import { Process, Processor } from '@nestjs/bull';
import { Logger } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { Job } from 'bull';

@Processor('sms')
export class SmsProcessor {
  private readonly logger = new Logger(SmsProcessor.name);

  constructor(private configService: ConfigService) {}

  @Process('send-sms')
  async handleSendSms(job: Job<{ phone: string; message: string }>) {
    const { phone, message } = job.data;
    const authKey = this.configService.get<string>('MSG91_AUTH_KEY');

    if (!authKey) {
      this.logger.warn(`MSG91 not configured. SMS to ${phone}: ${message}`);
      return;
    }

    try {
      const response = await fetch('https://control.msg91.com/api/v5/flow/', {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          authkey: authKey,
        },
        body: JSON.stringify({
          template_id: this.configService.get<string>(
            'MSG91_SMS_TEMPLATE_ID',
          ),
          short_url: '0',
          recipients: [
            {
              mobiles: `91${phone}`,
              message,
            },
          ],
        }),
      });

      const data = await response.json();
      this.logger.log(`SMS sent to ${phone}: ${JSON.stringify(data)}`);
    } catch (error) {
      this.logger.error(`SMS send failed to ${phone}`, error);
      throw error; // Bull will retry
    }
  }
}
