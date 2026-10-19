/**
 * Unit and integration-style tests for the outbox worker — issue #2280
 *
 * The DB and HTTP layer are fully mocked so tests run without infrastructure.
 */

import http from "http";
import { EventEmitter } from "events";
import { deliverWebhookPayload } from "../outboxWorker";

// ---------------------------------------------------------------------------
// Mock database
// ---------------------------------------------------------------------------

jest.mock("../../config/database", () => ({
  queryWrite: jest.fn(),
}));

// ---------------------------------------------------------------------------
// HTTP delivery helper tests
// ---------------------------------------------------------------------------

describe("deliverWebhookPayload", () => {
  afterEach(() => jest.restoreAllMocks());

  /**
   * Build a minimal mock of http.ClientRequest / IncomingMessage to simulate
   * a successful HTTP response without opening a real socket.
   */
  function mockHttpRequest(statusCode: number) {
    // Create a fake IncomingMessage
    const responseEmitter = new EventEmitter() as any;
    responseEmitter.statusCode = statusCode;

    // Create a fake ClientRequest
    const requestEmitter = new EventEmitter() as any;
    requestEmitter.write = jest.fn();
    requestEmitter.end = jest.fn(() => {
      // Simulate async response
      setImmediate(() => {
        const callback = (requestEmitter as any)._responseCallback;
        if (callback) callback(responseEmitter);
        // Emit 'end' on response
        setImmediate(() => responseEmitter.emit("end"));
      });
    });
    requestEmitter.setTimeout = jest.fn();

    return { requestEmitter, responseEmitter };
  }

  it("resolves with statusCode 200 on a successful delivery", async () => {
    const { requestEmitter } = mockHttpRequest(200);

    const requestSpy = jest
      .spyOn(http, "request")
      .mockImplementation(((_opts: any, cb: any) => {
        (requestEmitter as any)._responseCallback = cb;
        return requestEmitter;
      }) as any);

    const result = await deliverWebhookPayload(
      "http://merchant.example.com/webhook",
      { event_type: "transaction.completed", id: "txn-1" },
    );

    expect(result.statusCode).toBe(200);
    expect(result.responseTimeMs).toBeGreaterThanOrEqual(0);
    requestSpy.mockRestore();
  });

  it("resolves with a non-2xx status code on a failed delivery", async () => {
    const { requestEmitter } = mockHttpRequest(500);

    const requestSpy = jest
      .spyOn(http, "request")
      .mockImplementation(((_opts: any, cb: any) => {
        (requestEmitter as any)._responseCallback = cb;
        return requestEmitter;
      }) as any);

    const result = await deliverWebhookPayload(
      "http://merchant.example.com/webhook",
      { event_type: "transaction.failed" },
    );

    expect(result.statusCode).toBe(500);
    requestSpy.mockRestore();
  });

  it("rejects with an error on network failure", async () => {
    const requestEmitter = new EventEmitter() as any;
    requestEmitter.write = jest.fn();
    requestEmitter.end = jest.fn(() => {
      setImmediate(() => requestEmitter.emit("error", new Error("ECONNREFUSED")));
    });
    requestEmitter.setTimeout = jest.fn();

    const requestSpy = jest
      .spyOn(http, "request")
      .mockImplementation(() => requestEmitter as any);

    await expect(
      deliverWebhookPayload(
        "http://merchant.example.com/webhook",
        { event_type: "test" },
      ),
    ).rejects.toThrow("ECONNREFUSED");

    requestSpy.mockRestore();
  });

  it("rejects with a timeout error when the request times out", async () => {
    const requestEmitter = new EventEmitter() as any;
    requestEmitter.write = jest.fn();
    requestEmitter.end = jest.fn(); // never resolves
    requestEmitter.destroy = jest.fn(() => {
      setImmediate(() => requestEmitter.emit("error", new Error("socket hang up")));
    });
    requestEmitter.setTimeout = jest.fn((_ms: number, cb: () => void) => {
      setImmediate(cb); // fire timeout immediately
    });

    const requestSpy = jest
      .spyOn(http, "request")
      .mockImplementation(() => requestEmitter as any);

    await expect(
      deliverWebhookPayload(
        "http://merchant.example.com/webhook",
        { event_type: "test" },
        1, // 1 ms timeout
      ),
    ).rejects.toThrow(/timed out/);

    requestSpy.mockRestore();
  });

  it("rejects immediately for an invalid URL", async () => {
    await expect(
      deliverWebhookPayload("not-a-url", { event: "test" }),
    ).rejects.toThrow(/Invalid webhook URL/);
  });
});

// ---------------------------------------------------------------------------
// startOutboxWorker / stopOutboxWorker lifecycle
// ---------------------------------------------------------------------------

