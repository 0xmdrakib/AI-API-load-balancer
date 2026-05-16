import sharp from "sharp";
import { mkdir, writeFile } from "fs/promises";
import { existsSync } from "fs";

const srcCandidates = [
  process.env.LOGO_SRC,
  "src/client/public/android-chrome-512x512.png",
  "src/client/public/logo.png",
  "C:/Users/Md. Rakib/Downloads/logo.png"
].filter(Boolean);

const src = srcCandidates.find((candidate) => existsSync(candidate));

if (!src) {
  throw new Error(`No logo source found. Tried: ${srcCandidates.join(", ")}`);
}

async function createRoundedIcon(inputSrc, dest, size, radius) {
  const svgMask = `<svg width="${size}" height="${size}">
    <rect x="0" y="0" width="${size}" height="${size}" rx="${radius}" ry="${radius}"/>
  </svg>`;

  const resized = await sharp(inputSrc)
    .resize(size, size, { fit: "contain", background: { r: 0, g: 0, b: 0, alpha: 0 } })
    .png()
    .toBuffer();

  const mask = await sharp(Buffer.from(svgMask))
    .resize(size, size)
    .ensureAlpha()
    .png()
    .toBuffer();

  await sharp(resized)
    .composite([{ input: mask, blend: "dest-in" }])
    .png()
    .toFile(dest);

  console.log("Created:", dest, size + "x" + size);
}

async function createIco(inputSrc, dest, sizes) {
  const images = await Promise.all(
    sizes.map(async (size) => {
      const svgMask = `<svg width="${size}" height="${size}">
        <rect x="0" y="0" width="${size}" height="${size}" rx="${Math.round(size * 0.125)}" ry="${Math.round(size * 0.125)}"/>
      </svg>`;

      const resized = await sharp(inputSrc)
        .resize(size, size, { fit: "contain", background: { r: 0, g: 0, b: 0, alpha: 0 } })
        .png()
        .toBuffer();

      const mask = await sharp(Buffer.from(svgMask)).ensureAlpha().png().toBuffer();
      const png = await sharp(resized).composite([{ input: mask, blend: "dest-in" }]).png().toBuffer();
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
await createRoundedIcon(src, "icons/icon.png", 256, 32);
await createRoundedIcon(src, "src/client/public/logo.png", 88, 14);
await createIco(src, "icons/icon.ico", [16, 24, 32, 48, 64, 128, 256]);

console.log("Done");
