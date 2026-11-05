import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { z } from 'zod';
import { receivingEntrySchema } from '../src/domain/receiving.ts';

const filename = new URL('../schemas/receiving-entry.schema.json', import.meta.url);
const schema = z.toJSONSchema(receivingEntrySchema, { target: 'draft-2020-12' });
const expected = JSON.stringify(schema, null, 2) + '\n';
if (process.argv.includes('--write')) {
  await mkdir(new URL('../schemas/', import.meta.url), { recursive: true });
  await writeFile(filename, expected);
  console.log('Receiving entry JSON Schema generated from the domain contract.');
} else {
  const actual = await readFile(filename, 'utf8');
  if (actual !== expected) throw new Error('Schema is out of date; run npm run schema:write');
  console.log('Versioned JSON Schema matches the domain contract.');
}
