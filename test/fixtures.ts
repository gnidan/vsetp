import { readdir, readFile } from "node:fs/promises";
import { join } from "node:path";
import sharp from "sharp";
import type { CardKey, Point } from "../src/model";

export interface Fixture {
  name: string;
  image: ImageData;
  cards: { key: CardKey; near: Point }[];
}

const ROOT = join(import.meta.dirname, "fixtures");

export async function loadFixtures(
  dir: "tuning" | "holdout",
): Promise<Fixture[]> {
  let entries: string[];
  try {
    entries = await readdir(join(ROOT, dir));
  } catch {
    return [];
  }
  const names = entries
    .filter((f) => /\.(jpe?g|png|webp)$/i.test(f))
    .map((f) => f.replace(/\.(jpe?g|png|webp)$/i, ""))
    // bin/annotate.ts drops "<name>-annotated.png" dev-tool output
    // alongside the source photo (see .gitignore); skip any image
    // without a matching label sidecar rather than treat it as a
    // fixture.
    .filter((name) => entries.includes(`${name}.json`));
  const fixtures: Fixture[] = [];
  for (const name of names) {
    const file = entries.find((f) => f.startsWith(`${name}.`))!;
    const { data, info } = await sharp(join(ROOT, dir, file))
      .rotate() // apply EXIF orientation: labels are display-oriented
      .ensureAlpha()
      .raw()
      .toBuffer({ resolveWithObject: true });
    const labels = JSON.parse(
      await readFile(join(ROOT, dir, `${name}.json`), "utf8"),
    );
    fixtures.push({
      name,
      image: new ImageData(
        new Uint8ClampedArray(data.buffer, data.byteOffset, data.length),
        info.width,
        info.height,
      ),
      cards: labels.cards,
    });
  }
  return fixtures;
}
