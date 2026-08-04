import fs from 'node:fs';
import { describe, expect, it } from 'vitest';

const compose = fs.readFileSync(new URL('../../../compose.yaml', import.meta.url), 'utf8');

function serviceBlock(name: string): string {
  const lines = compose.split(/\r?\n/);
  const start = lines.findIndex((line) => line === `  ${name}:`);
  if (start < 0) return '';
  const block: string[] = [];
  for (const line of lines.slice(start)) {
    if (block.length > 0 && /^ {2}\S/.test(line)) break;
    block.push(line);
  }
  return block.join('\n');
}

describe('default Compose edge exposure', () => {
  it('keeps the unauthenticated loopback exemption behind a loopback-only web proxy', () => {
    const web = serviceBlock('web');
    const api = serviceBlock('api');

    expect(web).toMatch(/- ['"]\$\{WEB_BIND_ADDRESS:-127\.0\.0\.1\}:8080:80['"]/);
    expect(api).toContain('SERVER_EXPOSURE: ${SERVER_EXPOSURE:-loopback}');
    expect(api).not.toMatch(/^ {4}ports:/m);
    expect(api).toContain('Deliberately no ports');
  });
});
