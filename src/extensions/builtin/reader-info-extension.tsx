import {
  MOYA_EXTENSION_API_VERSION,
  MOYA_EXTENSION_MANIFEST_VERSION,
  type ExtensionManifestV1,
} from '@noveldesk/extension-contracts';
import { BookWorkspaceInfoPanel } from '../../features/book-workspace/book-workspace-lazy-panels';
import type { TrustedAnalysisWorkflowHostContext } from '../analysis-workflow-host-context';
import type { TrustedReaderAddonHostContext } from '../reader-addon-host-context';
import type { TrustedExtensionDefinition } from '../trusted-extension-registry';

export const READER_INFO_EXTENSION_ID = 'moya.reader.tools' as const;
export const READER_INFO_ADDON_ID = 'moya.reader.tools.info' as const;

const manifest = {
  manifestVersion: MOYA_EXTENSION_MANIFEST_VERSION,
  id: READER_INFO_EXTENSION_ID,
  name: 'Moya Reader information',
  version: '1.0.0',
  engine: { moyaApi: MOYA_EXTENSION_API_VERSION },
  permissions: ['reader.addon.render', 'reader.context.read'],
  contributes: {
    readerAddonTabs: [
      {
        id: READER_INFO_ADDON_ID,
        label: '정보',
        icon: 'file-text',
        order: 10,
      },
    ],
  },
} as const satisfies ExtensionManifestV1;

export const readerInfoTrustedExtension: TrustedExtensionDefinition<
  TrustedReaderAddonHostContext,
  TrustedAnalysisWorkflowHostContext
> = {
  manifest,
  activate(context) {
    return context.readerAddons.register(READER_INFO_ADDON_ID, ({ readerInfo }) => (
      <BookWorkspaceInfoPanel {...readerInfo} />
    ));
  },
};
