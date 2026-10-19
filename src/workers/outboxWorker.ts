/**
 * Transactional Outbox Dispatcher Worker — issue #2280
 *
 * Architecture overview
 * ─────────────────────
 * Merchant webhook notifications are inserted into the `outbox_events` table
 * *inside the same database transaction* as the triggering business operation.
 * This worker runs as a background process that:
 *
 *   1. Polls for pending / failed events whose `next_attempt_at <= NOW()`.
 *   2. Claims each batch atomically using `SELECT … FOR UPDATE SKIP LOCKED`
 *      so multiple worker replicas never double-dispatch the same event.
 *   3. POSTs the JSON payload to the merchant's `webhook_url`.
 *   4. Marks events `delivered` on HTTP 2xx, or schedules an exponential
 *      back-off retry on failure (max 5 attempts before marking `dead`).
 *
 * Retry schedule (exponential back-off, seconds):
 *   attempt 1 →   30 s
 *   attempt 2 →   60 s
 *   attempt 3 →  120 s
 *   attempt 4 →  300 s
 *   attempt 5 →  600 s  → then marked `dead`
 *
 * Usage (from index.ts or a dedicated process):
 *   import { startOutboxWorker, stopOutboxWorker } from "./workers/outboxWorker";
 *   const worker = await startOutboxWorker();
 *   // on shutdown:
 *   await stopOutboxWorker(worker);
 */

import https from "https";
import http from "http";
import { URL } from "url";
import logger from "../utils/logger.js";
import { queryWrite } from "../config/database.js";

// ---------------------------------------------------------------------------
// Configuration
// ---------------------------------------------------------------------------

const POLL_INTERVAL_MS = parseInt(
  process.env.OUTBOX_POLL_INTERVAL_MS ?? "5000",
  10,
);

const BATCH_SIZE = parseInt(process.env.OUTBOX_BATCH_SIZE ?? "20", 10);

const REQUEST_TIMEOUT_MS = parseInt(
  process.env.OUTBOX_REQUEST_TIMEOUT_MS ?? "10000",
  10,
);

/** Back-off schedule in seconds, indexed by zero-based attempt number. */
const BACKOFF_SECONDS = [30, 60, 120, 300, 600];

const MAX_ATTEMPTS = BACKOFF_SECONDS.length;

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

interface OutboxEvent {
  id: string;
  merchant_id: string;
  webhook_url: string;
  event_type: string;
  payload: Record<string, unknown>;
  attempts: number;
  max_attempts: number;
}

export interface OutboxWorkerHandle {
  stop: () => void;
}

// ---------------------------------------------------------------------------
// HTTP delivery helper
// ---------------------------------------------------------------------------

interface DeliveryResult {
  statusCode: number;
  responseTimeMs: number;
  error?: string;
}

/**
 * POST `payload` as JSON to `webhookUrl`.
 * Resolves with `{ statusCode, responseTimeMs }` on any HTTP response.
 * Rejects with an `Error` on network / timeout failures.
 */
export function deliverWebhookPayload(
  webhookUrl: string,
  payload: Record<string, unknown>,
  timeoutMs: number = REQUEST_TIMEOUT_MS,
): Promise<DeliveryResult> {
  return new Promise((resolve, reject) => {
    const startMs = Date.now();
    let url: URL;

    try {
      url = new URL(webhookUrl);
    } catch {
      return reject(new Error(`Invalid webhook URL: ${webhookUrl}`));
    }

    const body = JSON.stringify(payload);
    const options = {
      hostname: url.hostname,
      port: url.port || (url.protocol === "https:" ? 443 : 80),
      path: url.pathname + url.search,
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "Content-Length": Buffer.byteLength(body),
        "User-Agent": "mobile-money-outbox/1.0",
      },
    };

    const transport = url.protocol === "https:" ? https : http;
    const req = transport.request(options, (res) => {
      // Drain the response body to free the socket
      res.on("data", () => {});
      res.on("end", () => {
        resolve({
          statusCode: res.statusCode ?? 0,
          responseTimeMs: Date.now() - startMs,
        });
      });
    });

    req.setTimeout(timeoutMs, () => {
      req.destroy();
      reject(new Error(`Webhook request timed out after ${timeoutMs}ms`));
    });

    req.on("error", (err) => reject(err));
    req.write(body);
    req.end();
  });
}

// ---------------------------------------------------------------------------
// Database helpers
// ---------------------------------------------------------------------------

/**
 * Fetch the next batch of events ready for dispatch and lock them atomically.
 * Uses `SKIP LOCKED` so concurrent worker instances skip rows already locked
 * by a sibling.
 */
async function claimBatch(): Promise<OutboxEvent[]> {
  const result = await queryWrite<OutboxEvent>(
    `UPDATE outbox_events
        SET status = 'processing',
            updated_at = NOW()
      WHERE id IN (
        SELECT id FROM outbox_events
         WHERE status IN ('pending', 'failed')
           AND next_attempt_at <= NOW()
         ORDER BY next_attempt_at ASC
         LIMIT $1
           FOR UPDATE SKIP LOCKED
      )
      RETURNING
        id,
        merchant_id,
        webhook_url,
        event_type,
        payload,
        attempts,
        max_attempts`,
    [BATCH_SIZE],
  );

  return result.rows;
}

