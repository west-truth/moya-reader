import 'fake-indexeddb/auto';
import { beforeEach, describe, expect, it } from 'vitest';
import { requestToPromise, transactionDone } from '../../../storage/indexeddb-transaction';
import {
  inspectOcrLanguageModelCache,
  ocrLanguageModelByteLength,
  ocrLanguageModelCacheKey,
  removeOcrLanguageModelCache,
} from './ocr-language-model-cache';

async function deleteCacheDatabase(): Promise<void> {
  await new Promise<void>((resolve, reject) => {
    const request = indexedDB.deleteDatabase('keyval-store');
    request.onsuccess = () => resolve();
    request.onerror = () => reject(request.error);
    request.onblocked = () => reject(new Error('cache database deletion was blocked'));
  });
}

async function seedCache(entries: ReadonlyArray<readonly [string, unknown]>): Promise<void> {
  const database = await new Promise<IDBDatabase>((resolve, reject) => {
    const request = indexedDB.open('keyval-store', 1);
    request.onupgradeneeded = () => request.result.createObjectStore('keyval');
    request.onsuccess = () => resolve(request.result);
    request.onerror = () => reject(request.error);
  });
  const transaction = database.transaction('keyval', 'readwrite');
  const done = transactionDone(transaction);
  for (const [key, value] of entries) transaction.objectStore('keyval').put(value, key);
  await done;
  database.close();
}

beforeEach(deleteCacheDatabase);

describe('OCR language model cache', () => {
  it('reports exact Tesseract language keys and stored sizes', async () => {
    await seedCache([
      [ocrLanguageModelCacheKey('kor'), new Uint8Array(17)],
      [ocrLanguageModelCacheKey('eng'), new Blob(['english'])],
    ]);

    await expect(inspectOcrLanguageModelCache()).resolves.toEqual([
      { language: 'kor', installed: true, byteLength: 17 },
      { language: 'jpn', installed: false, byteLength: 0 },
      { language: 'eng', installed: true, byteLength: 7 },
    ]);
  });

  it('removes only the selected language data', async () => {
    await seedCache([
      [ocrLanguageModelCacheKey('kor'), new Uint8Array(3)],
      [ocrLanguageModelCacheKey('eng'), new Uint8Array(5)],
      ['unrelated-key', 'keep'],
    ]);

    await expect(removeOcrLanguageModelCache(['kor'])).resolves.toBe(1);
    await expect(inspectOcrLanguageModelCache(['kor', 'eng'])).resolves.toEqual([
      { language: 'kor', installed: false, byteLength: 0 },
      { language: 'eng', installed: true, byteLength: 5 },
    ]);

    const database = await new Promise<IDBDatabase>((resolve, reject) => {
      const request = indexedDB.open('keyval-store');
      request.onsuccess = () => resolve(request.result);
      request.onerror = () => reject(request.error);
    });
    const transaction = database.transaction('keyval', 'readonly');
    const done = transactionDone(transaction);
    await expect(requestToPromise(transaction.objectStore('keyval').get('unrelated-key'))).resolves.toBe('keep');
    await done;
    database.close();
  });

  it('measures common browser cache value shapes', () => {
    expect(ocrLanguageModelByteLength(new ArrayBuffer(4))).toBe(4);
    expect(ocrLanguageModelByteLength(new Uint16Array(3))).toBe(6);
    expect(ocrLanguageModelByteLength('unknown')).toBe(0);
  });
});
