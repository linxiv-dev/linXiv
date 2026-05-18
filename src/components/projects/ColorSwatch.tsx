interface ColorSwatchProps {
  color: string | null;
  size?: number;
  selected?: boolean;
  onClick?: () => void;
}

export function ColorSwatch({
  color,
  size = 12,
  selected = false,
  onClick,
}: ColorSwatchProps) {
  const bgColor = color ?? "var(--color-accent)";

  if (onClick) {
    return (
      <button
        type="button"
        onClick={onClick}
        className="rounded-full transition-all focus:outline-none"
        style={{
          width: size,
          height: size,
          backgroundColor: bgColor,
          flexShrink: 0,
          cursor: "pointer",
          boxShadow: selected
            ? `0 0 0 2px var(--color-bg), 0 0 0 4px ${bgColor}`
            : undefined,
        }}
        aria-label={`Select color ${color ?? "accent"}`}
      />
    );
  }

  return (
    <span
      className="rounded-full inline-block"
      style={{
        width: size,
        height: size,
        backgroundColor: bgColor,
        flexShrink: 0,
      }}
    />
  );
}
