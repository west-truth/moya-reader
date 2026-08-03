import { Gauge, Headphones, Pause, Play, Settings2, SkipBack, SkipForward, Square, Timer } from 'lucide-react';
import type { TTSSleepTimerPreset } from '../../domain/types';

export interface TTSCompactBarProps {
  readonly bookTitle: string;
  readonly chapterTitle: string;
  readonly speakerLabel?: string;
  readonly playing: boolean;
  readonly paused: boolean;
  readonly busy: boolean;
  readonly rate: number;
  readonly timerPreset?: TTSSleepTimerPreset;
  readonly timerRemainingSeconds?: number;
  readonly status?: string;
  previous(): void;
  next(): void;
  start(): void | Promise<unknown>;
  pause(): void;
  resume(): void;
  stop(): void;
  openSettings(): void;
  setTimer(preset?: TTSSleepTimerPreset): void;
}

function timerLabel(seconds?: number, preset?: TTSSleepTimerPreset): string {
  if (seconds !== undefined) {
    const minutes = Math.floor(seconds / 60);
    return `${minutes}:${String(seconds % 60).padStart(2, '0')}`;
  }
  return preset === 'end_of_chapter' ? '화 끝' : '타이머';
}

function playbackStatusLabel(status: string | undefined, busy: boolean): string {
  const labels: Record<string, string> = {
    prefetch_hit: '준비된 음성 재생',
    native_cache_hit: '저장된 음성 재생',
    native_cache_rendered: '음성 준비 완료',
    offline_cache_miss: '저장된 음성 없음 · 시스템 음성 재생',
    synthesizing: '음성 합성 중',
    buffering: '음성 불러오는 중',
    fallback: '시스템 음성으로 재생',
  };
  return (status && (labels[status] ?? status)) || (busy ? '음성을 준비하는 중' : 'TTS');
}

export default function TTSCompactBar(props: TTSCompactBarProps) {
  return (
    <section className="tts-compact-bar" aria-label="TTS 재생 제어" data-playing={props.playing}>
      <div className="tts-compact-identity">
        <Headphones size={17} />
        <span>
          <strong>{props.bookTitle}</strong>
          <small>
            {props.chapterTitle} · {props.speakerLabel ?? playbackStatusLabel(props.status, props.busy)}
          </small>
        </span>
      </div>
      <div className="tts-compact-controls">
        <button className="icon-btn" onClick={props.previous} title="이전 문단" aria-label="이전 문단">
          <SkipBack size={17} />
        </button>
        {!props.playing ? (
          <button className="icon-btn primary" onClick={() => void props.start()} title="재생" aria-label="TTS 재생">
            <Play size={18} />
          </button>
        ) : props.paused ? (
          <button className="icon-btn primary" onClick={props.resume} title="계속" aria-label="TTS 계속 재생">
            <Play size={18} />
          </button>
        ) : (
          <button className="icon-btn primary" onClick={props.pause} title="일시정지" aria-label="TTS 일시정지">
            <Pause size={18} />
          </button>
        )}
        <button className="icon-btn" onClick={props.next} title="다음 문단" aria-label="다음 문단">
          <SkipForward size={17} />
        </button>
        <button className="tts-compact-value" onClick={props.openSettings} title="청취 설정">
          <Gauge size={15} /> {props.rate.toFixed(1)}x
        </button>
        <label className="tts-compact-timer" title="수면 타이머">
          <Timer size={15} />
          <select
            aria-label="수면 타이머"
            value={props.timerPreset === undefined ? '' : String(props.timerPreset)}
            onChange={(event) => {
              const value = event.target.value;
              props.setTimer(
                value === 'end_of_chapter' ? value : value ? (Number(value) as 10 | 20 | 30 | 60) : undefined,
              );
            }}
          >
            <option value="">끔</option>
            <option value="10">10분</option>
            <option value="20">20분</option>
            <option value="30">30분</option>
            <option value="60">60분</option>
            <option value="end_of_chapter">화 끝</option>
          </select>
          <span>{timerLabel(props.timerRemainingSeconds, props.timerPreset)}</span>
        </label>
        <button className="icon-btn" onClick={props.openSettings} title="청취 설정" aria-label="청취 설정 열기">
          <Settings2 size={17} />
        </button>
        <button className="icon-btn" onClick={props.stop} title="정지" aria-label="TTS 정지">
          <Square size={16} />
        </button>
      </div>
    </section>
  );
}
