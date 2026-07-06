// Fullscreen presence frame for the "presence" reveal mode.
// aria-hidden: the live region and Hud text carry the semantics, and
// the Hud text is CVD-load-bearing — border and text always appear
// together.
export function PresenceBorder({ present }: { present: boolean }) {
  return (
    <div
      className={`presence-border ${present ? "present" : "absent"}`}
      aria-hidden="true"
    />
  );
}
