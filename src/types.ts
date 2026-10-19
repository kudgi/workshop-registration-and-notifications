export type NotificationType = 'CONFIRMATION' | 'CANCELLATION';
export type NotificationStatus = 'PENDING' | 'IN_PROGRESS' | 'SENT' | 'DEAD';

export interface NotificationPayload {
  subject: string;
  message: string;
  workshopId: string;
  memberId: string;
}

export interface Notification {
  id: number;
  idempotencyKey: string;
  type: NotificationType;
  recipient: string;
  payload: NotificationPayload;
  status: NotificationStatus;
  attempts: number;
  nextAttemptAt: string;
  lockedUntil: string | null;
  lastError: string | null;
  createdAt: string;
  sentAt: string | null;
}

export interface Registration {
  id: number;
  workshopId: string;
  memberId: string;
  email: string;
  createdAt: string;
}

export interface Workshop {
  id: string;
  title: string;
  description: string;
  capacity: number | null;
  startsAt: string;
  cancelled: boolean;
  createdAt: string;
}
