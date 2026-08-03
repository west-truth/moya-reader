import type { ReadingSessionEvent, UserFontAsset } from '../domain/types';
import type { RemoteApiClient } from '../services/remote/remote-api-client';
import type { InstallUserFontInput, ReaderPersonalizationRepository } from './reader-personalization-repository';

function queryString(values: Record<string, string | undefined>): string {
  const query = new URLSearchParams();
  Object.entries(values).forEach(([key, value]) => {
    if (value) query.set(key, value);
  });
  const serialized = query.toString();
  return serialized ? `?${serialized}` : '';
}

export class RemoteReaderPersonalizationRepository implements ReaderPersonalizationRepository {
  constructor(private readonly client: RemoteApiClient) {}

  async listUserFonts(): Promise<UserFontAsset[]> {
    return (await this.client.request<{ fonts: UserFontAsset[] }>('/fonts')).fonts;
  }

  async getUserFontContent(id: string): Promise<Blob | undefined> {
    try {
      return (await this.client.requestBlob(`/fonts/${encodeURIComponent(id)}/content`)).blob;
    } catch (error) {
      if (typeof error === 'object' && error && 'status' in error && Number(error.status) === 404) return undefined;
      throw error;
    }
  }

  async installUserFont(input: InstallUserFontInput): Promise<UserFontAsset> {
    const asset = input.asset;
    const response = await this.client.request<{ font: UserFontAsset }>(`/fonts/${encodeURIComponent(asset.id)}`, {
      method: 'PUT',
      body: input.blob,
      headers: {
        'Content-Type': 'application/octet-stream',
        'X-Font-Content-Type': asset.contentType,
        'X-Font-Content-Hash': asset.contentHash,
        'X-Font-Family': encodeURIComponent(asset.familyLabel),
        'X-Font-File-Name': encodeURIComponent(asset.fileName),
        'X-Font-Style': asset.style,
        'X-Font-Weight': String(asset.weight),
        ...(asset.licenseNote ? { 'X-Font-License-Note': encodeURIComponent(asset.licenseNote) } : {}),
      },
    });
    return response.font;
  }

  async updateUserFont(id: string, patch: Pick<UserFontAsset, 'familyLabel' | 'licenseNote'>): Promise<UserFontAsset> {
    const response = await this.client.request<{ font: UserFontAsset }>(`/fonts/${encodeURIComponent(id)}`, {
      method: 'PATCH',
      body: JSON.stringify(patch),
    });
    return response.font;
  }

  deleteUserFont(id: string): Promise<void> {
    return this.client.request(`/fonts/${encodeURIComponent(id)}`, { method: 'DELETE' }).then(() => undefined);
  }

  appendReadingSession(event: ReadingSessionEvent): Promise<void> {
    return this.client
      .request('/reading-sessions', { method: 'POST', body: JSON.stringify(event) })
      .then(() => undefined);
  }

  async listReadingSessions(
    options: { bookId?: string; from?: string; to?: string } = {},
  ): Promise<ReadingSessionEvent[]> {
    const response = await this.client.request<{ sessions: ReadingSessionEvent[] }>(
      `/reading-sessions${queryString(options)}`,
    );
    return response.sessions;
  }

  async deleteReadingSessions(options: { bookId?: string; before?: string } = {}): Promise<number> {
    const response = await this.client.request<{ deleted: number }>(`/reading-sessions${queryString(options)}`, {
      method: 'DELETE',
    });
    return response.deleted;
  }
}
