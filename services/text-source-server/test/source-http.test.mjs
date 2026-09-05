import test from 'node:test';
import assert from 'node:assert/strict';
import { fetchSourceBytes, fetchSourceJson } from '../src/source-http.mjs';

const base = { allowedOrigins: ['https://source.example'], timeoutMs: 1000 };

test('transient pre-header GET resets retry once within the original deadline and never retry POST or abort', async () => {
  const reset = () => new TypeError('private network detail', { cause: { code: 'ECONNRESET' } });
  let calls = 0;
  const result = await fetchSourceJson('https://source.example/a', {
    ...base,
    fetchImpl: async () => {
      if (++calls === 1) throw reset();
      return Response.json({ ok: true });
    },
  });
  assert.deepEqual(result, { ok: true });
  assert.equal(calls, 2);
  for (const [options, expectedCode, expectedCalls] of [
    [{ method: 'POST' }, 'source_request_failed', 1],
    [{ timeoutMs: 20 }, 'source_timeout', 1],
    [{}, 'source_request_failed', 2],
  ]) {
    calls = 0;
    await assert.rejects(
      fetchSourceJson('https://source.example/a', {
        ...base,
        ...options,
        fetchImpl: async () => {
          calls++;
          throw reset();
        },
      }),
      { code: expectedCode },
    );
    assert.equal(calls, expectedCalls);
  }
  const abort = new AbortController();
  calls = 0;
  const reason = new Error('cancelled');
  await assert.rejects(
    fetchSourceJson('https://source.example/a', {
      ...base,
      signal: abort.signal,
      fetchImpl: async () => {
        calls++;
        abort.abort(reason);
        throw reset();
      },
    }),
    (error) => error === reason,
  );
  assert.equal(calls, 1);
});
test('bounded source HTTP rejects untrusted URL origins before sending credentials', async () => {
  let calls = 0;
  for (const url of [
    'https://other.example/a',
    'https://user:password@source.example/a',
    'https://source.example/a#b',
  ]) {
    await assert.rejects(
      fetchSourceJson(url, {
        ...base,
        headers: { Authorization: 'Bearer synthetic' },
        fetchImpl: async () => {
          calls++;
        },
      }),
      { code: 'source_url_rejected' },
    );
  }
  assert.equal(calls, 0);
});

test('source HTTP aborts stalled JSON bodies, releases reader and redacts upstream error bodies', async () => {
  let cancelled = 0;
  await assert.rejects(
    fetchSourceJson('https://source.example/a', {
      ...base,
      stallMs: 10,
      fetchImpl: async () =>
        new Response(
          new ReadableStream({
            cancel() {
              cancelled++;
            },
          }),
          { headers: { 'content-type': 'application/json' } },
        ),
    }),
    { code: 'source_timeout' },
  );
  assert.equal(cancelled, 1);
  await assert.rejects(
    fetchSourceJson('https://source.example/a', {
      ...base,
      fetchImpl: async () => new Response('secret upstream response', { status: 500 }),
    }),
    { code: 'source_request_failed', message: 'source_request_failed' },
  );
});

test('source HTTP enforces streamed byte limits and exact UTF-8 JSON decoding', async () => {
  let cancelled = 0;
  await assert.rejects(
    fetchSourceBytes('https://source.example/a', {
      ...base,
      maxBytes: 2,
      fetchImpl: async () =>
        new Response(
          new ReadableStream({
            start(controller) {
              controller.enqueue(new Uint8Array(3));
            },
            cancel() {
              cancelled++;
            },
          }),
          { headers: { 'content-type': 'application/json' } },
        ),
    }),
    { code: 'source_response_limit' },
  );
  assert.equal(cancelled, 1);
  await assert.rejects(
    fetchSourceJson('https://source.example/a', {
      ...base,
      fetchImpl: async () => new Response(new Uint8Array([0xff]), { headers: { 'content-type': 'application/json' } }),
    }),
    { code: 'source_invalid_json' },
  );
});
