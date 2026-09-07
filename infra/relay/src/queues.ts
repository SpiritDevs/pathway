import * as Cloudflare from "alchemy/Cloudflare";

export const RelayApnsDeliveryDeadLetterQueue = Cloudflare.Queues.Queue(
  "RelayApnsDeliveryDeadLetterQueue",
);

export const RelayApnsDeliveryQueue = Cloudflare.Queues.Queue("RelayApnsDeliveryQueue");

export const RelayMailDeadLetterQueue = Cloudflare.Queues.Queue("RelayMailDeadLetterQueue");
export const RelayMailQueue = Cloudflare.Queues.Queue("RelayMailQueue");
