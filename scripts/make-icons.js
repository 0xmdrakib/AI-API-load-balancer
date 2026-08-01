import sharp from "sharp";
import { mkdir, writeFile } from "fs/promises";
import { existsSync } from "fs";

const srcCandidates = [
  process.env.LOGO_SRC,
  "icons/brand-mark.png"
].filter(Boolean);

const src = srcCandidates.find((candidate) => existsSync(candidate));

// Optical crop of the approved 1254×1254 master. It preserves the artwork
// exactly while removing the large presentation whitespace that made the
// 16px title-bar icon and Windows desktop icon look tiny.
const ICON_CROP = { left: 132, top: 117, width: 988, height: 988 };

if (!src) {
  throw new Error(`No logo source found. Tried: ${srcCandidates.join(", ")}`);
}

function roundedMask(size) {
  const radius = Math.max(2, Math.round(size * 0.16));
  return Buffer.from(
    `<svg width="${size}" height="${size}" xmlns="http://www.w3.org/2000/svg"><rect width="${size}" height="${size}" rx="${radius}" fill="#fff"/></svg>`
  );
}

async function framedPng(inputSrc, size) {
  return sharp(inputSrc)
    .extract(ICON_CROP)
    .resize(size, size, { fit: "fill" })
    .ensureAlpha()
    .composite([{ input: roundedMask(size), blend: "dest-in" }])
    .png()
    .toBuffer();
}

async function createPng(inputSrc, dest, size) {
  await writeFile(dest, await framedPng(inputSrc, size));

  console.log("Created:", dest, size + "x" + size);
}

async function createMaskablePng(inputSrc, dest, size) {
  const inset = Math.round(size * 0.115);
  const framed = await sharp(inputSrc)
    .extract(ICON_CROP)
    .resize(size - inset * 2, size - inset * 2, { fit: "fill" })
    .png()
    .toBuffer();
  await sharp({
    create: { width: size, height: size, channels: 4, background: "#f7f1e6" }
  })
    .composite([{ input: framed, left: inset, top: inset }])
    .png()
    .toFile(dest);
  console.log("Created:", dest, size + "x" + size, "maskable");
}

async function createIco(inputSrc, dest, sizes) {
  const images = await Promise.all(
    sizes.map(async (size) => {
      const png = await framedPng(inputSrc, size);
      return { size, png };
    })
  );

  const headerSize = 6;
  const entrySize = 16;
  let offset = headerSize + images.length * entrySize;
  const header = Buffer.alloc(headerSize);
  header.writeUInt16LE(0, 0);
  header.writeUInt16LE(1, 2);
  header.writeUInt16LE(images.length, 4);

  const entries = images.map(({ size, png }) => {
    const entry = Buffer.alloc(entrySize);
    entry.writeUInt8(size >= 256 ? 0 : size, 0);
    entry.writeUInt8(size >= 256 ? 0 : size, 1);
    entry.writeUInt8(0, 2);
    entry.writeUInt8(0, 3);
    entry.writeUInt16LE(1, 4);
    entry.writeUInt16LE(32, 6);
    entry.writeUInt32LE(png.length, 8);
    entry.writeUInt32LE(offset, 12);
    offset += png.length;
    return entry;
  });

  await writeFile(dest, Buffer.concat([header, ...entries, ...images.map((image) => image.png)]));
  console.log("Created:", dest, sizes.join(", ") + "px");
}

await mkdir("icons", { recursive: true });
await mkdir("src/client/public", { recursive: true });
await createPng(src, "icons/icon.png", 512);
await createPng(src, "src/client/public/logo.png", 512);
await createPng(src, "src/client/public/favicon-16x16.png", 16);
await createPng(src, "src/client/public/favicon-32x32.png", 32);
await createPng(src, "src/client/public/favicon-48x48.png", 48);
await createPng(src, "src/client/public/favicon-64x64.png", 64);
await createPng(src, "src/client/public/favicon-96x96.png", 96);
await createPng(src, "src/client/public/apple-touch-icon.png", 180);
await createPng(src, "src/client/public/android-chrome-192x192.png", 192);
await createPng(src, "src/client/public/android-chrome-512x512.png", 512);
await createPng(src, "src/client/public/mstile-150x150.png", 150);
await createMaskablePng(src, "src/client/public/maskable-icon-512x512.png", 512);
await createIco(src, "icons/icon.ico", [16, 24, 32, 48, 64, 128, 256]);
await createIco(src, "src/client/public/favicon.ico", [16, 24, 32, 48, 64, 128, 256]);

console.log("Done");
