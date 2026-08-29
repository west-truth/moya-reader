import { createHash, randomBytes, scrypt as nodeScrypt, timingSafeEqual } from 'node:crypto';
import type pg from 'pg';

const PASSWORD_SCHEME = 'scrypt-v1' as const;
const PASSWORD_KEY_BYTES = 64;
const SESSION_TTL_MS = 30 * 24 * 60 * 60 * 1000;
const LOGIN_WINDOW_MS = 5 * 60 * 1000;
const LOGIN_FAILURE_LIMIT = 8;
const MAX_LOGIN_FAILURE_KEYS = 1_000;

export interface SelfHostAccountView {
  readonly username: string;
  readonly displayName: string;
}

interface StoredSelfHostAccount extends SelfHostAccountView {
  readonly userId: string;
  readonly normalizedUsername: string;
  readonly passwordSalt: string;
  readonly passwordDigest: string;
}

export interface SelfHostSessionView {
  readonly token: string;
  readonly expiresAt: string;
  readonly account: SelfHostAccountView;
}

export interface RegisterSelfHostAccountInput {
  readonly username: string;
  readonly displayName?: string;
  readonly password: string;
}

export interface LoginSelfHostAccountInput {
  readonly username: string;
  readonly password: string;
  readonly throttleKey: string;
}

export class SelfHostAuthError extends Error {
  constructor(
    public readonly code:
      | 'account_already_registered'
      | 'invalid_credentials'
      | 'invalid_display_name'
      | 'invalid_password'
      | 'invalid_username'
      | 'login_rate_limited',
    public readonly status: number,
  ) {
    super(code);
    this.name = 'SelfHostAuthError';
  }
}

export interface SelfHostAuthStore {
  loadAccount(): Promise<StoredSelfHostAccount | undefined>;
  createAccount(account: StoredSelfHostAccount): Promise<boolean>;
  updateUserDisplayName(userId: string, displayName: string): Promise<void>;
  createSession(userId: string, tokenHash: string, expiresAt: string): Promise<void>;
  resolveSession(tokenHash: string, now: string): Promise<StoredSelfHostAccount | undefined>;
  revokeSession(tokenHash: string): Promise<void>;
  deleteExpiredSessions(now: string): Promise<void>;
}

interface LoginFailures {
  count: number;
  startedAt: number;
}

function scrypt(password: string, salt: Buffer): Promise<Buffer> {
  return new Promise((resolve, reject) => {
    nodeScrypt(
      password,
      salt,
      PASSWORD_KEY_BYTES,
      { N: 16_384, r: 8, p: 1, maxmem: 32 * 1024 * 1024 },
      (error, key) => {
        if (error) reject(error);
        else resolve(key as Buffer);
      },
    );
  });
}

function normalizeUsername(value: string): string {
  return value.trim().normalize('NFKC').toLocaleLowerCase('en-US');
}

function validatedUsername(value: string): { username: string; normalized: string } {
  const username = value.trim().normalize('NFKC');
  const normalized = normalizeUsername(username);
  if (
    username.length < 2 ||
    username.length > 64 ||
    !/^[\p{L}\p{N}](?:[\p{L}\p{N}._-]*[\p{L}\p{N}])?$/u.test(username)
  ) {
    throw new SelfHostAuthError('invalid_username', 400);
  }
  return { username, normalized };
}

function validatedDisplayName(value: string | undefined, fallback: string): string {
  const displayName = (value ?? fallback).trim().normalize('NFKC');
  const hasControlCharacter = [...displayName].some((character) => {
    const codePoint = character.codePointAt(0) ?? 0;
    return codePoint <= 0x1f || codePoint === 0x7f;
  });
  if (!displayName || displayName.length > 80 || hasControlCharacter) {
    throw new SelfHostAuthError('invalid_display_name', 400);
  }
  return displayName;
}

function validatedPassword(value: string): string {
  if (value.length < 10 || value.length > 256) throw new SelfHostAuthError('invalid_password', 400);
  return value;
}

async function passwordDigest(password: string, saltBase64: string): Promise<string> {
  const digest = await scrypt(password, Buffer.from(saltBase64, 'base64'));
  return digest.toString('base64');
}

