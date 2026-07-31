/**
 * AuthService against in-memory stubs.
 *
 * No database: what is worth pinning down here is the decision logic — which
 * failures are indistinguishable, what order the checks run in, and when the
 * lockout counter trips — none of which needs Postgres to be true. The scoped
 * paths it does not exercise (RLS on `user`) are covered by rls.test.ts.
 */
import { UnauthorizedException } from '@nestjs/common';
import { beforeAll, beforeEach, describe, expect, it } from 'vitest';
import type { RequestScope } from '@fenwick/shared';
import type { PrismaService } from '../infra/prisma/prisma.service.js';
import { AuthService } from './auth.service.js';
import { hashPassword } from './password.js';
import type { SessionService } from './session.service.js';

const PASSWORD = 'correct-horse-battery-staple';
const OTHER_PASSWORD = 'a-different-password-entirely';

interface UserRow {
  id: string;
  merchantId: string;
  email: string;
  name: string;
  role: string;
  status: string;
  passwordHash: string;
  failedLogins: number;
  lockedUntil: Date | null;
  lastLoginAt: Date | null;
  createdAt: Date;
}

interface AuditRow {
  merchantId: string;
  actorId: string | null;
  action: string;
  outcome: string;
  sourceIp: string | null;
  occurredAt: Date;
  metadata: unknown;
}

/** Just enough of PrismaService for the unscoped paths login actually touches. */
function fakePrisma(users: UserRow[], audit: AuditRow[]) {
  const client = {
    user: {
      findMany: async ({ where }: { where: { email: string } }) =>
        users.filter((u) => u.email === where.email).sort((a, b) => +a.createdAt - +b.createdAt),
      update: async ({ where, data }: { where: { id: string }; data: Partial<UserRow> }) => {
        const row = users.find((u) => u.id === where.id);
        if (row) Object.assign(row, data);
        return row;
      },
    },
    auditLog: {
      create: async ({ data }: { data: Omit<AuditRow, 'occurredAt'> }) => {
        const row = { ...data, occurredAt: new Date() };
        audit.push(row);
        return row;
      },
      count: async ({ where }: { where: Record<string, unknown> }) =>
        audit.filter(
          (row) =>
            row.merchantId === where['merchantId'] &&
            row.actorId === where['actorId'] &&
            row.action === where['action'] &&
            row.outcome === where['outcome'] &&
            row.occurredAt >= (where['occurredAt'] as { gte: Date }).gte,
        ).length,
    },
  };

  return {
    withoutScope: async <T>(_reason: string, work: (c: unknown) => Promise<T>) => work(client),
    withScope: async <T>(_scope: unknown, work: (c: unknown) => Promise<T>) => work(client),
  } as unknown as PrismaService;
}

function fakeSessions(issued: string[]) {
  return {
    issue: async (userId: string) => {
      issued.push(userId);
      return { token: `token-for-${userId}`, expiresAt: new Date(Date.now() + 3_600_000) };
    },
    revoke: async () => undefined,
  } as unknown as SessionService;
}

function makeUser(overrides: Partial<UserRow> & { passwordHash: string }): UserRow {
  return {
    id: 'user-1',
    merchantId: 'merchant-1',
    email: 'dana@fenwick.test',
    name: 'Dana Fenwick',
    role: 'MERCHANT_OWNER',
    status: 'ACTIVE',
    failedLogins: 0,
    lockedUntil: null,
    lastLoginAt: null,
    createdAt: new Date('2026-01-01'),
    ...overrides,
  };
}

