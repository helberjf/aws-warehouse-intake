import { createHash, randomBytes, randomUUID } from 'node:crypto';
import {
  DeleteCommand,
  GetCommand,
  PutCommand,
  TransactWriteCommand,
  UpdateCommand,
  type DynamoDBDocumentClient,
} from '@aws-sdk/lib-dynamodb';
import { z } from 'zod';
import { AuthenticationError } from '../http/auth.ts';
import type { Principal } from '../http/auth.ts';
import { ConflictError } from '../application/ports.ts';
import { hashPassword, passwordSchema, verifyPassword, type PasswordHash } from './password.ts';

const id = z.string().regex(/^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$/);
export const usernameSchema = z
  .string()
  .trim()
  .toLowerCase()
  .min(3)
  .max(64)
  .regex(/^[a-z0-9][a-z0-9._@+-]*$/);
export const provisionSchema = z
  .object({
    organizationId: id,
    username: usernameSchema,
    password: passwordSchema,
    displayName: z.string().trim().min(1).max(128),
    producerId: id,
    warehouseIds: z.array(id).min(1).max(1000),
    roles: z
      .array(z.enum(['receiving', 'admin']))
      .min(1)
      .max(2),
    active: z.boolean().default(true),
  })
  .strict();
export const loginSchema = z
  .object({ organizationId: id, username: usernameSchema, password: z.string().min(1).max(128) })
  .strict();
export type UserInput = z.input<typeof provisionSchema>;
export type BrowserPrincipal = Principal & { displayName: string };
type UserRecord = {
  principal: BrowserPrincipal;
  username: string;
  active: boolean;
  passwordHash: PasswordHash;
  credentialVersion: string;
  createdAt: string;
  updatedAt: string;
};
type SessionRecord = { userKey: string; credentialVersion: string; csrfToken: string; expiresAt: number };
export type AuthenticatedSession = {
  user: BrowserPrincipal;
  csrfToken: string;
  expiresAt: number;
  userKey: string;
  credentialVersion: string;
};
export class LoginRateLimitError extends Error {}
const digest = (parts: unknown) => createHash('sha256').update(JSON.stringify(parts)).digest('hex');
const key = (pk: string) => ({ pk, sk: 'META' });
export const identityKeys = {
  user: (organizationId: string, username: string) => `USER#${digest([organizationId, username])}`,
  session: (token: string) => `SESSION#${digest(token)}`,
  throttle: (kind: string, subject: string) => `LOGIN#${digest([kind, subject])}`,
};
const conditional = (error: unknown) => (error as Error)?.name === 'ConditionalCheckFailedException';

export class IdentityService {
  private readonly client: DynamoDBDocumentClient;
  private readonly table: string;
  constructor(client: DynamoDBDocumentClient, tableName: string) {
    this.client = client;
    this.table = tableName;
  }
  private async read(pk: string) {
    return (
      await this.client.send(new GetCommand({ TableName: this.table, Key: key(pk), ConsistentRead: true }))
    ).Item;
  }
  async provisionUser(input: UserInput, options: { reset?: boolean } = {}) {
    const value = provisionSchema.parse(input);
    const pk = identityKeys.user(value.organizationId, value.username);
    const previous = (await this.read(pk)) as (UserRecord & { pk: string }) | undefined;
    if (previous && !options.reset)
      throw new ConflictError('User already exists; an explicit reset is required');
    const now = new Date().toISOString();
    const record: UserRecord = {
      principal: {
        subject: previous?.principal.subject ?? `user-${randomUUID()}`,
        displayName: value.displayName,
        organizationId: value.organizationId,
        producerId: value.producerId,
        warehouseIds: [...new Set(value.warehouseIds)],
        roles: [...new Set(value.roles)],
      },
      username: value.username,
      active: value.active,
      passwordHash: await hashPassword(value.password),
      credentialVersion: randomUUID(),
      createdAt: previous?.createdAt ?? now,
      updatedAt: now,
    };
    try {
      await this.client.send(
        new PutCommand({
          TableName: this.table,
          Item: { ...key(pk), ...record },
          ConditionExpression: previous ? 'credentialVersion = :version' : 'attribute_not_exists(pk)',
          ...(previous ? { ExpressionAttributeValues: { ':version': previous.credentialVersion } } : {}),
        }),
      );
    } catch (error) {
      if (conditional(error))
        throw new ConflictError('User changed concurrently; retry the explicit operation');
      throw error;
    }
    return record.principal;
  }

