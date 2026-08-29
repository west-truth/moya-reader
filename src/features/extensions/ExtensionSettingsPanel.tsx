import { Boxes, ShieldCheck } from 'lucide-react';
import type { ReactNode } from 'react';
import type { ExtensionContributionId, ExtensionPermission } from '@noveldesk/extension-contracts';
import type { AppExtensionSnapshot, ExtensionContributionKind } from '../../extensions/app-extension-manager';

const permissionLabels: Record<ExtensionPermission, string> = {
  'analysis.workflow.execute': '앱이 제공한 AI 실행 경계 사용',
  'app.command.execute': '앱 명령 등록',
  'book.enrichment.propose': '작품 정보·표지 후보 제안',
  'external.source.download': '선택한 외부 원문 가져오기',
  'external.source.list': '외부 작품·파일 목록 보기',
  'reader.addon.render': 'Reader 보조 패널 표시',
  'reader.context.read': '현재 Reader 문맥 사용',
};

const contributionLabels: Record<ExtensionContributionKind, string> = {
  reader_addon: 'Reader 패널',
  command: '명령',
  analysis: 'AI 기능',
  book_enrichment: '작품 보강',
  external_source: '외부 소스',
};

function stateLabel(extension: AppExtensionSnapshot): string {
  if (extension.trustLevel === 'sandboxed' && extension.state === 'failed') return '지원 안 함';
  if (extension.state === 'failed') return '실행 실패';
  return extension.enabled ? '사용 중' : '꺼짐';
}

function ExtensionCard({
  extension,
  setEnabled,
  details,
}: {
  extension: AppExtensionSnapshot;
  setEnabled(extensionId: ExtensionContributionId, enabled: boolean): void;
  details?: ReactNode;
}) {
  return (
    <article className="extension-settings-card">
      <div className="extension-settings-card-heading">
        <div>
          <div className="extension-settings-title-row">
            <strong>{extension.name}</strong>
            {extension.beta && <span className="extension-badge beta">Beta</span>}
            <span className="extension-badge">{extension.origin === 'bundled' ? '내장' : '커뮤니티'}</span>
          </div>
          <span className="muted">
            v{extension.version} · {extension.trustLevel === 'trusted' ? '앱과 함께 검증됨' : '격리 실행 미지원'}
          </span>
        </div>
        <label className="reader-settings-toggle extension-enable-toggle">
          <input
            type="checkbox"
            checked={extension.enabled}
            disabled={!extension.canDisable}
            onChange={(event) => setEnabled(extension.id, event.target.checked)}
            aria-label={`${extension.name} ${extension.enabled ? '끄기' : '켜기'}`}
          />
          <span>{stateLabel(extension)}</span>
        </label>
      </div>
      {extension.description && <p>{extension.description}</p>}
      {extension.errorMessage && (
        <p className="field-help warning" role="alert">
          {extension.errorMessage}
        </p>
      )}
      <details>
        <summary>제공 기능과 권한</summary>
        <div className="extension-settings-details">
          <div>
            <span className="extension-detail-label">제공 기능</span>
            <ul>
              {extension.contributions.map((contribution) => (
                <li key={contribution.id}>
                  {contributionLabels[contribution.kind]} · {contribution.title}
                </li>
              ))}
            </ul>
          </div>
          <div>
            <span className="extension-detail-label">요청 권한</span>
            <ul>
              {extension.permissions.map((permission) => (
                <li key={permission}>{permissionLabels[permission]}</li>
              ))}
            </ul>
          </div>
        </div>
      </details>
      {details && (
        <details className="extension-custom-settings" open={extension.enabled}>
          <summary>세부 설정</summary>
          <div className="extension-custom-settings-body">{details}</div>
        </details>
      )}
    </article>
  );
}

export function ExtensionSettingsPanel({
  extensions,
  setEnabled,
  renderDetails,
}: {
  extensions: readonly AppExtensionSnapshot[];
  setEnabled(extensionId: ExtensionContributionId, enabled: boolean): void;
  renderDetails?(extension: AppExtensionSnapshot): ReactNode;
}) {
  const bundled = extensions.filter((extension) => extension.origin === 'bundled');
  const community = extensions.filter((extension) => extension.origin === 'community');
  return (
    <div className="extension-settings-sections">
      <section className="settings-section-card">
        <div className="settings-section-heading">
          <Boxes size={18} aria-hidden="true" />
          <div>
            <h3>내장 익스텐션</h3>
            <p>앱과 함께 검토·배포되며 언제든 이 기기에서 끌 수 있습니다.</p>
          </div>
        </div>
        <div className="extension-settings-list">
          {bundled.map((extension) => (
            <ExtensionCard
              key={extension.id}
              extension={extension}
              setEnabled={setEnabled}
              details={renderDetails?.(extension)}
            />
          ))}
        </div>
      </section>
      <section className="settings-section-card">
        <div className="settings-section-heading">
          <ShieldCheck size={18} aria-hidden="true" />
          <div>
            <h3>커뮤니티 플러그인</h3>
            <p>향후 별도 권한 검토와 격리 실행 환경을 통해 제공됩니다.</p>
          </div>
        </div>
        {community.length === 0 ? (
          <p className="muted extension-community-empty">설치된 커뮤니티 플러그인이 없습니다.</p>
        ) : (
          <div className="extension-settings-list">
            {community.map((extension) => (
              <ExtensionCard
                key={extension.id}
                extension={extension}
                setEnabled={setEnabled}
                details={renderDetails?.(extension)}
              />
            ))}
          </div>
        )}
      </section>
    </div>
  );
}
