import type { AttributeConfidence, Card } from "../../../model";
import type { SymbolRegion } from "../../adapter";
import { classifyColor } from "./color";
import { classifyCount } from "./count";
import { classifyFill } from "./fill";
import { classifyShape } from "./shape";

export function classifyCard(
  raster: ImageData,
  regions: SymbolRegion[],
): { card: Card; confidence: AttributeConfidence } {
  const count = classifyCount(regions);
  const color = classifyColor(raster, regions);
  const shape = classifyShape(regions);
  const fill = classifyFill(raster, regions);
  return {
    card: {
      count: count.value,
      color: color.value,
      shape: shape.value,
      fill: fill.value,
    },
    confidence: {
      count: count.confidence,
      color: color.confidence,
      shape: shape.confidence,
      fill: fill.confidence,
    },
  };
}