describe("OutboxWorker lifecycle", () => {
  beforeEach(() => {
    jest.useFakeTimers();
  });

  afterEach(() => {
    jest.useRealTimers();
    jest.resetAllMocks();
  });

  it("starts and stops without errors", async () => {
    const { queryWrite } = require("../../config/database");
    // Return an empty batch so no HTTP calls are made
    queryWrite.mockResolvedValue({ rows: [] });

    const { startOutboxWorker, stopOutboxWorker } = await import("../outboxWorker");

    const worker = await startOutboxWorker();
    expect(worker).toHaveProperty("stop");

    await stopOutboxWorker(worker);
    // No errors thrown
  });

  it("stop() prevents further ticks from running", async () => {
    const { queryWrite } = require("../../config/database");
    queryWrite.mockResolvedValue({ rows: [] });

    const { startOutboxWorker, stopOutboxWorker } = await import("../outboxWorker");

    const worker = await startOutboxWorker();
    await stopOutboxWorker(worker);

    const callsBefore = queryWrite.mock.calls.length;

    // Advance timers — no new ticks should fire after stop
    jest.advanceTimersByTime(60_000);

    expect(queryWrite.mock.calls.length).toBe(callsBefore);
  });
});

// ---------------------------------------------------------------------------
// Retry logic (verifying DB update calls)
// ---------------------------------------------------------------------------

describe("OutboxWorker retry logic", () => {
  afterEach(() => {
    jest.resetAllMocks();
    jest.restoreAllMocks();
  });

  it("marks event as delivered on HTTP 200", async () => {
    const { queryWrite } = require("../../config/database");

    // First call = claimBatch, second call = markDelivered
    queryWrite
      .mockResolvedValueOnce({
        rows: [
          {
            id: "evt-1",
            merchant_id: "m-1",
            webhook_url: "http://example.com/hook",
            event_type: "transaction.completed",
            payload: {},
            attempts: 0,
            max_attempts: 5,
          },
        ],
      })
      .mockResolvedValueOnce({ rows: [] }); // markDelivered

    // Mock HTTP to return 200
    const { requestEmitter, responseEmitter } = (() => {
      const responseEmitter = new EventEmitter() as any;
      responseEmitter.statusCode = 200;
      const requestEmitter = new EventEmitter() as any;
      requestEmitter.write = jest.fn();
      requestEmitter.end = jest.fn(() => {
        setImmediate(() => {
          const cb = (requestEmitter as any)._cb;
          if (cb) cb(responseEmitter);
          setImmediate(() => responseEmitter.emit("end"));
        });
      });
      requestEmitter.setTimeout = jest.fn();
      return { requestEmitter, responseEmitter };
    })();

    jest
      .spyOn(http, "request")
      .mockImplementation(((_opts: any, cb: any) => {
        (requestEmitter as any)._cb = cb;
        return requestEmitter;
      }) as any);

    // Run a single tick by importing and calling the internal processBatch
    // indirectly through the worker
    jest.useFakeTimers();
    const { startOutboxWorker, stopOutboxWorker } = await import("../outboxWorker");
    const worker = await startOutboxWorker();

    // Let the initial tick fire
    await jest.runAllTimersAsync();
    await stopOutboxWorker(worker);
    jest.useRealTimers();

    // Second queryWrite call should be markDelivered
    const updateCall = queryWrite.mock.calls.find(
      (args: any[]) =>
        typeof args[0] === "string" && args[0].includes("delivered"),
    );
    expect(updateCall).toBeDefined();
  });

  it("schedules retry on non-2xx HTTP response", async () => {
    const { queryWrite } = require("../../config/database");

    queryWrite
      .mockResolvedValueOnce({
        rows: [
          {
            id: "evt-2",
            merchant_id: "m-1",
            webhook_url: "http://example.com/hook",
            event_type: "transaction.failed",
            payload: {},
            attempts: 0,
            max_attempts: 5,
          },
        ],
      })
      .mockResolvedValueOnce({ rows: [] }); // scheduleRetry

    const requestEmitter = new EventEmitter() as any;
    const responseEmitter = new EventEmitter() as any;
    responseEmitter.statusCode = 503;
    requestEmitter.write = jest.fn();
    requestEmitter.end = jest.fn(() => {
      setImmediate(() => {
        const cb = (requestEmitter as any)._cb;
        if (cb) cb(responseEmitter);
        setImmediate(() => responseEmitter.emit("end"));
      });
    });
    requestEmitter.setTimeout = jest.fn();

    jest
      .spyOn(http, "request")
      .mockImplementation(((_opts: any, cb: any) => {
        (requestEmitter as any)._cb = cb;
        return requestEmitter;
      }) as any);

    jest.useFakeTimers();
    const { startOutboxWorker, stopOutboxWorker } = await import("../outboxWorker");
    const worker = await startOutboxWorker();
    await jest.runAllTimersAsync();
    await stopOutboxWorker(worker);
    jest.useRealTimers();

    // Should have called queryWrite with 'failed' status
    const retryCall = queryWrite.mock.calls.find(
      (args: any[]) =>
        typeof args[0] === "string" && args[0].includes("next_attempt_at"),
    );
    expect(retryCall).toBeDefined();
  });
});
