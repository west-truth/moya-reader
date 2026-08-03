import { requestToPromise, transactionDone } from '../../../storage/indexeddb-transaction';

const TESSERACT_CACHE_DB = 'keyval-store';
const TESSERACT_CACHE_STORE = 'keyval';

export const OCR_LANGUAGE_MODELS = ['kor', 'jpn', 'eng'] as const;

export type OcrLanguageModel = (typeof OCR_LANGUAGE_MODELS)[number];

export interface OcrLanguageModelCacheEntry {
  readonly language: OcrLanguageModel;
  readonly installed: boolean;
  readonly byteLength: number;
}

export function ocrLanguageModelCacheKey(language: OcrLanguageModel): string {
  return `./${language}.traineddata`;
}

export function ocrLanguageModelByteLength(value: unknown): number {
  if (value instanceof Blob) return value.size;
  if (value instanceof ArrayBuffer) return value.byteLength;
  if (ArrayBuffer.isView(value)) return value.byteLength;
  return 0;
}

function openTesseractCache(): Promise<IDBDatabase> {
  return new Promise((resolve, reject) => {
    const request = indexedDB.open(TESSERACT_CACHE_DB);
    request.onupgradeneeded = () => {
      if (!request.result.objectStoreNames.contains(TESSERACT_CACHE_STORE)) {
        request.result.createObjectStore(TESSERACT_CACHE_STORE);
      }
    };
    request.onsuccess = () => {
      request.result.onversionchange = () => request.result.close();
      resolve(request.result);
    };
    request.onerror = () => reject(request.error ?? new Error('OCR 언어 데이터 저장소를 열지 못했습니다.'));
    request.onblocked = () => reject(new Error('OCR 언어 데이터 저장소가 다른 작업에서 사용 중입니다.'));
  });
}

function uniqueSupportedLanguages(languages: readonly OcrLanguageModel[]): OcrLanguageModel[] {
  return [...new Set(languages)].filter((language) => OCR_LANGUAGE_MODELS.includes(language));
}

export async function inspectOcrLanguageModelCache(
  languages: readonly OcrLanguageModel[] = OCR_LANGUAGE_MODELS,
): Promise<OcrLanguageModelCacheEntry[]> {
  const selected = uniqueSupportedLanguages(languages);
  if (selected.length === 0) return [];

  const db = await openTesseractCache();
  try {
    if (!db.objectStoreNames.contains(TESSERACT_CACHE_STORE)) {
      throw new Error('OCR 언어 데이터 저장소 형식이 올바르지 않습니다.');
    }
    const transaction = db.transaction(TESSERACT_CACHE_STORE, 'readonly');
    const store = transaction.objectStore(TESSERACT_CACHE_STORE);
    const done = transactionDone(transaction);
    const values = await Promise.all(
      selected.map((language) => requestToPromise(store.get(ocrLanguageModelCacheKey(language)))),
    );
    await done;
    return selected.map((language, index) => ({
      language,
      installed: values[index] !== undefined,
      byteLength: ocrLanguageModelByteLength(values[index]),
    }));
  } finally {
    db.close();
  }
}

export async function removeOcrLanguageModelCache(languages: readonly OcrLanguageModel[]): Promise<number> {
  const selected = uniqueSupportedLanguages(languages);
  if (selected.length === 0) return 0;

  const db = await openTesseractCache();
  try {
    if (!db.objectStoreNames.contains(TESSERACT_CACHE_STORE)) {
      throw new Error('OCR 언어 데이터 저장소 형식이 올바르지 않습니다.');
    }
    const transaction = db.transaction(TESSERACT_CACHE_STORE, 'readwrite');
    const store = transaction.objectStore(TESSERACT_CACHE_STORE);
    const done = transactionDone(transaction);
    for (const language of selected) store.delete(ocrLanguageModelCacheKey(language));
    await done;
    return selected.length;
  } finally {
    db.close();
  }
}
