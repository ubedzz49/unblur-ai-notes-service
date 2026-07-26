import Queue from "bull";

export const QUEUE_NAME = "ai-notes-delivery";

export interface DeliveryJobData {
  deliveryId: string;
  providerRoomId?: string;
}

// reuses doubt-service's ElastiCache Redis connection env-var pattern (host/port/auth/tls) --
// same cluster, new queue name, so this doesn't need its own Redis instance provisioned
export function buildDeliveryQueue(): Queue.Queue<DeliveryJobData> {
  return new Queue<DeliveryJobData>(QUEUE_NAME, {
    redis: {
      host: process.env.REDIS_HOST,
      port: Number(process.env.REDIS_PORT ?? 6379),
      password: process.env.REDIS_AUTH_TOKEN,
      tls: process.env.REDIS_TLS === "true" ? {} : undefined,
    },
  });
}
