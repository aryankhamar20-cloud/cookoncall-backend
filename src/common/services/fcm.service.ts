import { Injectable, Logger } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import * as crypto from 'crypto';

/**
 * FCM Push Notification Service — Firebase Cloud Messaging HTTP **v1**.
 *
 * The legacy endpoint (https://fcm.googleapis.com/fcm/send with an
 * `Authorization: key=<SERVER_KEY>` header) was shut down by Google in
 * June 2024 and now fails for everyone — this service previously used
 * it, which is why push never delivered. v1 requires an OAuth2 access
 * token minted from a Firebase **service account**.
 *
 * Required env (Firebase console → Project settings → Service accounts
 * → "Generate new private key", then copy three fields out of the JSON):
 *
 *   FIREBASE_PROJECT_ID    e.g. cookoncall-12345
 *   FIREBASE_CLIENT_EMAIL  firebase-adminsdk-xxxxx@<project>.iam.gserviceaccount.com
 *   FIREBASE_PRIVATE_KEY   -----BEGIN PRIVATE KEY-----\n...\n-----END PRIVATE KEY-----\n
 *
 * FIREBASE_PRIVATE_KEY may contain literal "\n" sequences (that's how
 * Railway/most dashboards store multi-line values) — we normalise them.
 *
 * No firebase-admin dependency: we sign the service-account JWT with
 * Node's crypto and exchange it for a short-lived access token, which is
 * cached in memory until shortly before it expires.
 *
 * Every send is fire-and-forget and never throws — a push failure must
 * never break a booking.
 */
@Injectable()
export class FcmService {
  private readonly logger = new Logger(FcmService.name);
  private readonly projectId: string | null;
  private readonly clientEmail: string | null;
  private readonly privateKey: string | null;

  private cachedToken: string | null = null;
  private tokenExpiresAt = 0;

  constructor(private configService: ConfigService) {
    this.projectId = this.configService.get<string>('FIREBASE_PROJECT_ID') || null;
    this.clientEmail = this.configService.get<string>('FIREBASE_CLIENT_EMAIL') || null;
    const rawKey = this.configService.get<string>('FIREBASE_PRIVATE_KEY') || null;
    // Dashboards store the PEM with escaped newlines; restore them.
    this.privateKey = rawKey ? rawKey.replace(/\\n/g, '\n') : null;

    if (!this.isConfigured()) {
      this.logger.warn(
        'Firebase service account not configured (FIREBASE_PROJECT_ID / FIREBASE_CLIENT_EMAIL / FIREBASE_PRIVATE_KEY) — push notifications disabled',
      );
    }
  }

  private isConfigured(): boolean {
    return !!(this.projectId && this.clientEmail && this.privateKey);
  }

  private base64url(input: Buffer | string): string {
    return Buffer.from(input)
      .toString('base64')
      .replace(/\+/g, '-')
      .replace(/\//g, '_')
      .replace(/=+$/, '');
  }

  /**
   * Mint (and cache) a Google OAuth2 access token for the FCM scope by
   * signing a JWT with the service-account private key.
   */
  private async getAccessToken(): Promise<string | null> {
    if (!this.isConfigured()) return null;

    // Reuse while still valid (60s safety margin).
    const now = Math.floor(Date.now() / 1000);
    if (this.cachedToken && now < this.tokenExpiresAt - 60) {
      return this.cachedToken;
    }

    try {
      const header = this.base64url(JSON.stringify({ alg: 'RS256', typ: 'JWT' }));
      const claims = this.base64url(
        JSON.stringify({
          iss: this.clientEmail,
          scope: 'https://www.googleapis.com/auth/firebase.messaging',
          aud: 'https://oauth2.googleapis.com/token',
          iat: now,
          exp: now + 3600,
        }),
      );
      const signingInput = `${header}.${claims}`;
      const signature = this.base64url(
        crypto.sign('RSA-SHA256', Buffer.from(signingInput), this.privateKey as string),
      );
      const assertion = `${signingInput}.${signature}`;

      const res = await fetch('https://oauth2.googleapis.com/token', {
        method: 'POST',
        headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
        body: new URLSearchParams({
          grant_type: 'urn:ietf:params:oauth:grant-type:jwt-bearer',
          assertion,
        }).toString(),
      });

      const body = (await res.json()) as {
        access_token?: string;
        expires_in?: number;
        error_description?: string;
      };

      if (!res.ok || !body.access_token) {
        this.logger.error(
          `FCM auth failed (${res.status}): ${body.error_description ?? JSON.stringify(body)}`,
        );
        return null;
      }

      this.cachedToken = body.access_token;
      this.tokenExpiresAt = now + (body.expires_in ?? 3600);
      return this.cachedToken;
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      this.logger.error(`FCM auth error: ${msg}`);
      return null;
    }
  }

  /**
   * Send a push notification to a single device token.
   * Fire-and-forget — never throws.
   */
  async sendToToken(
    fcmToken: string,
    title: string,
    body: string,
    data?: Record<string, string>,
  ): Promise<void> {
    if (!this.isConfigured() || !fcmToken) return;

    const accessToken = await this.getAccessToken();
    if (!accessToken) return;

    // v1 requires every data value to be a string.
    const stringData: Record<string, string> = {};
    for (const [k, v] of Object.entries(data ?? {})) {
      if (v !== undefined && v !== null) stringData[k] = String(v);
    }

    const message = {
      message: {
        token: fcmToken,
        notification: { title, body },
        data: stringData,
        android: {
          priority: 'HIGH',
          notification: {
            sound: 'default',
            click_action: 'FLUTTER_NOTIFICATION_CLICK',
          },
        },
        apns: {
          headers: { 'apns-priority': '10' },
          payload: { aps: { sound: 'default', badge: 1, 'content-available': 1 } },
        },
      },
    };

    try {
      const res = await fetch(
        `https://fcm.googleapis.com/v1/projects/${this.projectId}/messages:send`,
        {
          method: 'POST',
          headers: {
            'Content-Type': 'application/json',
            Authorization: `Bearer ${accessToken}`,
          },
          body: JSON.stringify(message),
        },
      );

      if (!res.ok) {
        const errBody = await res.text();
        // 404 / UNREGISTERED means the device token is stale — the app
        // will re-register a fresh one on next launch.
        if (res.status === 404 || errBody.includes('UNREGISTERED')) {
          this.logger.debug(`FCM token no longer valid: ${fcmToken.slice(0, 20)}...`);
        } else {
          this.logger.warn(`FCM send failed (${res.status}): ${errBody.slice(0, 300)}`);
        }
      }
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      this.logger.error(`FCM request error: ${msg}`);
    }
  }

  /**
   * Send to many tokens. v1 has no `registration_ids` fan-out, so we
   * send individually with bounded concurrency (keeps a broadcast from
   * opening hundreds of sockets at once).
   */
  async sendToMultiple(
    fcmTokens: string[],
    title: string,
    body: string,
    data?: Record<string, string>,
  ): Promise<void> {
    if (!this.isConfigured() || !fcmTokens.length) return;

    const unique = [...new Set(fcmTokens.filter(Boolean))];
    const CONCURRENCY = 20;
    for (let i = 0; i < unique.length; i += CONCURRENCY) {
      const batch = unique.slice(i, i + CONCURRENCY);
      await Promise.all(batch.map((t) => this.sendToToken(t, title, body, data)));
    }
    this.logger.debug(`FCM batch dispatched to ${unique.length} tokens`);
  }
}
