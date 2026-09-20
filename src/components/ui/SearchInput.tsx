interface Props {
  name: string;
  defaultValue?: string;
  label: string;
  placeholder: string;
  buttonLabel: string;
  /** Other URL filters to keep when searching (e.g. the current segment). */
  keep?: Record<string, string | undefined>;
}

/** A plain GET form: works without JavaScript and keeps the filter in the URL. */
export function SearchInput({ name, defaultValue, label, placeholder, buttonLabel, keep = {} }: Props) {
  return (
    <form method="get" role="search" className="search">
      {Object.entries(keep).map(([k, v]) => v && <input key={k} type="hidden" name={k} value={v} />)}
      <input type="search" name={name} defaultValue={defaultValue} aria-label={label} placeholder={placeholder} autoComplete="off" />
      <button type="submit" className="btn ghost sm">
        {buttonLabel}
      </button>
    </form>
  );
}
