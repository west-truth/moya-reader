import { describe, expect, it } from 'vitest';
import {
  MOYA_EXTENSION_API_VERSION,
  MOYA_EXTENSION_MANIFEST_VERSION,
  validateExtensionManifest,
  type ExtensionManifestV1,
} from './index';

const validManifest: ExtensionManifestV1 = {
  manifestVersion: MOYA_EXTENSION_MANIFEST_VERSION,
  id: 'example.reader.tools',
  name: 'Reader tools',
  version: '1.0.0',
  engine: { moyaApi: MOYA_EXTENSION_API_VERSION },
  permissions: ['reader.addon.render', 'reader.context.read'],
  contributes: {
    readerAddonTabs: [{ id: 'example.reader.tools.summary', label: '요약', icon: 'file-text', order: 20 }],
  },
};

describe('extension manifest contract', () => {
  it('accepts a versioned, namespaced trusted extension manifest', () => {
    expect(validateExtensionManifest(validManifest)).toEqual({ ok: true, manifest: validManifest });
  });

  it('rejects unsupported APIs, unknown permissions and unscoped contributions', () => {
    const result = validateExtensionManifest({
      ...validManifest,
      engine: { moyaApi: 2 },
      permissions: ['reader.addon.render', 'storage.raw'],
      contributes: {
        readerAddonTabs: [{ id: 'summary', label: '요약', icon: 'unknown' }],
      },
    });

    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.issues.map((issue) => issue.path)).toEqual(
      expect.arrayContaining([
        'engine.moyaApi',
        'permissions[1]',
        'contributes.readerAddonTabs[0].id',
        'contributes.readerAddonTabs[0].icon',
      ]),
    );
  });

  it('rejects duplicate contribution identities across slots', () => {
    const result = validateExtensionManifest({
      ...validManifest,
      permissions: [...validManifest.permissions, 'app.command.execute'],
      contributes: {
        readerAddonTabs: validManifest.contributes?.readerAddonTabs,
        commands: [{ id: 'example.reader.tools.summary', title: '요약 실행' }],
      },
    });

    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.issues).toContainEqual({
      path: 'contributes.commands[0].id',
      message: 'Duplicate contribution id.',
    });
  });

  it('accepts a book analysis workflow and rejects invalid workflow fields', () => {
    const manifest: ExtensionManifestV1 = {
      ...validManifest,
      permissions: [...validManifest.permissions, 'analysis.workflow.execute'],
      contributes: {
        ...validManifest.contributes,
        analysisWorkflows: [
          {
            id: 'example.reader.tools.character-bundle',
            schemaVersion: 1,
            title: '묶음 인물 분석',
            description: '현재 화부터 인물 후보를 준비합니다.',
            target: 'chapter-bundle',
            order: 100,
          },
        ],
      },
    };

    expect(validateExtensionManifest(manifest)).toEqual({ ok: true, manifest });

    const managedManifest: ExtensionManifestV1 = {
      ...manifest,
      contributes: {
        analysisWorkflows: [
          {
            id: 'example.reader.tools.book-preparation',
            schemaVersion: 1,
            title: 'AI 보조 TTS',
            target: 'book',
            kind: 'managed',
          },
        ],
      },
    };
    expect(validateExtensionManifest(managedManifest)).toEqual({ ok: true, manifest: managedManifest });

    const invalid = validateExtensionManifest({
      ...manifest,
      contributes: {
        analysisWorkflows: [
          {
            id: 'character-bundle',
            schemaVersion: 2,
            title: '',
            target: 'chapter',
            kind: 'background',
            order: -1,
          },
        ],
      },
    });

    expect(invalid.ok).toBe(false);
    if (invalid.ok) return;
    expect(invalid.issues.map((issue) => issue.path)).toEqual(
      expect.arrayContaining([
        'contributes.analysisWorkflows[0].id',
        'contributes.analysisWorkflows[0].schemaVersion',
        'contributes.analysisWorkflows[0].title',
        'contributes.analysisWorkflows[0].target',
        'contributes.analysisWorkflows[0].kind',
        'contributes.analysisWorkflows[0].order',
      ]),
    );
  });

  it('accepts a bounded book enrichment provider and rejects invalid capabilities', () => {
    const manifest: ExtensionManifestV1 = {
      ...validManifest,
      permissions: [...validManifest.permissions, 'book.enrichment.propose'],
      contributes: {
        bookEnrichmentProviders: [
          {
            id: 'example.reader.tools.catalog',
            schemaVersion: 1,
            title: '작품 정보 찾기',
            capabilities: ['metadata', 'cover'],
          },
        ],
      },
    };
    expect(validateExtensionManifest(manifest)).toEqual({ ok: true, manifest });

    const invalid = validateExtensionManifest({
      ...manifest,
      contributes: {
        bookEnrichmentProviders: [
          {
            id: 'catalog',
            schemaVersion: 2,
            title: '',
            capabilities: ['metadata', 'metadata', 'raw-content'],
          },
        ],
      },
    });
    expect(invalid.ok).toBe(false);
    if (invalid.ok) return;
    expect(invalid.issues.map((issue) => issue.path)).toEqual(
      expect.arrayContaining([
        'contributes.bookEnrichmentProviders[0].id',
        'contributes.bookEnrichmentProviders[0].schemaVersion',
        'contributes.bookEnrichmentProviders[0].title',
        'contributes.bookEnrichmentProviders[0].capabilities[1]',
        'contributes.bookEnrichmentProviders[0].capabilities[2]',
      ]),
    );
  });

  it('accepts a versioned external source and rejects invalid source declarations', () => {
    const manifest: ExtensionManifestV1 = {
      ...validManifest,
      permissions: ['external.source.list', 'external.source.download'],
      contributes: {
        externalSources: [
          {
            id: 'example.reader.tools.dropbox',
            schemaVersion: 1,
            title: 'Dropbox',
            description: 'Dropbox에 저장된 지원 파일을 찾아 선택해서 가져옵니다.',
            kind: 'cloud_file',
            capabilities: ['browse', 'search', 'file-download'],
            runtimes: ['web-direct'],
            order: 20,
          },
        ],
      },
    };
    expect(validateExtensionManifest(manifest)).toEqual({ ok: true, manifest });

    const invalid = validateExtensionManifest({
      ...manifest,
      contributes: {
        externalSources: [
          {
            id: 'dropbox',
            schemaVersion: 99,
            title: '',
            kind: 'drive',
            capabilities: ['browse', 'browse', 'raw-request'],
            runtimes: ['web-direct', 'web-direct', 'main-realm'],
            order: 1_001,
          },
        ],
      },
    });
    expect(invalid.ok).toBe(false);
    if (invalid.ok) return;
    expect(invalid.issues.map((issue) => issue.path)).toEqual(
      expect.arrayContaining([
        'contributes.externalSources[0].id',
        'contributes.externalSources[0].schemaVersion',
        'contributes.externalSources[0].title',
        'contributes.externalSources[0].kind',
        'contributes.externalSources[0].capabilities[1]',
        'contributes.externalSources[0].capabilities[2]',
        'contributes.externalSources[0].runtimes[1]',
        'contributes.externalSources[0].runtimes[2]',
        'contributes.externalSources[0].order',
      ]),
    );
  });

  it('accepts explicit TXT v2 sources while preserving the v1 capability boundary', () => {
    const source = {
      id: 'example.reader.tools.text',
      schemaVersion: 2,
      title: 'Text',
      kind: 'catalog',
      capabilities: ['browse', 'release-list', 'release-download', 'document-content'],
      runtimes: ['self-host-gateway'],
      seriesProfile: { kind: 'document_series', format: 'txt', encoding: 'utf-8', chapterSplitMode: 'single' },
    };
    const withSource = (value: unknown) => ({ ...validManifest, contributes: { externalSources: [value] } });
    expect(validateExtensionManifest(withSource(source)).ok).toBe(true);
    expect(validateExtensionManifest(withSource({ ...source, schemaVersion: 1 })).ok).toBe(false);
    for (const replacement of [
      { seriesProfile: { ...source.seriesProfile, format: 'epub' } },
      { seriesProfile: { ...source.seriesProfile, script: 'unsupported' } },
      { capabilities: ['release-download', 'document-content'] },
      { capabilities: ['release-list', 'release-download', 'image-content'] },
      { capabilities: [...source.capabilities, 'document-content'] },
    ]) {
      expect(validateExtensionManifest(withSource({ ...source, ...replacement })).ok).toBe(false);
    }
  });
});
