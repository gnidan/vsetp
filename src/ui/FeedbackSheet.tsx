import type { Card, Mark, Point, Track } from "../model";
import { cardKey } from "../model";
import { reading } from "./readings";

// What a live-stage tap resolved to; Session holds one of these
// while a sheet is up. `at` is the tap in live-frame coordinates —
// positional marks (not-a-card, missed-card) carry it verbatim.
export type SheetRequest =
  | { kind: "card"; track: Track; at: Point }
  | { kind: "chooser"; tracks: Track[]; at: Point }
  | { kind: "empty"; at: Point };

function trackLabel(track: Track): string {
  return track.reading ? reading(track.reading) : "A card still being read";
}

function CardActions({
  card,
  at,
  onMark,
}: {
  card: Card | null;
  at: Point;
  onMark(mark: Mark, confirmation: string): void;
}) {
  return (
    <div className="sheet-actions">
      {card && (
        <>
          <button
            onClick={() =>
              onMark({ type: "correct", key: cardKey(card) }, "Marked correct.")
            }
          >
            Correct
          </button>
          <button
            onClick={() =>
              onMark(
                { type: "wrong", key: cardKey(card) },
                "Marked wrong reading.",
              )
            }
          >
            Wrong reading
          </button>
        </>
      )}
      <button
        onClick={() => onMark({ type: "not-a-card", at }, "Marked not a card.")}
      >
        Not a card
      </button>
    </div>
  );
}

// Bottom sheet over the running feed. Dismisses on action or on a
// backdrop tap; every button meets the 44pt floor (app.css).
export function FeedbackSheet({
  request,
  onMark,
  onChoose,
  onDismiss,
}: {
  request: SheetRequest;
  onMark(mark: Mark, confirmation: string): void;
  onChoose(track: Track): void;
  onDismiss(): void;
}) {
  return (
    <div className="sheet-backdrop" onClick={onDismiss}>
      <div
        className="feedback-sheet"
        role="dialog"
        aria-label="Card feedback"
        onClick={(event) => event.stopPropagation()}
      >
        {request.kind === "card" && (
          <>
            <p className="sheet-title">{trackLabel(request.track)}</p>
            <CardActions
              card={request.track.reading ?? null}
              at={request.at}
              onMark={onMark}
            />
          </>
        )}
        {request.kind === "chooser" && (
          <>
            <p className="sheet-title">Which card?</p>
            <div className="sheet-actions">
              {request.tracks.map((track) => (
                <button key={track.trackId} onClick={() => onChoose(track)}>
                  {trackLabel(track)}
                </button>
              ))}
            </div>
          </>
        )}
        {request.kind === "empty" && (
          <>
            <p className="sheet-title">No card read at that spot.</p>
            <div className="sheet-actions">
              {/* the confirmation beat: a missed-card mark only ever
                  fires from this explicit button, never from the tap
                  itself (spec: grip-grazes must not pollute the log) */}
              <button
                onClick={() =>
                  onMark(
                    { type: "missed-card", at: request.at },
                    "Looking for a card there.",
                  )
                }
              >
                There&rsquo;s a card here
              </button>
              <button onClick={onDismiss}>Cancel</button>
            </div>
          </>
        )}
      </div>
    </div>
  );
}