function safeDigestEquals(left: string, right: string): boolean {
  const leftBuffer = Buffer.from(left, 'base64');
  const rightBuffer = Buffer.from(right, 'base64');
  return leftBuffer.length === rightBuffer.length && timingSafeEqual(leftBuffer, rightBuffer);
}

export function selfHostSessionTokenHash(token: string): string {
  return createHash('sha256').update(token).digest('hex');
}

export class SelfHostAuthService {
  private readonly loginFailures = new Map<string, LoginFailures>();

  constructor(
    private readonly store: SelfHostAuthStore,
    private readonly defaultUserId: string,
    private readonly now: () => Date = () => new Date(),
  ) {}

  async status(sessionToken?: string): Promise<{
    setupRequired: boolean;
    authenticated: boolean;
    account?: SelfHostAccountView;
  }> {
    const account = await this.loadOwnedAccount();
    if (!account) return { setupRequired: true, authenticated: false };
    const authenticated = sessionToken ? await this.authenticateSession(sessionToken) : undefined;
    return {
      setupRequired: false,
      authenticated: Boolean(authenticated),
      account: authenticated,
    };
  }

  async setupRequired(): Promise<boolean> {
    return !(await this.loadOwnedAccount());
  }

  async register(input: RegisterSelfHostAccountInput): Promise<SelfHostSessionView> {
    const { username, normalized } = validatedUsername(input.username);
    const displayName = validatedDisplayName(input.displayName, username);
    const password = validatedPassword(input.password);
    const salt = randomBytes(16).toString('base64');
    const digest = await passwordDigest(password, salt);
    const account: StoredSelfHostAccount = {
      userId: this.defaultUserId,
      username,
      normalizedUsername: normalized,
      displayName,
      passwordSalt: salt,
      passwordDigest: digest,
    };
    if (!(await this.store.createAccount(account))) {
      throw new SelfHostAuthError('account_already_registered', 409);
    }
    await this.store.updateUserDisplayName(this.defaultUserId, displayName);
    return this.issueSession(account);
  }

  async login(input: LoginSelfHostAccountInput): Promise<SelfHostSessionView> {
    const throttleKey = input.throttleKey.slice(0, 200);
    this.assertLoginAllowed(throttleKey);
    const account = await this.loadOwnedAccount();
    const normalized = normalizeUsername(input.username.slice(0, 256));
    const passwordInRange = input.password.length > 0 && input.password.length <= 256;
    const digest = account && passwordInRange ? await passwordDigest(input.password, account.passwordSalt) : undefined;
    if (
      !account ||
      normalized !== account.normalizedUsername ||
      !digest ||
      !safeDigestEquals(digest, account.passwordDigest)
    ) {
      this.recordLoginFailure(throttleKey);
      throw new SelfHostAuthError('invalid_credentials', 401);
    }
    this.loginFailures.delete(throttleKey);
    return this.issueSession(account);
  }

  async authenticateSession(token: string | undefined): Promise<SelfHostAccountView | undefined> {
    if (!token || token.length > 512) return undefined;
    const account = await this.store.resolveSession(selfHostSessionTokenHash(token), this.now().toISOString());
    if (account && account.userId !== this.defaultUserId) throw new Error('self_host_account_owner_mismatch');
    return account ? { username: account.username, displayName: account.displayName } : undefined;
  }

  async logout(token: string | undefined): Promise<void> {
    if (!token || token.length > 512) return;
    await this.store.revokeSession(selfHostSessionTokenHash(token));
  }

  private async issueSession(account: StoredSelfHostAccount): Promise<SelfHostSessionView> {
    const now = this.now();
    const expiresAt = new Date(now.getTime() + SESSION_TTL_MS).toISOString();
    const token = randomBytes(32).toString('base64url');
    await this.store.deleteExpiredSessions(now.toISOString());
    await this.store.createSession(account.userId, selfHostSessionTokenHash(token), expiresAt);
    return {
      token,
      expiresAt,
      account: { username: account.username, displayName: account.displayName },
    };
  }

  private async loadOwnedAccount(): Promise<StoredSelfHostAccount | undefined> {
    const account = await this.store.loadAccount();
    if (account && account.userId !== this.defaultUserId) throw new Error('self_host_account_owner_mismatch');
    return account;
  }