async function markDelivered(
  id: string,
  httpStatus: number,
  responseTimeMs: number,
): Promise<void> {
  await queryWrite(
    `UPDATE outbox_events
        SET status           = 'delivered',
            delivered_at     = NOW(),
            last_attempt_at  = NOW(),
            last_http_status = $2,
            response_time_ms = $3,
            updated_at       = NOW()
      WHERE id = $1`,
    [id, httpStatus, responseTimeMs],
  );
}

async function scheduleRetry(
  id: string,
  attempts: number,
  httpStatus: number | null,
  errorMessage: string,
): Promise<void> {
  const nextAttempt = attempts + 1;
  const isDead = nextAttempt >= MAX_ATTEMPTS;
  const backoffSecs = BACKOFF_SECONDS[attempts] ?? BACKOFF_SECONDS[BACKOFF_SECONDS.length - 1];

  await queryWrite(
    `UPDATE outbox_events
        SET status           = $2,
            attempts         = $3,
            last_attempt_at  = NOW(),
            next_attempt_at  = NOW() + ($4 || ' seconds')::INTERVAL,
            last_http_status = $5,
            last_error       = $6,
            updated_at       = NOW()
      WHERE id = $1`,
    [
      id,
      isDead ? "dead" : "failed",
      nextAttempt,
      backoffSecs,
      httpStatus,
      errorMessage.slice(0, 2000), // guard against oversized error messages
    ],
  );
}

// ---------------------------------------------------------------------------
// Core dispatch loop
// ---------------------------------------------------------------------------

async function processBatch(): Promise<void> {
  let batch: OutboxEvent[];

  try {
    batch = await claimBatch();
  } catch (err) {
    logger.error(err, "[OutboxWorker] Failed to claim batch from DB");
    return;
  }

  if (batch.length === 0) return;

  logger.info({ count: batch.length }, "[OutboxWorker] Processing batch");

  await Promise.allSettled(
    batch.map(async (event) => {
      let result: DeliveryResult;

      try {
        result = await deliverWebhookPayload(event.webhook_url, {
          event_id: event.id,
          event_type: event.event_type,
          merchant_id: event.merchant_id,
          ...event.payload,
        });
      } catch (networkErr: any) {
        logger.warn(
          { eventId: event.id, error: networkErr.message },
          "[OutboxWorker] Network error — scheduling retry",
        );
        await scheduleRetry(
          event.id,
          event.attempts,
          null,
          networkErr.message ?? "Network error",
        ).catch((dbErr) =>
          logger.error(dbErr, "[OutboxWorker] Failed to schedule retry"),
        );
        return;
      }

      const isSuccess =
        result.statusCode >= 200 && result.statusCode < 300;

      if (isSuccess) {
        logger.info(
          {
            eventId: event.id,
            statusCode: result.statusCode,
            responseTimeMs: result.responseTimeMs,
          },
          "[OutboxWorker] Event delivered",
        );
        await markDelivered(
          event.id,
          result.statusCode,
          result.responseTimeMs,
        ).catch((dbErr) =>
          logger.error(dbErr, "[OutboxWorker] Failed to mark delivered"),
        );
      } else {
        logger.warn(
          {
            eventId: event.id,
            statusCode: result.statusCode,
            attempts: event.attempts,
          },
          "[OutboxWorker] Non-2xx response — scheduling retry",
        );
        await scheduleRetry(
          event.id,
          event.attempts,
          result.statusCode,
          `HTTP ${result.statusCode}`,
        ).catch((dbErr) =>
          logger.error(dbErr, "[OutboxWorker] Failed to schedule retry"),
        );
      }
    }),
  );
}

// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------

/**
 * Start the outbox dispatcher background loop.
 *
 * Returns a handle with a `stop()` method for graceful shutdown.
 */
export async function startOutboxWorker(): Promise<OutboxWorkerHandle> {
  let timer: ReturnType<typeof setTimeout> | null = null;
  let stopped = false;

  async function tick() {
    if (stopped) return;
    try {
      await processBatch();
    } catch (err) {
      logger.error(err, "[OutboxWorker] Unhandled error in tick");
    } finally {
      if (!stopped) {
        timer = setTimeout(tick, POLL_INTERVAL_MS);
      }
    }
  }

  logger.info(
    { pollIntervalMs: POLL_INTERVAL_MS, batchSize: BATCH_SIZE },
    "[OutboxWorker] Starting",
  );

  // Kick off the first tick immediately
  timer = setTimeout(tick, 0);

  return {
    stop() {
      stopped = true;
      if (timer !== null) {
        clearTimeout(timer);
        timer = null;
      }
      logger.info("[OutboxWorker] Stopped");
    },
  };
}

/**
 * Gracefully stop a running outbox worker.
 */
export async function stopOutboxWorker(
  handle: OutboxWorkerHandle,
): Promise<void> {
  handle.stop();
}
