import { structuredIntegrityHash } from '../../domain/identity/structured-integrity';
import { providerOptionsContainSecretLikeValue } from '../provider-options-secret-guard';
import { requestToPromise, transactionDone } from '../indexeddb-transaction';
import { openReaderDb } from '../reader-database';
import { nowIso } from '../sync-event-store';
import { NATIVE_ANALYSIS_STORES } from './schema';
import { nativeLabelingContractFingerprint, normalizeNativeLabelingContract } from './labeling-contract';
import type {
  NativeAnalysisProviderDescriptor,
  NativeAnalysisWorkflowDescriptor,
  NativeAnalysisWorkflowDescriptorInput,
} from './types';

const MAX_IDENTIFIER_LENGTH = 512;

function normalizedIdentifier(value: string, label: string): string {
  if (typeof value !== 'string' || !value.trim()) throw new Error(`${label} must be a non-empty string`);
  const normalized = value.trim();
  if (normalized.length > MAX_IDENTIFIER_LENGTH) {
    throw new Error(`${label} must not exceed ${MAX_IDENTIFIER_LENGTH} characters`);
  }
  return normalized;
}

function normalizedProvider(provider: NativeAnalysisProviderDescriptor): NativeAnalysisProviderDescriptor {
  if (!provider || typeof provider !== 'object') {
    throw new Error('native analysis provider descriptor is required');
  }
  if (
    !provider.providerOptions ||
    typeof provider.providerOptions !== 'object' ||
    Array.isArray(provider.providerOptions)
  ) {
    throw new Error('native analysis provider options must be an object');
  }
  return {
    providerId: normalizedIdentifier(provider.providerId, 'native analysis provider id'),
    modelId: normalizedIdentifier(provider.modelId, 'native analysis model id'),
    providerOptions: structuredClone(provider.providerOptions),
  };
}

function normalizedDescriptor(input: NativeAnalysisWorkflowDescriptorInput): NativeAnalysisWorkflowDescriptorInput {
  const workflowId = normalizedIdentifier(input.workflowId, 'native analysis workflow id');
  const novelId = normalizedIdentifier(input.novelId, 'native analysis novel id');
  const planNovelId = normalizedIdentifier(input.plan?.novelId, 'native analysis plan novel id');
  if (planNovelId !== novelId) throw new Error('native analysis workflow plan novel id does not match novel id');
  const plan = structuredClone(input.plan);
  return {
    workflowId,
    novelId,
    contentRevisionId: normalizedIdentifier(input.contentRevisionId, 'native analysis content revision id'),
    planHash: normalizedIdentifier(input.planHash, 'native analysis plan hash'),
    plan: { ...plan, novelId },
    provider: normalizedProvider(input.provider),
    ...(input.labelingContract ? { labelingContract: normalizeNativeLabelingContract(input.labelingContract) } : {}),
  };
}

export function nativeAnalysisWorkflowDescriptorFingerprint(descriptor: NativeAnalysisWorkflowDescriptorInput): string {
  const legacyPayload = {
    workflowId: descriptor.workflowId,
    novelId: descriptor.novelId,
    contentRevisionId: descriptor.contentRevisionId,
    planHash: descriptor.planHash,
    plan: descriptor.plan,
    provider: descriptor.provider,
  };
  if (!descriptor.labelingContract) return structuredIntegrityHash(legacyPayload);
  const labelingContract = normalizeNativeLabelingContract(descriptor.labelingContract);
  return structuredIntegrityHash({
    ...legacyPayload,
    labelingContract,
    labelingContractFingerprint: nativeLabelingContractFingerprint(labelingContract),
  });
}

function assertStoredFingerprint(descriptor: NativeAnalysisWorkflowDescriptor): void {
  const expectedContractFingerprint = descriptor.labelingContract
    ? nativeLabelingContractFingerprint(descriptor.labelingContract)
    : undefined;
  if (descriptor.labelingContractFingerprint !== expectedContractFingerprint) {
    throw new Error(`Native analysis workflow labeling contract fingerprint mismatch: ${descriptor.workflowId}`);
  }
  if (descriptor.descriptorFingerprint !== nativeAnalysisWorkflowDescriptorFingerprint(descriptor)) {
    throw new Error(`Native analysis workflow descriptor fingerprint mismatch: ${descriptor.workflowId}`);
  }
}

export async function saveNativeAnalysisWorkflowDescriptor(
  input: NativeAnalysisWorkflowDescriptorInput,
): Promise<NativeAnalysisWorkflowDescriptor> {
  if (providerOptionsContainSecretLikeValue(input.provider?.providerOptions)) {
    throw new Error('native analysis provider options must not contain secret-like keys or values');
  }
  const normalized = normalizedDescriptor(input);
  const descriptorFingerprint = nativeAnalysisWorkflowDescriptorFingerprint(normalized);
  const db = await openReaderDb();
  const tx = db.transaction(NATIVE_ANALYSIS_STORES.descriptors, 'readwrite');
  const store = tx.objectStore(NATIVE_ANALYSIS_STORES.descriptors);
  const existing = await requestToPromise<NativeAnalysisWorkflowDescriptor | undefined>(
    store.get(normalized.workflowId),
  );
  if (existing) {
    assertStoredFingerprint(existing);
    if (existing.descriptorFingerprint !== descriptorFingerprint) {
      tx.abort();
      throw new Error(`Native analysis workflow descriptor drift: ${normalized.workflowId}`);
    }
    await transactionDone(tx);
    return existing;
  }

  const timestamp = nowIso();
  const descriptor: NativeAnalysisWorkflowDescriptor = {
    ...normalized,
    ...(normalized.labelingContract
      ? { labelingContractFingerprint: nativeLabelingContractFingerprint(normalized.labelingContract) }
      : {}),
    descriptorFingerprint,
    createdAt: timestamp,
    updatedAt: timestamp,
  };
  store.add(descriptor);
  await transactionDone(tx);
  return descriptor;
}

export async function getNativeAnalysisWorkflowDescriptor(
  workflowId: string,
): Promise<NativeAnalysisWorkflowDescriptor | undefined> {
  const normalizedWorkflowId = normalizedIdentifier(workflowId, 'native analysis workflow id');
  const db = await openReaderDb();
  const tx = db.transaction(NATIVE_ANALYSIS_STORES.descriptors, 'readonly');
  const descriptor = await requestToPromise<NativeAnalysisWorkflowDescriptor | undefined>(
    tx.objectStore(NATIVE_ANALYSIS_STORES.descriptors).get(normalizedWorkflowId),
  );
  await transactionDone(tx);
  if (descriptor) assertStoredFingerprint(descriptor);
  return descriptor;
}

export async function deleteNativeAnalysisWorkflowDescriptor(workflowId: string): Promise<boolean> {
  const normalizedWorkflowId = normalizedIdentifier(workflowId, 'native analysis workflow id');
  const db = await openReaderDb();
  const tx = db.transaction(NATIVE_ANALYSIS_STORES.descriptors, 'readwrite');
  const store = tx.objectStore(NATIVE_ANALYSIS_STORES.descriptors);
  const existingKey = await requestToPromise<IDBValidKey | undefined>(store.getKey(normalizedWorkflowId));
  if (existingKey !== undefined) store.delete(normalizedWorkflowId);
  await transactionDone(tx);
  return existingKey !== undefined;
}
