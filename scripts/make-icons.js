import sharp from "sharp";
import { readFile } from "fs/promises";

const src = "C:/Users/Md. Rakib/Downloads/logo.png";

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

await createRoundedIcon(src, "icons/icon.png", 256, 32);
await createRoundedIcon(src, "src/client/public/logo.png", 88, 14);

console.log("Done");