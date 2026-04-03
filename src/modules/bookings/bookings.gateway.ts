import {
  WebSocketGateway,
  WebSocketServer,
  SubscribeMessage,
  OnGatewayConnection,
  OnGatewayDisconnect,
  ConnectedSocket,
  MessageBody,
} from '@nestjs/websockets';
import { Logger } from '@nestjs/common';
import { Server, Socket } from 'socket.io';
import { JwtService } from '@nestjs/jwt';
import { ConfigService } from '@nestjs/config';

@WebSocketGateway({
  cors: {
    origin: process.env.FRONTEND_URL || 'http://localhost:3000',
    credentials: true,
  },
  namespace: '/bookings',
})
export class BookingsGateway
  implements OnGatewayConnection, OnGatewayDisconnect
{
  @WebSocketServer()
  server: Server;

  private readonly logger = new Logger(BookingsGateway.name);
  // Map userId -> socketId for targeted emissions
  private userSockets = new Map<string, string>();

  constructor(
    private jwtService: JwtService,
    private configService: ConfigService,
  ) {}

  async handleConnection(client: Socket) {
    try {
      const token =
        client.handshake.auth?.token ||
        client.handshake.headers?.authorization?.replace('Bearer ', '');

      if (!token) {
        client.disconnect();
        return;
      }

      const payload = this.jwtService.verify(token, {
        secret: this.configService.get<string>('JWT_SECRET'),
      });

      // Store the user-socket mapping
      client.data.userId = payload.sub;
      client.data.role = payload.role;
      this.userSockets.set(payload.sub, client.id);

      // Join user-specific room
      client.join(`user:${payload.sub}`);

      this.logger.log(`Client connected: ${payload.sub} (${client.id})`);
    } catch {
      client.disconnect();
    }
  }

  handleDisconnect(client: Socket) {
    if (client.data.userId) {
      this.userSockets.delete(client.data.userId);
      this.logger.log(`Client disconnected: ${client.data.userId}`);
    }
  }

  // ─── COOK JOINS BOOKING ROOM ──────────────────────────
  @SubscribeMessage('join-booking')
  handleJoinBooking(
    @ConnectedSocket() client: Socket,
    @MessageBody() data: { bookingId: string },
  ) {
    client.join(`booking:${data.bookingId}`);
    this.logger.log(
      `${client.data.userId} joined booking:${data.bookingId}`,
    );
  }

  // ─── COOK LOCATION UPDATE ─────────────────────────────
  @SubscribeMessage('cook-location')
  handleCookLocation(
    @ConnectedSocket() client: Socket,
    @MessageBody()
    data: { bookingId: string; latitude: number; longitude: number },
  ) {
    // Broadcast to everyone in the booking room except sender
    client.to(`booking:${data.bookingId}`).emit('cook-location-update', {
      latitude: data.latitude,
      longitude: data.longitude,
      timestamp: new Date().toISOString(),
    });
  }

  // ─── SERVER-SIDE EMIT HELPERS (called from services) ──

  /**
   * Notify a specific user about a booking status change
   */
  emitBookingUpdate(userId: string, booking: any) {
    this.server.to(`user:${userId}`).emit('booking-status-update', {
      booking_id: booking.id,
      status: booking.status,
      updated_at: new Date().toISOString(),
    });
  }

  /**
   * Notify both user and cook about a new booking
   */
  emitNewBooking(userId: string, cookUserId: string, booking: any) {
    this.server.to(`user:${cookUserId}`).emit('new-booking-request', {
      booking_id: booking.id,
      user_name: booking.user?.name,
      scheduled_at: booking.scheduled_at,
      total_price: booking.total_price,
    });

    this.server.to(`user:${userId}`).emit('booking-created', {
      booking_id: booking.id,
      status: booking.status,
    });
  }

  /**
   * Send a generic notification to a user
   */
  emitNotification(userId: string, notification: any) {
    this.server.to(`user:${userId}`).emit('notification', notification);
  }
}