  private assertLoginAllowed(key: string): void {
    const now = this.now().getTime();
    this.pruneLoginFailures(now);
    const current = this.loginFailures.get(key);
    if (!current) return;
    if (now - current.startedAt >= LOGIN_WINDOW_MS) {
      this.loginFailures.delete(key);
      return;
    }
    if (current.count >= LOGIN_FAILURE_LIMIT) throw new SelfHostAuthError('login_rate_limited', 429);
  }

  private recordLoginFailure(key: string): void {
    const now = this.now().getTime();
    this.pruneLoginFailures(now);
    const current = this.loginFailures.get(key);
    if (!current || now - current.startedAt >= LOGIN_WINDOW_MS) {
      while (this.loginFailures.size >= MAX_LOGIN_FAILURE_KEYS) {
        this.loginFailures.delete(this.loginFailures.keys().next().value ?? '');
      }
      this.loginFailures.set(key, { count: 1, startedAt: now });
      return;
    }
    current.count += 1;
  }

  private pruneLoginFailures(now: number): void {
    for (const [key, failure] of this.loginFailures) {
      if (now - failure.startedAt >= LOGIN_WINDOW_MS) this.loginFailures.delete(key);
    }
  }
}

interface AccountRow {
  readonly user_id: string;
  readonly username: string;
  readonly normalized_username: string;
  readonly display_name: string;
  readonly password_salt: string;
  readonly password_digest: string;
}

function mapAccount(row: AccountRow | undefined): StoredSelfHostAccount | undefined {
  return row
    ? {
        userId: row.user_id,
        username: row.username,
        normalizedUsername: row.normalized_username,
        displayName: row.display_name,
        passwordSalt: row.password_salt,
        passwordDigest: row.password_digest,
      }
    : undefined;
}

export class PostgresSelfHostAuthStore implements SelfHostAuthStore {
  constructor(private readonly pool: pg.Pool) {}

  async loadAccount(): Promise<StoredSelfHostAccount | undefined> {
    const result = await this.pool.query<AccountRow>(
      `select user_id, username, normalized_username, display_name, password_salt, password_digest
         from self_host_accounts where singleton_key = 1`,
    );
    return mapAccount(result.rows[0]);
  }

  async createAccount(account: StoredSelfHostAccount): Promise<boolean> {
    const result = await this.pool.query(
      `insert into self_host_accounts
         (singleton_key, user_id, username, normalized_username, display_name, password_scheme, password_salt, password_digest)
       values (1, $1, $2, $3, $4, $5, $6, $7)
       on conflict (singleton_key) do nothing`,
      [
        account.userId,
        account.username,
        account.normalizedUsername,
        account.displayName,
        PASSWORD_SCHEME,
        account.passwordSalt,
        account.passwordDigest,
      ],
    );
    return result.rowCount === 1;
  }

  async updateUserDisplayName(userId: string, displayName: string): Promise<void> {
    await this.pool.query(`update users set display_name = $2, updated_at = now() where id = $1`, [
      userId,
      displayName,
    ]);
  }

  async createSession(userId: string, tokenHash: string, expiresAt: string): Promise<void> {
    await this.pool.query(
      `insert into self_host_sessions (token_hash, user_id, expires_at) values ($1, $2, $3::timestamptz)`,
      [tokenHash, userId, expiresAt],
    );
  }

  async resolveSession(tokenHash: string, now: string): Promise<StoredSelfHostAccount | undefined> {
    const result = await this.pool.query<AccountRow>(
      `select a.user_id, a.username, a.normalized_username, a.display_name, a.password_salt, a.password_digest
         from self_host_sessions s
         join self_host_accounts a on a.user_id = s.user_id and a.singleton_key = 1
        where s.token_hash = $1 and s.expires_at > $2::timestamptz`,
      [tokenHash, now],
    );
    return mapAccount(result.rows[0]);
  }

  async revokeSession(tokenHash: string): Promise<void> {
    await this.pool.query(`delete from self_host_sessions where token_hash = $1`, [tokenHash]);
  }

  async deleteExpiredSessions(now: string): Promise<void> {
    await this.pool.query(`delete from self_host_sessions where expires_at <= $1::timestamptz`, [now]);
  }
}
