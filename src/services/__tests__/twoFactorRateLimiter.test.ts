import { jest } from "@jest/globals";
import { redisClient } from "../../config/redis";
import logger from "../../utils/logger";
import {
  LOCKOUT_DURATION_SECONDS,
  MAX_ATTEMPTS,
  TwoFactorRateLimiter,
} from "../twoFactorRateLimiter";

jest.mock("../../config/redis", () => ({
  redisClient: {
    isOpen: true,
    get: jest.fn(),
    incr: jest.fn(),
    expire: jest.fn(),
    del: jest.fn(),
    ttl: jest.fn(),
  },
}));

jest.mock("../../utils/logger", () => ({
  __esModule: true,
  default: { warn: jest.fn(), info: jest.fn(), error: jest.fn() },
}));

describe("TwoFactorRateLimiter headers", () => {
  beforeEach(() => {
    jest.clearAllMocks();
  });

  it("returns standard rate-limit headers for a locked 2FA account", async () => {
    const limiter = new TwoFactorRateLimiter();
    const getMock = redisClient.get as jest.MockedFunction<
      typeof redisClient.get
    >;
    const ttlMock = redisClient.ttl as jest.MockedFunction<
      typeof redisClient.ttl
    >;

    getMock.mockResolvedValue("5");
    ttlMock.mockResolvedValue(600);

    const headers = await limiter.getRateLimitHeaders("user-123");

    expect(headers).toMatchObject({
      limit: 5,
      remaining: 0,
      retryAfter: 600,
    });
    expect(headers.resetAt).toContain("T");
  });
});

describe("TwoFactorRateLimiter brute-force protection", () => {
  const store = new Map<string, number>();
  const ttls = new Map<string, number>();

  beforeEach(() => {
    jest.clearAllMocks();
    store.clear();
    ttls.clear();
    (redisClient.incr as jest.Mock).mockImplementation(async (key: unknown) => {
      const next = (store.get(String(key)) ?? 0) + 1;
      store.set(String(key), next);
      return next;
    });
    (redisClient.get as jest.Mock).mockImplementation(async (key: unknown) => {
      const value = store.get(String(key));
      return value === undefined ? null : String(value);
    });
    (redisClient.expire as jest.Mock).mockImplementation(
      async (key: unknown, seconds: unknown) => {
        ttls.set(String(key), Number(seconds));
        return true;
      },
    );
    (redisClient.ttl as jest.Mock).mockImplementation(
      async (key: unknown) => ttls.get(String(key)) ?? -2,
    );
    (redisClient.del as jest.Mock).mockImplementation(async (key: unknown) => {
      store.delete(String(key));
      ttls.delete(String(key));
      return 1;
    });
  });

  it("locks the account for 15 minutes after 5 consecutive failures", async () => {
    const limiter = new TwoFactorRateLimiter();
    const warnSpy = jest.spyOn(logger, "warn");

    for (let attempt = 1; attempt < MAX_ATTEMPTS; attempt++) {
      await limiter.incrementFailures("admin-1");
      expect(await limiter.isLocked("admin-1")).toBe(false);
    }
    expect(warnSpy).not.toHaveBeenCalled();

    await limiter.incrementFailures("admin-1");

    expect(await limiter.isLocked("admin-1")).toBe(true);
    expect(await limiter.getRemainingTries("admin-1")).toBe(0);
    expect(await limiter.getLockoutTimeRemaining("admin-1")).toBe(
      LOCKOUT_DURATION_SECONDS,
    );
    expect(LOCKOUT_DURATION_SECONDS).toBe(15 * 60);
    // TTL is refreshed when the lockout starts, not only on the first failure
    expect(redisClient.expire).toHaveBeenCalledTimes(2);
  });

  it("emits a single security alert when the lockout begins", async () => {
    const limiter = new TwoFactorRateLimiter();
    const warnSpy = jest.spyOn(logger, "warn");

    for (let attempt = 0; attempt < MAX_ATTEMPTS + 2; attempt++) {
      await limiter.incrementFailures("admin-2");
    }

    expect(warnSpy).toHaveBeenCalledTimes(1);
    expect(warnSpy).toHaveBeenCalledWith(
      expect.objectContaining({
        event: "security.2fa.account_lockout",
        userId: "admin-2",
        attempts: MAX_ATTEMPTS,
      }),
      expect.stringContaining("SECURITY ALERT"),
    );
  });

  it("resets the counter after a successful verification", async () => {
    const limiter = new TwoFactorRateLimiter();

    for (let attempt = 1; attempt < MAX_ATTEMPTS; attempt++) {
      await limiter.incrementFailures("admin-3");
    }
    await limiter.resetFailures("admin-3");
    await limiter.incrementFailures("admin-3");

    expect(await limiter.isLocked("admin-3")).toBe(false);
    expect(await limiter.getRemainingTries("admin-3")).toBe(MAX_ATTEMPTS - 1);
  });
});
