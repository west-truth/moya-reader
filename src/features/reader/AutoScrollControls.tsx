import { useEffect } from 'react';
import { SettingsSlider } from '../reader-settings/SettingsSlider';
import './auto-scroll-controls.css';
import { Pause } from 'lucide-react';
import { Dialog } from '../../shared/ui/Dialog';
import type { useAutoScroll } from './use-auto-scroll';
import { AUTO_READING_MODES, autoReadingSpeedLabel, type AutoReadingMode } from './auto-reading-modes';

export function AutoScrollControls({
  controller,
  open,
  onClose,
  allowed,
}: {
  readonly controller: ReturnType<typeof useAutoScroll>;
  readonly open: boolean;
  readonly onClose: () => void;
  readonly allowed: boolean;
}) {
  useEffect(() => {
    if (open && !controller.modeAllowed) controller.setMode(controller.supportedModes[0] as AutoReadingMode);
  }, [open, controller]);
  return (
    <div data-auto-scroll-controls>
      <Dialog open={open} title="자동 읽기" onClose={onClose} className="reader-auto-scroll-dialog">
        <label className="reader-auto-scroll-mode">
          방식
          <select
            aria-label="자동 읽기 방식"
            value={controller.mode}
            onChange={(event) => controller.setMode(event.target.value as AutoReadingMode)}
          >
            {AUTO_READING_MODES.filter((mode) => controller.supportedModes.includes(mode.id)).map((mode) => (
              <option key={mode.id} value={mode.id}>
                {mode.label}
              </option>
            ))}
          </select>
        </label>
        <p>화면을 조작하면 멈춥니다.</p>
        {controller.mode === 'page-turn' ? (
          <SettingsSlider
            label="넘김 간격"
            value={controller.interval}
            min={3}
            max={120}
            step={1}
            suffix="초"
            onChange={controller.setInterval}
          />
        ) : (
          <>
            <SettingsSlider
              label="읽기 속도"
              value={controller.mode === 'pixel' ? controller.speed * 5 : controller.speed}
              min={controller.mode === 'pixel' ? 5 : 1}
              max={controller.mode === 'pixel' ? controller.maxSpeed * 5 : controller.maxSpeed}
              step={controller.mode === 'pixel' ? 5 : 1}
              suffix={controller.mode === 'pixel' ? 'px/초' : ''}
              onChange={(value) => controller.setSpeed(controller.mode === 'pixel' ? value / 5 : value)}
            />
            <p>{autoReadingSpeedLabel(controller.mode, controller.speed)}</p>
          </>
        )}
        <label className="reader-auto-scroll-next">
          <input
            type="checkbox"
            checked={controller.continueChapter}
            onChange={(event) => controller.setContinueChapter(event.target.checked)}
          />
          회차 끝에서 다음 회차로 이동
        </label>
        {!allowed && (
          <p>
            {!controller.modeAllowed
              ? '현재 보기에서 사용할 방식을 선택해 주세요.'
              : '본문 준비와 듣기를 마친 뒤 사용할 수 있습니다.'}
          </p>
        )}
        <button
          className="primary-btn"
          type="button"
          disabled={!allowed}
          onClick={() => {
            onClose();
            controller.start();
          }}
        >
          시작
        </button>
      </Dialog>
      {controller.running && (
        <button type="button" className="reader-auto-scroll-stop" onClick={controller.stop} aria-label="자동 읽기 정지">
          <Pause size={16} /> 자동 읽기 정지
        </button>
      )}
    </div>
  );
}
