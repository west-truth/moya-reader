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
  return (
    <div data-auto-scroll-controls>
      <Dialog open={open} title="자동 스크롤" onClose={onClose} className="reader-auto-scroll-dialog">
        <label className="reader-auto-scroll-mode">
          방식
          <select
            aria-label="자동 읽기 방식"
            value={controller.mode}
            onChange={(event) => controller.setMode(event.target.value as AutoReadingMode)}
          >
            {AUTO_READING_MODES.map((mode) => (
              <option key={mode.id} value={mode.id}>
                {mode.label}
              </option>
            ))}
          </select>
        </label>
        <p>{AUTO_READING_MODES.find((mode) => mode.id === controller.mode)?.description} 화면을 조작하면 멈춥니다.</p>
        <label className="reader-auto-scroll-speed">
          <span>
            속도 <output>{autoReadingSpeedLabel(controller.mode, controller.speed)}</output>
          </span>
          <input
            aria-label="자동 스크롤 속도"
            type="range"
            min="1"
            max="12"
            step="1"
            value={controller.speed}
            onChange={(event) => controller.setSpeed(Number(event.target.value))}
          />
          <span>
            <small>느리게</small>
            <small>빠르게</small>
          </span>
        </label>
        <label className="reader-auto-scroll-next">
          <input
            type="checkbox"
            checked={controller.continueChapter}
            onChange={(event) => controller.setContinueChapter(event.target.checked)}
          />
          회차 끝에서 다음 회차로 이동
        </label>
        {!allowed && <p>스크롤 모드에서 본문 준비와 듣기를 마친 뒤 사용할 수 있습니다.</p>}
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
        <button
          type="button"
          className="reader-auto-scroll-stop"
          onClick={controller.stop}
          aria-label="자동 스크롤 정지"
        >
          <Pause size={16} /> 자동 스크롤 정지
        </button>
      )}
    </div>
  );
}
