import { readFile, writeFile, mkdir, chmod } from 'node:fs/promises';
import { randomBytes } from 'node:crypto';
import { parseEnv } from 'node:util';

let content: string;
try {
  content = await readFile('.env', 'utf8');
} catch (error) {
  if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
  content = await readFile('.env.example', 'utf8');
}
const lines = new Map(Object.entries(parseEnv(content)));
if (lines.get('ENVIRONMENT') !== 'local')
  throw new Error('This helper only configures the local development environment');
const username = lines.get('LOCAL_ADMIN_USERNAME') || 'admin';
const password = lines.get('LOCAL_ADMIN_PASSWORD') || randomBytes(24).toString('base64url');
for (const [key, value] of Object.entries({
  PUBLIC_ORIGIN: 'http://localhost:3000',
  LOCAL_ADMIN_USERNAME: username,
  LOCAL_ADMIN_PASSWORD: password,
})) {
  // Preserve existing quoted credentials exactly as Node's env-file parser reads them.
  if (key !== 'PUBLIC_ORIGIN' && lines.get(key)) continue;
  const pattern = new RegExp(`^${key}=.*$`, 'm');
  content = pattern.test(content)
    ? content.replace(pattern, () => `${key}=${value}`)
    : content.trimEnd() + `\n${key}=${value}\n`;
}
try {
  await chmod('.env', 0o600);
} catch (error) {
  if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
}
await writeFile('.env', content, { mode: 0o600 });
await mkdir('.tokens', { recursive: true, mode: 0o700 });
await chmod('.tokens', 0o700);
try {
  await chmod('.tokens/local-login.txt', 0o600);
} catch (error) {
  if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
}
await writeFile(
  '.tokens/local-login.txt',
  `Local warehouse login\nURL: http://localhost:3000\nOrganization: DEMO\nUsername: ${username}\nPassword: ${password}\n\nDevelopment only. This file and .env are ignored by Git.\n`,
  { mode: 0o600 },
);
console.log('Local configuration is ready. Login details: .tokens/local-login.txt (not committed).');
