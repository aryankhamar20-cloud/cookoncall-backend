import { Injectable, Logger } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';

/**
 * ✅ P1: Firebase Cloud Messaging service.
 *
 * Sends push notifications to mobile devices via FCM HTTP v1 API.
 * Uses Firebase Admin SDK (firebase-admin package).
 *
 * Setup: Set FIREBASE_SERVICE_ACCOUNT_KEY env var with base64-encoded
 * service account JSON from Firebase Console.
 *
 * Falls back gracefully (logs only) if Firebase is not configured —
 * so app works without FCM in development.
 */
@Injectable()
export class FcmService {
  private readonly logger = new Logger(FcmService.name);
  private admin: any = null;
  private initialized = false;

  constructor(private readonly configService: ConfigService) {
    this.init();
  }

  private init() {
    const serviceAccountKey = this.configService.get<string>(
      'FIREBASE_SERVICE_ACCOUNT_KEY',
    );

    if (!serviceAccountKey) {
      this.logger.warn(
        'FIREBASE_SERVICE_ACCOUNT_KEY not set — push notifications disabled',
      );
      return;
    }

    try {
      // Dynamic import to avoid hard crash if firebase-admin not installed
      // eslint-disable-next-line @typescript-eslint/no-var-requires
      const firebaseAdmin = require('firebase-admin');

      if (firebaseAdmin.apps.length === 0) {
        const serviceAccount = JSON.parse(
          Buffer.from(serviceAccountKey, 'base64').toString('utf8'),
        );
        firebaseAdmin.initializeApp({
          credential: firebaseAdmin.credential.cert(serviceAccount),
        });
      }

      this.admin = firebaseAdmin;
      this.initialized = true;
      this.logger.log('Firebase Admin SDK initialized');
    } catch (err) {
      this.logger.warn(
        `Failed to initialize Firebase: ${(err as Error).message}`,
      );
    }
  }

  /**
   * Send a push notification to a single device.
   * Silently skips if FCM not initialized or token is missing.
   */
  async sendToDevice(
    fcmToken: string,
    notification: { title: string; body: string },
    data?: Record<string, string>,
  ): Promise<void> {
    if (!this.initialized || !this.admin || !fcmToken) return;

    try {
      await this.admin.messaging().send({
        token: fcmToken,
        notification: {
          title: notification.title,
          body: notification.body,
        },
        data: data || {},
        android: {
          priority: 'high',
          notification: {
            sound: 'default',
            channelId: 'cookoncall_default',
          },
        },
        apns: {
          payload: {
            aps: {
              sound: 'default',
              badge: 1,
            },
          },
        },
      });

      this.logger.log(`Push sent to device: ${notification.title}`);
    } catch (err) {
      // Don't crash on stale tokens — log and continue
      this.logger.warn(`FCM send failed: ${(err as Error).message}`);
    }
  }

  /**
   * Send to multiple devices (multicast).
   * Automatically handles up to 500 tokens per batch.
   */
  async sendToMultiple(
    fcmTokens: string[],
    notification: { title: string; body: string },
    data?: Record<string, string>,
  ): Promise<void> {
    if (!this.initialized || !this.admin || !fcmTokens.length) return;

    const validTokens = fcmTokens.filter((t) => !!t);
    if (!validTokens.length) return;

    try {
      const response = await this.admin.messaging().sendEachForMulticast({
        tokens: validTokens,
        notification: {
          title: notification.title,
          body: notification.body,
        },
        data: data || {},
        android: { priority: 'high' },
      });

      this.logger.log(
        `Multicast push: ${response.successCount}/${validTokens.length} delivered`,
      );
    } catch (err) {
      this.logger.warn(`FCM multicast failed: ${(err as Error).message}`);
    }
  }
}
