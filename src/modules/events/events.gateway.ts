import {
  WebSocketGateway,
  WebSocketServer,
  OnGatewayConnection,
  OnGatewayDisconnect,
  OnGatewayInit,
  SubscribeMessage,
  MessageBody,
  ConnectedSocket,
} from '@nestjs/websockets';
import { Server, Socket } from 'socket.io';
import { Logger } from '@nestjs/common';
import { JwtService } from '@nestjs/jwt';
import { ConfigService } from '@nestjs/config';

export enum WsEvent {
  // Booking lifecycle
  BOOKING_CREATED      = 'booking:created',
  BOOKING_ACCEPTED     = 'booking:accepted',
  BOOKING_REJECTED     = 'booking:rejected',
  BOOKING_PAID         = 'booking:paid',
  BOOKING_STARTED      = 'booking:started',
  BOOKING_COMPLETED    = 'booking:completed',
  BOOKING_CANCELLED    = 'booking:cancelled',
  BOOKING_EXPIRED      = 'booking:expired',
  // Notifications
  NOTIFICATION_NEW     = 'notification:new',
  // Round 4 / Analytics Phase 2 — live admin telemetry
  // Emitted only to the `admin:lobby` room every few seconds.
  ADMIN_LIVE_COUNTERS  = 'admin:live-counters',
  ADMIN_LIVE_BOOKING   = 'admin:live-booking',
}

@WebSocketGateway({
  cors: {
    origin: [
      process.env.FRONTEND_URL || 'http://localhost:3000',
      'https://thecookoncall.com',
      'https://www.thecookoncall.com',
      'https://cookoncall.pages.dev',
      /\.cookoncall\.pages\.dev$/,
    ],
    credentials: true,
  },
  namespace: '/events',
})
export class EventsGateway
  implements OnGatewayInit, OnGatewayConnection, OnGatewayDisconnect
{
  @WebSocketServer()
  server: Server;

  private readonly logger = new Logger(EventsGateway.name);

  // Map of userId → Set of socket IDs (one user can have multiple tabs/devices)
  private userSockets = new Map<string, Set<string>>();

  // Round 4 / Analytics Phase 2 — track admin sockets separately so
  // the live-counter cron can emit only to admin clients (avoid waking
  // every connected customer's tab every 5s).
  private adminSocketIds = new Set<string>();

  constructor(
    private jwtService: JwtService,
    private configService: ConfigService,
  ) {}

  afterInit() {
    this.logger.log('WebSocket Events Gateway initialized at /events');
  }

  async handleConnection(client: Socket) {
    try {
      const token =
        (client.handshake.auth?.token as string) ||
        (client.handshake.headers?.authorization as string)?.replace('Bearer ', '');

      if (!token) {
        client.disconnect();
        return;
      }

      const payload = this.jwtService.verify(token, {
        secret: this.configService.get<string>('JWT_SECRET'),
      });

      const userId: string = payload.sub;
      const role: string | undefined = payload.role;
      (client as any).userId = userId;
      (client as any).role = role;

      // Register socket in user room
      if (!this.userSockets.has(userId)) {
        this.userSockets.set(userId, new Set());
      }
      this.userSockets.get(userId)!.add(client.id);

      // Join personal room
      await client.join(`user:${userId}`);

      // Round 4 / Analytics Phase 2 — admins also join the lobby so
      // the live-counters cron can fan-out efficiently. Customers
      // and chefs intentionally do NOT join.
      if (role === 'admin') {
        this.adminSocketIds.add(client.id);
        await client.join('admin:lobby');
      }

      this.logger.debug(`Client connected: ${client.id} (userId: ${userId}, role: ${role ?? 'unknown'})`);
      client.emit('connected', { userId, role: role ?? null, socketId: client.id });
    } catch {
      this.logger.warn(`Unauthorized WS connection attempt: ${client.id}`);
      client.disconnect();
    }
  }

  handleDisconnect(client: Socket) {
    const userId = (client as any).userId;
    if (userId && this.userSockets.has(userId)) {
      this.userSockets.get(userId)!.delete(client.id);
      if (this.userSockets.get(userId)!.size === 0) {
        this.userSockets.delete(userId);
      }
    }
    this.adminSocketIds.delete(client.id);
    this.logger.debug(`Client disconnected: ${client.id}`);
  }

  // ─── Client can ping to check connection ─────────────
  @SubscribeMessage('ping')
  handlePing(@ConnectedSocket() client: Socket, @MessageBody() data: any) {
    client.emit('pong', { ts: Date.now(), echo: data });
  }

  // ═══════════════════════════════════════════════════════
  // PUBLIC EMIT METHODS (called from services)
  // ═══════════════════════════════════════════════════════

  /** Emit an event to a specific user (all their connected devices) */
  emitToUser(userId: string, event: WsEvent, payload: Record<string, any>): void {
    this.server.to(`user:${userId}`).emit(event, {
      ...payload,
      ts: new Date().toISOString(),
    });
  }

  /** Emit a booking status change to both customer and chef */
  emitBookingUpdate(
    customerUserId: string,
    cookUserId: string,
    event: WsEvent,
    payload: Record<string, any>,
  ): void {
    const data = { ...payload, ts: new Date().toISOString() };
    this.server.to(`user:${customerUserId}`).emit(event, data);
    if (cookUserId !== customerUserId) {
      this.server.to(`user:${cookUserId}`).emit(event, data);
    }
  }

  /** Emit a new in-app notification to a user */
  emitNotification(
    userId: string,
    notification: {
      id: string;
      title: string;
      message: string;
      type: string;
      metadata?: Record<string, any>;
    },
  ): void {
    this.emitToUser(userId, WsEvent.NOTIFICATION_NEW, notification);
  }

  /** Check if a user currently has any active WS connections */
  isUserOnline(userId: string): boolean {
    const sockets = this.userSockets.get(userId);
    return !!sockets && sockets.size > 0;
  }

  /** Get count of currently connected users */
  getConnectedUsersCount(): number {
    return this.userSockets.size;
  }

  /** Get count of currently connected admin sockets (NOT users —
   *  multiple tabs from the same admin count separately because each
   *  tab is consuming live telemetry independently). */
  getConnectedAdminSocketsCount(): number {
    return this.adminSocketIds.size;
  }

  // ─── Live admin telemetry (Analytics Phase 2) ─────────
  /**
   * Push the current live-counter snapshot to every admin tab.
   * Called by AnalyticsRealtimeService on a 5s cron. Cheap because
   * Socket.IO only serialises to the rooms that have members — when
   * no admin is online this is a no-op.
   */
  emitLiveCounters(payload: Record<string, any>): void {
    this.server.to('admin:lobby').emit(WsEvent.ADMIN_LIVE_COUNTERS, {
      ...payload,
      ts: new Date().toISOString(),
    });
  }

  /**
   * Push a single new booking to the admin live-feed. Called from
   * BookingsService whenever a booking is created so the admin sees
   * it stream in without polling.
   */
  emitLiveBooking(booking: Record<string, any>): void {
    this.server.to('admin:lobby').emit(WsEvent.ADMIN_LIVE_BOOKING, {
      ...booking,
      ts: new Date().toISOString(),
    });
  }
}
