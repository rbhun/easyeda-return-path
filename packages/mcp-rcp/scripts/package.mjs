import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import JSZip from 'jszip';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const ROOT = path.resolve(__dirname, '..');

const FILES = ['extension.json', 'README.md', 'LICENSE', 'NOTICE', 'dist/index.js', 'images/logo.png'];

async function main() {
  const manifest = JSON.parse(fs.readFileSync(path.join(ROOT, 'extension.json'), 'utf8'));
  const outDir = path.join(ROOT, 'build', 'dist');
  fs.mkdirSync(outDir, { recursive: true });
  const outPath = path.join(outDir, `${manifest.name}_v${manifest.version}.eext`);

  const zip = new JSZip();
  const fixedDate = new Date(Date.UTC(2026, 0, 1, 0, 0, 0));

  for (const name of FILES) {
    const filePath = path.join(ROOT, name);
    if (!fs.existsSync(filePath)) {
      throw new Error(`Missing required package file: ${name}`);
    }
    const content =
      name === 'extension.json'
        ? Buffer.from(JSON.stringify(manifest), 'utf8')
        : fs.readFileSync(filePath);
    zip.file(name, content, { date: fixedDate, compression: 'DEFLATE', compressionOptions: { level: 9 } });
  }

  const buffer = await zip.generateAsync({ type: 'nodebuffer', compression: 'DEFLATE', compressionOptions: { level: 9 } });
  fs.writeFileSync(outPath, buffer);
  console.log(`Wrote ${outPath} (${buffer.byteLength} bytes)`);
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
