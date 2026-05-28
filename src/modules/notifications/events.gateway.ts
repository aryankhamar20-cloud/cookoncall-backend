import {
  WebSocketGateway,
  WebSocketServer,
  OnGatewayConnection,
  OnGatewayDisconnect,
  SubscribeMessage,
  MessageBody,
  ConnectedSocket,
} from '@nestjs/websockets';
import { Server, Socket } from 'socket.io';
import { Logger } from '@nestjs/common';
import { JwtService } from '@nestjs/jwt';
import { ConfigService } from '@nestjs/config';

/**
 * ✅ P1: WebSocket gateway for real-time booking status updates.
 *
 * Clients connect with JWT token (query param or auth header).
 * On connection, they join a room keyed by their userId.
 *
 * Events emitted to clients:
 * - booking:status_changed  { bookingId, status, message }
 * - booking:chef_accepted   { bookingId, chefName }
 * - booking:chef_rejected   { bookingId }
 * - booking:confirmed       { bookingId, chefName }
 * - booking:session_started { bookingId }
 * - booking:session_ended   { bookingId }
 * - booking:expired         { bookingId }
 * - notification:new        { id, type, title, message }
 *
 * Flutter client connects using socket_io_client with:
 *   - auth: { token: '<jwt>' }
 *   - transports: ['websocket']
 */
@WebSocketGateway({
  cors: {
    origin: [
      'http://localhost:3000',
      'https://thecookoncall.com',
      'https://www.thecookoncall.com',
      'https://cookoncall.pages.dev',
      /\.cookoncall\.pages\.dev$/,
    ],
    credentials: true,
  },
  namespace: '/',
})
export class EventsGateway implements OnGatewayConnection, OnGatewayDisconnect {
  @WebSocketServer()
  server: Server;

  private readonly logger = new Logger(EventsGateway.name);

  // Map: userId → Set of socketIds (one user may have multiple devices)
  private readonly userSockets = new Map<string, Set<string>>();

  constructor(
    private readonly jwtService: JwtService,
    private readonly configService: ConfigService,
  ) {}

  // ─── CONNECTION HANDLING ──────────────────────────────

  async handleConnection(client: Socket) {
    try {
      const token =
        client.handshake.auth?.token ||
        client.handshake.headers?.authorization?.replace('Bearer ', '');

      if (!token) {
        this.logger.warn(`WS: No token, disconnecting ${client.id}`);
        client.disconnect();
        return;
      }

      const payload = this.jwtService.verify(token, {
        secret: this.configService.get<string>('JWT_SECRET'),
      });

      const userId: string = payload.sub;

      // Store mapping
      if (!this.userSockets.has(userId)) {
        this.userSockets.set(userId, new Set());
      }
      this.userSockets.get(userId)!.add(client.id);

      // Join user-specific room
      client.join(`user:${userId}`);
      client.data.userId = userId;

      this.logger.log(`WS: User ${userId} connected (socket ${client.id})`);

      // Confirm connection
      client.emit('connected', { userId, socketId: client.id });
    } catch {
      this.logger.warn(`WS: Invalid token, disconnecting ${client.id}`);
      client.disconnect();
    }
  }

  handleDisconnect(client: Socket) {
    const userId = client.data?.userId;
    if (userId) {
      const sockets = this.userSockets.get(userId);
      if (sockets) {
        sockets.delete(client.id);
        if (sockets.size === 0) {
          this.userSockets.delete(userId);
        }
      }
      this.logger.log(`WS: User ${userId} disconnected (socket ${client.id})`);
    }
  }

  // ─── CLIENT → SERVER MESSAGES ─────────────────────────

  @SubscribeMessage('ping')
  handlePing(@ConnectedSocket() client: Socket) {
    client.emit('pong', { timestamp: Date.now() });
  }

  // ─── SERVER → CLIENT EMITTERS ─────────────────────────

  /**
   * Emit booking status change to all devices of a user.
   * Called by BookingsService after any status transition.
   */
  emitBookingStatusChanged(
    userId: string,
    bookingId: string,
    status: string,
    message: string,
  ) {
    this.server.to(`user:${userId}`).emit('booking:status_changed', {
      bookingId,
      status,
      message,
      timestamp: Date.now(),
    });
    this.logger.log(`WS: booking:status_changed → user ${userId} (${status})`);
  }

  emitChefAccepted(customerUserId: string, bookingId: string, chefName: string) {
    this.server.to(`user:${customerUserId}`).emit('booking:chef_accepted', {
      bookingId,
      chefName,
      message: `${chefName} accepted your booking! Please pay within 3 hours.`,
      timestamp: Date.now(),
    });
  }

  emitChefRejected(customerUserId: string, bookingId: string) {
    this.server.to(`user:${customerUserId}`).emit('booking:chef_rejected', {
      bookingId,
      message: 'The chef was unable to accept your booking. You can book another chef.',
      timestamp: Date.now(),
    });
  }

  emitBookingConfirmed(customerUserId: string, bookingId: string, chefName: string) {
    this.server.to(`user:${customerUserId}`).emit('booking:confirmed', {
      bookingId,
      chefName,
      message: `Your booking with ${chefName} is confirmed!`,
      timestamp: Date.now(),
    });
  }

  emitSessionStarted(customerUserId: string, bookingId: string, chefName: string) {
    this.server.to(`user:${customerUserId}`).emit('booking:session_started', {
      bookingId,
      chefName,
      message: `${chefName} has started cooking!`,
      timestamp: Date.now(),
    });
  }

  emitSessionCompleted(customerUserId: string, cookUserId: string, bookingId: string) {
    // Notify customer
    this.server.to(`user:${customerUserId}`).emit('booking:session_ended', {
      bookingId,
      message: 'Cooking session complete! Please leave a review.',
      timestamp: Date.now(),
    });
    // Notify chef
    this.server.to(`user:${cookUserId}`).emit('booking:session_ended', {
      bookingId,
      message: 'Session complete. Earnings will be credited to your account.',
      timestamp: Date.now(),
    });
  }

  emitBookingExpired(userId: string, bookingId: string, who: 'chef' | 'customer') {
    const message =
      who === 'chef'
        ? 'A booking expired because you did not respond in time.'
        : 'Your booking expired — payment was not completed in time.';
    this.server.to(`user:${userId}`).emit('booking:expired', {
      bookingId,
      message,
      timestamp: Date.now(),
    });
  }

  /**
   * Emit a new in-app notification to a user's connected devices.
   * Called after creating a Notification record.
   */
  emitNewNotification(
    userId: string,
    notification: {
      id: string;
      type: string;
      title: string;
      message: string;
    },
  ) {
    this.server.to(`user:${userId}`).emit('notification:new', {
      ...notification,
      timestamp: Date.now(),
    });
  }

  /** Returns number of connected devices for a user */
  getConnectedDevices(userId: string): number {
    return this.userSockets.get(userId)?.size ?? 0;
  }

  /** Returns total connected sockets */
  getTotalConnections(): number {
    let total = 0;
    for (const sockets of this.userSockets.values()) {
      total += sockets.size;
    }
    return total;
  }
}
