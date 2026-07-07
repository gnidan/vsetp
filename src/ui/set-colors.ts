import type { SetIdentity } from "../set/identity";
import { SET_LINE_COLORS } from "./set-lines";

// Session-scoped line-color assignment for live sets. Still mode can
// color by array index (a static result never reshuffles), but live
// set lists churn between updates, so colors key on the IDENTITY'S
// FIRST APPEARANCE within the session: a set keeps its color while
// it flickers in and out of detection (spec).
export function createSetColorMap(): {
  colorFor(id: SetIdentity): { color: string; dash: boolean };
} {
  const order = new Map<SetIdentity, number>();
  return {
    colorFor(id: SetIdentity): { color: string; dash: boolean } {
      let n = order.get(id);
      if (n === undefined) {
        n = order.size;
        order.set(id, n);
      }
      return {
        color: SET_LINE_COLORS[n % SET_LINE_COLORS.length],
        dash: n >= SET_LINE_COLORS.length,
      };
    },
  };
}