  private async throttle(kind: string, subject: string, limit: number): Promise<void> {
    const pk = identityKeys.throttle(kind, subject),
      now = Math.floor(Date.now() / 1000);
    try {
      await this.client.send(
        new PutCommand({
          TableName: this.table,
          Item: { ...key(pk), attempts: 1, expiresAt: now + 900 },
          ConditionExpression: 'attribute_not_exists(pk) OR expiresAt <= :now',
          ExpressionAttributeValues: { ':now': now },
        }),
      );
      return;
    } catch (error) {
      if (!conditional(error)) throw error;
    }
    try {
      await this.client.send(
        new UpdateCommand({
          TableName: this.table,
          Key: key(pk),
          UpdateExpression: 'ADD attempts :one',
          ConditionExpression: 'expiresAt > :now AND attempts < :limit',
          ExpressionAttributeValues: { ':one': 1, ':now': now, ':limit': limit },
        }),
      );
    } catch (error) {
      if (conditional(error)) throw new LoginRateLimitError('Too many sign-in attempts. Try again later.');
      throw error;
    }
  }

  async login(input: unknown, ip: string): Promise<{ token: string; session: AuthenticatedSession }> {
    const value = loginSchema.parse(input),
      userKey = identityKeys.user(value.organizationId, value.username);
    await this.throttle('ip', ip, 30);
    await this.throttle('account', userKey, 5);
    const user = (await this.read(userKey)) as UserRecord | undefined;
    const valid = await verifyPassword(value.password, user?.active ? user.passwordHash : undefined);
    if (!valid || !user?.active) throw new AuthenticationError('Invalid credentials');
    const token = randomBytes(32).toString('base64url');
    const session: SessionRecord = {
      userKey,
      credentialVersion: user.credentialVersion,
      csrfToken: randomBytes(32).toString('base64url'),
      expiresAt: Math.floor(Date.now() / 1000) + 8 * 3600,
    };
    try {
      await this.client.send(
        new TransactWriteCommand({
          TransactItems: [
            {
              ConditionCheck: {
                TableName: this.table,
                Key: key(userKey),
                ConditionExpression: 'active = :active AND credentialVersion = :version',
                ExpressionAttributeValues: { ':active': true, ':version': user.credentialVersion },
              },
            },
            {
              Put: {
                TableName: this.table,
                Item: { ...key(identityKeys.session(token)), ...session },
                ConditionExpression: 'attribute_not_exists(pk)',
              },
            },
          ],
        }),
      );
    } catch (error) {
      if ((error as Error).name === 'TransactionCanceledException')
        throw new AuthenticationError('Invalid credentials');
      throw error;
    }
    // Keep the fixed account window across successful logins too, avoiding a reset race.
    return { token, session: { ...session, user: user.principal } };
  }

  async authenticate(token: string): Promise<AuthenticatedSession> {
    if (!/^[A-Za-z0-9_-]{43}$/.test(token)) throw new AuthenticationError('Invalid session');
    const session = (await this.read(identityKeys.session(token))) as SessionRecord | undefined;
    if (!session || session.expiresAt <= Math.floor(Date.now() / 1000))
      throw new AuthenticationError('Invalid session');
    const user = (await this.read(session.userKey)) as UserRecord | undefined;
    if (!user?.active || user.credentialVersion !== session.credentialVersion)
      throw new AuthenticationError('Invalid session');
    return { ...session, user: user.principal };
  }

  async logout(token: string): Promise<void> {
    await this.client.send(
      new DeleteCommand({ TableName: this.table, Key: key(identityKeys.session(token)) }),
    );
  }

  async changePassword(token: string, currentPassword: string, newPassword: string): Promise<void> {
    passwordSchema.parse(newPassword);
    if (currentPassword.length < 1 || currentPassword.length > 128)
      throw new AuthenticationError('Invalid credentials');
    const session = await this.authenticate(token);
    await this.throttle('password-change', session.userKey, 5);
    const user = (await this.read(session.userKey)) as UserRecord | undefined;
    if (!user || !(await verifyPassword(currentPassword, user.passwordHash)))
      throw new AuthenticationError('Invalid credentials');
    const passwordHash = await hashPassword(newPassword);
    try {
      await this.client.send(
        new UpdateCommand({
          TableName: this.table,
          Key: key(session.userKey),
          UpdateExpression: 'SET passwordHash = :hash, credentialVersion = :next, updatedAt = :now',
          ConditionExpression: 'credentialVersion = :version AND active = :active',
          ExpressionAttributeValues: {
            ':hash': passwordHash,
            ':next': randomUUID(),
            ':now': new Date().toISOString(),
            ':version': session.credentialVersion,
            ':active': true,
          },
        }),
      );
    } catch (error) {
      if (conditional(error)) throw new AuthenticationError('Session changed; sign in again');
      throw error;
    }
    await this.logout(token);
  }
}
