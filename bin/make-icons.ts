import { mkdir } from "node:fs/promises";
import { join } from "node:path";
import sharp from "sharp";

const root = join(import.meta.dirname, "..", "public", "icons");
const source = join(root, "icon.svg");

async function emit(size: number, name: string): Promise<void> {
  await sharp(source).resize(size, size).png().toFile(join(root, name));
  console.log(`wrote icons/${name}`);
}

await mkdir(root, { recursive: true });
await emit(192, "icon-192.png");
await emit(512, "icon-512.png");
// maskable: same art, safe-zone padding via extend
await sharp(source)
  .resize(410, 410)
  .extend({
    top: 51,
    bottom: 51,
    left: 51,
    right: 51,
    background: "#12233a",
  })
  .png()
  .toFile(join(root, "icon-512-maskable.png"));
console.log("wrote icons/icon-512-maskable.png");
