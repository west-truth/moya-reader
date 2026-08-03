export const TTS_NEUTRAL_SAMPLE_KO_V1 = 'neutral-ko-v1' as const;

const sampleTextById = {
  [TTS_NEUTRAL_SAMPLE_KO_V1]: '안녕하세요. 이 목소리는 작품 속 인물의 대사를 읽기 위한 음성 샘플입니다.',
} as const;

export type TTSVoiceSampleTextId = keyof typeof sampleTextById;

export function ttsVoiceSampleText(id: string | undefined): string | undefined {
  return id && id in sampleTextById ? sampleTextById[id as TTSVoiceSampleTextId] : undefined;
}

export function ttsVoiceSampleSegmentId(id: TTSVoiceSampleTextId | string): string {
  return `voice-sample:${id}`;
}
