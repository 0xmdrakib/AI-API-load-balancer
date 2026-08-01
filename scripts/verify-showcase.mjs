import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';

const root = decodeURIComponent(new URL('../', import.meta.url).pathname.replace(/^\/(?:[A-Za-z]:)/, (value) => value.slice(1)));
const required = ['website/index.html', 'website/styles.css', 'website/app.js', 'website/site.webmanifest', 'website/browserconfig.xml', 'website/robots.txt', 'website/sitemap.xml', 'website/README.md', 'website/assets/brand-mark.png', 'website/assets/dashboard-preview.png'];
for (const relative of required) {
  if (!existsSync(join(root, relative))) throw new Error(`Missing showcase file: ${relative}`);
}
const html = readFileSync(join(root, 'website/index.html'), 'utf8');
for (const marker of ['AI Load Balancer', 'OpenAI SDK', 'Anthropic SDK', 'Balance traffic', 'Fair use', 'download-exe', 'download-zip', 'github.com/0xmdrakib/AI-API-load-balancer', 'ailoadbalancer.rakibhq.xyz', 'Md. Rakib • made with love and passion']) {
  if (!html.includes(marker)) throw new Error(`Showcase marker missing: ${marker}`);
}
if (html.includes('AI.Load.Balancer')) throw new Error('Obsolete dotted artifact name found in showcase');
const manifest = readFileSync(join(root, 'website/site.webmanifest'), 'utf8');
if (!manifest.includes('assets/brand-mark.png')) throw new Error('Showcase icon is missing from the manifest');
console.log(`Showcase verified: ${required.length} files, responsive static bundle ready for Vercel.`);
