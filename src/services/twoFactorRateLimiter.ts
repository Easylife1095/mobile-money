import { redisClient } from "../config/redis";
import logger from "../utils/logger";

export const MAX_ATTEMPTS = 5;
export const LOCKOUT_DURATION_SECONDS = 15 * 60; // 15 minutes

export interface TwoFactorRateLimitHeaders {
  limit: number;
  remaining: number;
  resetAt: string;
  retryAfter: number;
}

export class TwoFactorRateLimiter {
  private redisPrefix = "2fa:lockout:";

  private getKey(userId: string): string {
    return `${this.redisPrefix}${userId}`;
  }

  /**
   * Check if a user is currently locked out from 2FA
   */
  async isLocked(userId: string): Promise<boolean> {
    if (!redisClient.isOpen) return false;

    const attempts = await redisClient.get(this.getKey(userId));
    return attempts !== null && parseInt(String(attempts), 10) >= MAX_ATTEMPTS;
  }

  /**
   * Increment the failed attempt counter for a user
   * @returns The new attempt count
   */
  async incrementFailures(userId: string): Promise<number> {
    if (!redisClient.isOpen) return 0;

    const key = this.getKey(userId);
    const count = await redisClient.incr(key);

    if (count === 1 || count === MAX_ATTEMPTS) {
      // Start the failure window on the first miss, and restart it when the
      // lockout begins so the account stays locked for the full duration.
      await redisClient.expire(key, LOCKOUT_DURATION_SECONDS);
    }

    if (count === MAX_ATTEMPTS) {
      logger.warn(
        {
          event: "security.2fa.account_lockout",
          severity: "high",
          userId,
          attempts: count,
          lockoutSeconds: LOCKOUT_DURATION_SECONDS,
        },
        `[2FA] SECURITY ALERT: user ${userId} locked out after ${count} failed 2FA attempts`,
      );
    }

    return Number(count);
  }

  /**
   * Reset the failed attempt counter for a user (called on success)
   */
  async resetFailures(userId: string): Promise<void> {
    if (!redisClient.isOpen) return;

    await redisClient.del(this.getKey(userId));
  }

  /**
   * Get the number of remaining attempts before lockout
   */
  async getRemainingTries(userId: string): Promise<number> {
    if (!redisClient.isOpen) return MAX_ATTEMPTS;

    const attemptsRaw = await redisClient.get(this.getKey(userId));
    const attempts = attemptsRaw ? parseInt(String(attemptsRaw), 10) : 0;
    return Math.max(0, MAX_ATTEMPTS - attempts);
  }

  /**
   * Get the seconds remaining until the lockout expires
   */
  async getLockoutTimeRemaining(userId: string): Promise<number> {
    if (!redisClient.isOpen) return 0;

    const ttl = await redisClient.ttl(this.getKey(userId));
    return Math.max(0, Number(ttl));
  }

  /**
   * Build standard rate-limit headers for clients.
   */
  async getRateLimitHeaders(
    userId: string,
  ): Promise<TwoFactorRateLimitHeaders> {
    if (!redisClient.isOpen) {
      return {
        limit: MAX_ATTEMPTS,
        remaining: MAX_ATTEMPTS,
        resetAt: new Date(
          Date.now() + LOCKOUT_DURATION_SECONDS * 1000,
        ).toISOString(),
        retryAfter: LOCKOUT_DURATION_SECONDS,
      };
    }

    const attemptsRaw = await redisClient.get(this.getKey(userId));
    const attempts = attemptsRaw ? parseInt(String(attemptsRaw), 10) : 0;
    const remaining = Math.max(0, MAX_ATTEMPTS - attempts);
    const ttl = await redisClient.ttl(this.getKey(userId));
    const retryAfter = Math.max(0, Number(ttl));
    const resetAt = new Date(Date.now() + retryAfter * 1000).toISOString();

    return {
      limit: MAX_ATTEMPTS,
      remaining,
      resetAt,
      retryAfter,
    };
  }
}

export const twoFactorRateLimiter = new TwoFactorRateLimiter();