describe('AuthService.login', () => {
  let hash = '';
  let otherHash = '';
  let users: UserRow[];
  let audit: AuditRow[];
  let issued: string[];
  let auth: AuthService;

  const attempt = {
    email: 'dana@fenwick.test',
    password: PASSWORD,
    sourceIp: '198.51.100.7',
    userAgent: 'vitest',
  };

  beforeAll(async () => {
    [hash, otherHash] = await Promise.all([hashPassword(PASSWORD), hashPassword(OTHER_PASSWORD)]);
  });

  beforeEach(() => {
    users = [makeUser({ passwordHash: hash })];
    audit = [];
    issued = [];
    auth = new AuthService(fakePrisma(users, audit), fakeSessions(issued));
  });

  it('issues a session and clears the failure counter on a correct password', async () => {
    users[0]!.failedLogins = 3;

    const result = await auth.login(attempt);

    expect(result.token).toBe('token-for-user-1');
    expect(result.user.email).toBe('dana@fenwick.test');
    expect(users[0]!.failedLogins).toBe(0);
    expect(users[0]!.lockedUntil).toBeNull();
    expect(users[0]!.lastLoginAt).toBeInstanceOf(Date);
    expect(audit.at(-1)).toMatchObject({ action: 'AUTH_LOGIN', outcome: 'SUCCESS' });
  });

  // FR-AUTH-003: an attacker must not be able to tell these four apart.
  it('gives the same message for an unknown address and a wrong password', async () => {
    const unknown = await auth
      .login({ ...attempt, email: 'nobody@fenwick.test' })
      .catch((e: Error) => e);
    const wrong = await auth.login({ ...attempt, password: 'wrong' }).catch((e: Error) => e);

    expect(unknown).toBeInstanceOf(UnauthorizedException);
    expect(wrong).toBeInstanceOf(UnauthorizedException);
    expect((unknown as Error).message).toBe((wrong as Error).message);
  });

  it('does not record an audit row for an address that matches no user', async () => {
    // audit_log.merchant_id is NOT NULL and there is no merchant to attribute
    // it to; the attempt goes to the application log instead.
    await expect(auth.login({ ...attempt, email: 'nobody@fenwick.test' })).rejects.toThrow();
    expect(audit).toHaveLength(0);
  });

  it('records a failed attempt with its source IP and user agent (FR-AUTH-004)', async () => {
    await expect(auth.login({ ...attempt, password: 'wrong' })).rejects.toThrow();

    expect(audit[0]).toMatchObject({
      action: 'AUTH_LOGIN',
      outcome: 'FAILURE',
      sourceIp: '198.51.100.7',
      metadata: { reason: 'BAD_PASSWORD', userAgent: 'vitest' },
    });
  });

  it('never writes the password into the audit payload', async () => {
    await expect(auth.login({ ...attempt, password: 'hunter2' })).rejects.toThrow();
    expect(JSON.stringify(audit)).not.toContain('hunter2');
  });

  // FR-AUTH-002.
  it('locks the account for 30 minutes on the fifth failure in 15 minutes', async () => {
    for (let i = 0; i < 4; i += 1) {
      await expect(auth.login({ ...attempt, password: 'wrong' })).rejects.toThrow();
    }
    expect(users[0]!.failedLogins).toBe(4);
    expect(users[0]!.lockedUntil).toBeNull();

    await expect(auth.login({ ...attempt, password: 'wrong' })).rejects.toThrow();

    expect(users[0]!.failedLogins).toBe(5);
    const lockedFor = users[0]!.lockedUntil!.getTime() - Date.now();
    expect(lockedFor).toBeGreaterThan(29 * 60_000);
    expect(lockedFor).toBeLessThanOrEqual(30 * 60_000);
  });

  it('ignores failures that fall outside the 15-minute window', async () => {
    audit.push(
      ...Array.from({ length: 4 }, () => ({
        merchantId: 'merchant-1',
        actorId: 'user-1',
        action: 'AUTH_LOGIN',
        outcome: 'FAILURE',
        sourceIp: null,
        occurredAt: new Date(Date.now() - 20 * 60_000),
        metadata: null,
      })),
    );

    await expect(auth.login({ ...attempt, password: 'wrong' })).rejects.toThrow();

    // Only the one just made counts; the stale four do not.
    expect(users[0]!.failedLogins).toBe(1);
    expect(users[0]!.lockedUntil).toBeNull();
  });

  it('rejects a locked account even when the password is right, and issues no session', async () => {
    users[0]!.lockedUntil = new Date(Date.now() + 10 * 60_000);

    await expect(auth.login(attempt)).rejects.toThrow(UnauthorizedException);

    expect(issued).toEqual([]);
    expect(audit.at(-1)).toMatchObject({ outcome: 'FAILURE', metadata: { reason: 'LOCKED' } });
  });

  it('lets a user back in once the lock has expired', async () => {
    users[0]!.lockedUntil = new Date(Date.now() - 1_000);

    await expect(auth.login(attempt)).resolves.toMatchObject({ token: 'token-for-user-1' });
  });

  it.each(['INVITED', 'SUSPENDED'])('refuses a %s user holding the right password', async (status) => {
    users[0]!.status = status;

    await expect(auth.login(attempt)).rejects.toThrow(UnauthorizedException);

    expect(issued).toEqual([]);
    expect(audit.at(-1)).toMatchObject({ metadata: { reason: `STATUS_${status}` } });
  });

  // Email is unique per merchant, not globally (schema.prisma) — the password
  // is the only thing that can say which of two accounts is being signed into.
  it('signs into the account whose password matches when two merchants share an address', async () => {
    users.push(
      makeUser({
        id: 'user-2',
        merchantId: 'merchant-2',
        passwordHash: otherHash,
        createdAt: new Date('2026-02-01'),
      }),
    );

    const result = await auth.login({ ...attempt, password: OTHER_PASSWORD });

    expect(result.user.id).toBe('user-2');
    expect(result.user.merchantId).toBe('merchant-2');
  });
});

describe('AuthService.logout', () => {
  it('revokes the session server-side and records it (FR-AUTH-010)', async () => {
    const audit: AuditRow[] = [];
    const revoked: string[] = [];
    const sessions = {
      issue: async () => ({ token: '', expiresAt: new Date() }),
      revoke: async (sessionId: string) => {
        revoked.push(sessionId);
      },
    } as unknown as SessionService;

    const auth = new AuthService(fakePrisma([], audit), sessions);
    const scope: RequestScope = {
      merchantId: 'merchant-1',
      userId: 'user-1',
      role: 'MERCHANT_OWNER',
      assignedBrandIds: [],
      sessionId: 'session-1',
      sourceIp: '198.51.100.7',
    };

    await auth.logout(scope);

    expect(revoked).toEqual(['session-1']);
    expect(audit.at(-1)).toMatchObject({ action: 'AUTH_LOGOUT', outcome: 'SUCCESS' });
  });
});
