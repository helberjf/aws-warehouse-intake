import { randomBytes, scrypt, timingSafeEqual } from 'node:crypto';
import { z } from 'zod';

export const passwordSchema = z.string().min(12).max(128);
export type PasswordHash = { algorithm: 'scrypt-v1'; salt: string; digest: string };
let active = 0;
const queue: (() => void)[] = [];

async function derive(password: string, salt: Buffer): Promise<Buffer> {
  // Bound memory use: each operation consumes about32MiB. Reject excess queued work.
  if (active >= 4) {
    if (queue.length >= 16) throw new Error('Password verifier temporarily busy');
    await new Promise<void>((resolve) => queue.push(resolve));
  } else active++;
  try {
    return await new Promise<Buffer>((resolve, reject) => {
      scrypt(password, salt, 64, { N: 32768, r: 8, p: 3, maxmem: 64 * 1024 * 1024 }, (error, key) => {
        if (error) reject(error);
        else resolve(key);
      });
    });
  } finally {
    const next = queue.shift();
    if (next) next();
    else active--;
  }
}

export async function hashPassword(password: string): Promise<PasswordHash> {
  const valid = passwordSchema.parse(password);
  const salt = randomBytes(32);
  return {
    algorithm: 'scrypt-v1',
    salt: salt.toString('hex'),
    digest: (await derive(valid, salt)).toString('hex'),
  };
}

const dummy: PasswordHash = { algorithm: 'scrypt-v1', salt: '00'.repeat(32), digest: '00'.repeat(64) };
export async function verifyPassword(password: string, stored?: PasswordHash): Promise<boolean> {
  const candidate = stored ?? dummy;
  if (
    candidate.algorithm !== 'scrypt-v1' ||
    !/^[a-f0-9]{64}$/.test(candidate.salt) ||
    !/^[a-f0-9]{128}$/.test(candidate.digest)
  ) {
    throw new Error('Invalid password record');
  }
  const derived = await derive(password, Buffer.from(candidate.salt, 'hex'));
  return timingSafeEqual(derived, Buffer.from(candidate.digest, 'hex')) && stored !== undefined;
}
