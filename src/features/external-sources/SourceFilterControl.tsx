import type { ExternalSourceFilterDefinition, ExternalSourceFilterValue } from '../../external-sources/contracts';

export function SourceFilterControl({
  definition,
  value,
  setValue,
  compactChoices = false,
}: {
  compactChoices?: boolean;
  definition: ExternalSourceFilterDefinition;
  value: ExternalSourceFilterValue | undefined;
  setValue(value: ExternalSourceFilterValue): void;
}) {
  if (definition.kind === 'header') return <strong className="source-hub-filter-header">{definition.label}</strong>;
  if (definition.kind === 'separator') return <hr className="source-hub-filter-separator" />;
  if (definition.kind === 'checkbox') {
    return (
      <label className="source-hub-filter-checkbox">
        <input
          type="checkbox"
          checked={typeof value === 'boolean' ? value : definition.defaultValue}
          onChange={(event) => setValue(event.target.checked)}
        />
        <span>{definition.label}</span>
      </label>
    );
  }
  if (definition.kind === 'text') {
    return (
      <label className="source-hub-filter-field">
        <span>{definition.label}</span>
        <input
          type="text"
          value={typeof value === 'string' ? value : definition.defaultValue}
          onChange={(event) => setValue(event.target.value)}
        />
      </label>
    );
  }
  if (definition.kind === 'tri_state') {
    return (
      <label className="source-hub-filter-field">
        <span>{definition.label}</span>
        <select
          value={typeof value === 'string' ? value : definition.defaultValue}
          onChange={(event) => setValue(event.target.value)}
        >
          <option value="IGNORE">상관없음</option>
          <option value="INCLUDE">포함</option>
          <option value="EXCLUDE">제외</option>
        </select>
      </label>
    );
  }
  if (definition.kind === 'sort') {
    const selected = typeof value === 'object' && value !== null && 'index' in value ? value : definition.defaultValue;
    return (
      <div className="source-hub-filter-field source-hub-filter-sort">
        <label>
          <span>{definition.label}</span>
          <select
            value={selected.index}
            onChange={(event) => setValue({ ...selected, index: Number(event.target.value) })}
          >
            {definition.options.map((option, index) => (
              <option key={option} value={index}>
                {option}
              </option>
            ))}
          </select>
        </label>
        <button
          type="button"
          className="ghost-btn"
          aria-label={`${definition.label} ${selected.ascending ? '오름차순' : '내림차순'}`}
          onClick={() => setValue({ ...selected, ascending: !selected.ascending })}
        >
          {selected.ascending ? '오름차순' : '내림차순'}
        </button>
      </div>
    );
  }
  const selected = typeof value === 'number' ? value : definition.defaultValue;
  if (compactChoices && definition.options.length <= 16)
    return (
      <fieldset className="discovery-filter-choices">
        <legend>{definition.label}</legend>
        <div>
          {definition.options.map((option, index) => (
            <button
              key={index}
              type="button"
              className="ghost-btn"
              aria-pressed={selected === index}
              onClick={() => setValue(index)}
            >
              {option}
            </button>
          ))}
        </div>
      </fieldset>
    );

  return (
    <label className="source-hub-filter-field">
      <span>{definition.label}</span>
      <select value={selected} onChange={(event) => setValue(Number(event.target.value))}>
        {definition.options.map((option, index) => (
          <option key={option} value={index}>
            {option}
          </option>
        ))}
      </select>
    </label>
  );
}
