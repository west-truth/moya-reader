import { useId } from 'react';

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
  const inputId = useId();
  const labelId = `${inputId}-label`;
  const valueId = `${inputId}-value`;
  const formattedValue = `${value}${suffix}`;

  return (
    <section className="reader-settings-slider">
      <div className="reader-settings-slider-heading">
        <label id={labelId} htmlFor={inputId}>
          {label}
        </label>
        <output id={valueId} htmlFor={inputId}>
          {formattedValue}
        </output>
      </div>
      <input
        id={inputId}
        type="range"
        min={min}
        max={max}
        step={step}
        value={value}
        aria-labelledby={`${labelId} ${valueId}`}
        aria-valuetext={formattedValue}
        onChange={(event) => onChange(Number(event.target.value))}
      />
    </section>
  );
}
