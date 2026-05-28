import { Injectable, Logger } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';

/**
 * FCM Push Notification Service (HTTP v1 API — no firebase-admin SDK needed).
 *
 * Uses Firebase Cloud Messaging HTTP v1 API with a server key.
 * Falls back gracefully if FCM_SERVER_KEY is not configured.
 *
 * Usage:
 *   await this.fcmService.sendToToken(fcmToken, 'Title', 'Body', { booking_id: '...' });
 */
@Injectable()
export class FcmService {
  private readonly logger = new Logger(FcmService.name);
  private readonly serverKey: string | null;

  constructor(private configService: ConfigService) {
    this.serverKey = this.configService.get<string>('FCM_SERVER_KEY') || null;
    if (!this.serverKey) {
      this.logger.warn('FCM_SERVER_KEY not configured — push notifications disabled');
    }
  }

  /**
   * Send a push notification to a single device token.
   * Fire-and-forget — never throws, logs errors.
   */
  async sendToToken(
    fcmToken: string,
    title: string,
    body: string,
    data?: Record<string, string>,
  ): Promise<void> {
    if (!this.serverKey || !fcmToken) return;

    const payload = {
      to: fcmToken,
      notification: {
        title,
        body,
        sound: 'default',
        badge: '1',
        click_action: 'FLUTTER_NOTIFICATION_CLICK',
      },
      data: data || {},
      priority: 'high',
      content_available: true,
    };

    try {
      const response = await fetch('https://fcm.googleapis.com/fcm/send', {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          Authorization: `key=${this.serverKey}`,
        },
        body: JSON.stringify(payload),
      });

      const result = await response.json();

      if (!response.ok || result.failure > 0) {
        this.logger.warn(
          `FCM send failed for token ${fcmToken.slice(0, 20)}...: ${JSON.stringify(result)}`,
        );
      } else {
        this.logger.debug(`FCM sent to ${fcmToken.slice(0, 20)}... — messageId: ${result.results?.[0]?.message_id}`);
      }
    } catch (err) {
      this.logger.error(`FCM request error: ${err.message}`);
    }
  }

  /**
   * Send a push notification to multiple device tokens (up to 1000).
   */
  async sendToMultiple(
    fcmTokens: string[],
    title: string,
    body: string,
    data?: Record<string, string>,
  ): Promise<void> {
    if (!this.serverKey || !fcmTokens.length) return;

    const payload = {
      registration_ids: fcmTokens,
      notification: {
        title,
        body,
        sound: 'default',
        badge: '1',
        click_action: 'FLUTTER_NOTIFICATION_CLICK',
      },
      data: data || {},
      priority: 'high',
      content_available: true,
    };

    try {
      const response = await fetch('https://fcm.googleapis.com/fcm/send', {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          Authorization: `key=${this.serverKey}`,
        },
        body: JSON.stringify(payload),
      });

      const result = await response.json();

      if (!response.ok) {
        this.logger.warn(`FCM batch send failed: ${JSON.stringify(result)}`);
      } else {
        this.logger.debug(
          `FCM batch: ${result.success} success, ${result.failure} failure of ${fcmTokens.length} tokens`,
        );
      }
    } catch (err) {
      this.logger.error(`FCM batch request error: ${err.message}`);
    }
  }
}
