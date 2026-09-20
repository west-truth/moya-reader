import { useEffect, useId, useRef, useState, type KeyboardEvent, type PointerEvent } from 'react';

interface SettingsSliderProps {
  readonly label: string;
  readonly value: number;
  readonly min: number;
  readonly max: number;
  readonly step: number;
  readonly suffix?: string;
  readonly onChange: (value: number) => void;
}

export function SettingsSlider({ label, value, min, max, step, suffix = '', onChange }: SettingsSliderProps) {
  const sliderId = useId();
  const labelId = `${sliderId}-label`;
  const valueId = `${sliderId}-value`;
  const trackRef = useRef<HTMLDivElement>(null);
  const dragRef = useRef<{
    pointerId: number;
    startX: number;
    startY: number;
    startValue: number;
    horizontal: boolean;
  }>();
  const [draft, setDraft] = useState(value);
  const [numberDraft, setNumberDraft] = useState(formatNumber(value, step));

  useEffect(() => {
    if (dragRef.current) return;
    setDraft(value);
    setNumberDraft(formatNumber(value, step));
  }, [step, value]);

  const commit = (nextValue: number) => {
    const next = normalizeSliderValue(nextValue, min, max, step);
    setDraft(next);
    setNumberDraft(formatNumber(next, step));
    if (next !== value) onChange(next);
  };
  const formattedValue = `${formatNumber(draft, step)}${suffix}`;
  const position = max === min ? 0 : ((draft - min) / (max - min)) * 100;

  const handlePointerDown = (event: PointerEvent<HTMLButtonElement>) => {
    if (!event.isPrimary || (event.pointerType === 'mouse' && event.button !== 0)) return;
    dragRef.current = {
      pointerId: event.pointerId,
      startX: event.clientX,
      startY: event.clientY,
      startValue: draft,
      horizontal: false,
    };
    event.currentTarget.setPointerCapture(event.pointerId);
  };

  const handlePointerMove = (event: PointerEvent<HTMLButtonElement>) => {
    const drag = dragRef.current;
    const track = trackRef.current;
    if (!drag || drag.pointerId !== event.pointerId || !track) return;
    const deltaX = event.clientX - drag.startX;
    const deltaY = event.clientY - drag.startY;
    if (!drag.horizontal) {
      if (Math.max(Math.abs(deltaX), Math.abs(deltaY)) < 5) return;
      if (Math.abs(deltaY) > Math.abs(deltaX)) return;
      drag.horizontal = true;
    }
    event.preventDefault();
    const direction = getComputedStyle(track).direction === 'rtl' ? -1 : 1;
    const next = drag.startValue + (deltaX * direction * (max - min)) / Math.max(track.clientWidth, 1);
    setDraft(normalizeSliderValue(next, min, max, step));
  };

  const finishDrag = (event: PointerEvent<HTMLButtonElement>, cancelled: boolean) => {
    const drag = dragRef.current;
    if (!drag || drag.pointerId !== event.pointerId) return;
    dragRef.current = undefined;
    if (event.currentTarget.hasPointerCapture(event.pointerId))
      event.currentTarget.releasePointerCapture(event.pointerId);
    if (cancelled || !drag.horizontal) {
      setDraft(value);
      setNumberDraft(formatNumber(value, step));
      return;
    }
    commit(draft);
  };

  const handleKeyDown = (event: KeyboardEvent<HTMLButtonElement>) => {
    let next: number | undefined;
    if (event.key === 'ArrowLeft' || event.key === 'ArrowDown') next = draft - step;
    if (event.key === 'ArrowRight' || event.key === 'ArrowUp') next = draft + step;
    if (event.key === 'PageDown') next = draft - step * 10;
    if (event.key === 'PageUp') next = draft + step * 10;
    if (event.key === 'Home') next = min;
    if (event.key === 'End') next = max;
    if (next === undefined) return;
    event.preventDefault();
    commit(next);
  };

  const commitNumberDraft = (input: HTMLInputElement) => {
    const parsed = Number(input.value);
    if (Number.isFinite(parsed)) commit(parsed);
    else setNumberDraft(formatNumber(value, step));
  };

  return (
    <section className="reader-settings-slider">
      <div className="reader-settings-slider-heading">
        <span id={labelId}>{label}</span>
        <output id={valueId}>{formattedValue}</output>
      </div>
      <div className="reader-settings-slider-controls">
        <button
          type="button"
          className="reader-settings-slider-step"
          aria-label={`${label} 줄이기`}
          onClick={() => commit(draft - step)}
        >
          −
        </button>
        <div className="reader-settings-slider-track-wrap">
          <div ref={trackRef} className="reader-settings-slider-track" aria-hidden="true">
            <span className="reader-settings-slider-fill" style={{ inlineSize: `${position}%` }} />
            <button
              id={sliderId}
              type="button"
              className="reader-settings-slider-thumb"
              style={{ '--reader-slider-position': `${position}%` } as React.CSSProperties}
              role="slider"
              aria-labelledby={`${labelId} ${valueId}`}
              aria-valuemin={min}
              aria-valuemax={max}
              aria-valuenow={draft}
              aria-valuetext={formattedValue}
              onKeyDown={handleKeyDown}
              onPointerDown={handlePointerDown}
              onPointerMove={handlePointerMove}
              onPointerUp={(event) => finishDrag(event, false)}
              onPointerCancel={(event) => finishDrag(event, true)}
            />
          </div>
        </div>
        <button
          type="button"
          className="reader-settings-slider-step"
          aria-label={`${label} 늘리기`}
          onClick={() => commit(draft + step)}
        >
          +
        </button>
        <label className="reader-settings-slider-number">
          <span className="sr-only">{label} 직접 입력</span>
          <input
            type="number"
            min={min}
            max={max}
            step={step}
            value={numberDraft}
            inputMode="decimal"
            aria-label={`${label} 직접 입력`}
            onChange={(event) => setNumberDraft(event.target.value)}
            onBlur={(event) => commitNumberDraft(event.currentTarget)}
            onKeyDown={(event) => {
              if (event.key === 'Enter') event.currentTarget.blur();
              if (event.key === 'Escape') {
                event.currentTarget.value = formatNumber(value, step);
                setNumberDraft(formatNumber(value, step));
                event.currentTarget.blur();
              }
            }}
          />
          {suffix && <span aria-hidden="true">{suffix}</span>}
        </label>
      </div>
    </section>
  );
}

function normalizeSliderValue(value: number, min: number, max: number, step: number): number {
  const clamped = Math.min(max, Math.max(min, value));
  const precision = decimalPlaces(step);
  const stepped = min + Math.round((clamped - min) / step) * step;
  return Number(Math.min(max, Math.max(min, stepped)).toFixed(precision));
}

function formatNumber(value: number, step: number): string {
  return value
    .toFixed(decimalPlaces(step))
    .replace(/\.0+$/u, '')
    .replace(/(\.\d*?)0+$/u, '$1');
}

function decimalPlaces(value: number): number {
  const [, fraction = ''] = String(value).split('.');
  return fraction.length;
}
