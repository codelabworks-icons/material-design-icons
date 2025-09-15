const fs = require('fs-extra');
const path = require('path');
const fetch = require('node-fetch');
const mkdirp = require('mkdirp');

const ROOT = process.cwd();
const VARIABLE_DIR = path.join(ROOT, 'variablefont');
const TEMP_OUT = path.join(ROOT, 'symbols', 'web');
const FONTS_DIR = path.join(ROOT, 'fonts');
const CSS_DIR = path.join(ROOT, 'css');

const USER_AGENT = 'Mozilla/5.0 (compatible; UpdateScript/1.0)';
const MATERIAL_SYMBOLS_RE = /(materialsymbols[0-9A-Za-z_-]*)/i;

function camelCaseParts(str) {
  let s2 = str.replace(/[^A-Za-z0-9]+/g, ' ');
  s2 = s2.replace(/([a-z])([A-Z])/g, '$1 $2');
  return s2.split(/\s+/).filter(Boolean);
}

function toCamelCase(parts) {
  return parts.map(p => p.charAt(0).toUpperCase() + p.slice(1)).join('');
}

function sanitizeName(filename) {
  const ext = path.extname(filename);
  let base = path.basename(filename, ext);
  base = base.replace(/

\[.*\]

$/, '');
  const m = base.match(MATERIAL_SYMBOLS_RE);
  if (m) {
    const matched = m[1];
    const tail = matched.length > 13 ? matched.slice(13) : '';
    const tailParts = camelCaseParts(tail);
    const tailCamel = tailParts.length ? toCamelCase(tailParts) : '';
    return `MaterialSymbols${tailCamel}${ext}`;
  }
  const parts = camelCaseParts(base);
  return parts.length ? `${toCamelCase(parts)}${ext}` : `${base}${ext}`;
}

async function copyAndSanitizeFonts() {
  await mkdirp(TEMP_OUT);
  const files = await fs.readdir(VARIABLE_DIR);
  for (const file of files) {
    const src = path.join(VARIABLE_DIR, file);
    const stat = await fs.stat(src);
    if (!stat.isFile()) continue;
    if (!/\.(ttf|woff2?|codepoints)$/i.test(file)) continue;
    const dst = path.join(TEMP_OUT, file);
    await fs.copy(src, dst);
    const sanitized = sanitizeName(file);
    if (sanitized !== file) {
      await fs.copy(src, path.join(TEMP_OUT, sanitized));
    }
  }
}

async function detectFamilies() {
  const families = [];
  const files = await fs.readdir(VARIABLE_DIR);
  for (const file of files) {
    if (!file.endsWith('.ttf')) continue;
    const sanitized = sanitizeName(file);
    const family = path.basename(sanitized, '.ttf');
    let spaced = family.replace(/([a-z])([A-Z])/g, '$1 $2');
    spaced = spaced.replace(/([A-Z]+)([A-Z][a-z])/g, '$1 $2');
    const plus = spaced.split(/\s+/).join('+');
    if (plus && !families.includes(plus)) {
      families.push(plus);
    }
  }
  return families;
}

async function fetchUrl(url) {
  const res = await fetch(url, { headers: { 'User-Agent': USER_AGENT } });
  if (!res.ok) throw new Error(`HTTP ${res.status} for ${url}`);
  return res.buffer();
}

async function downloadCssAndAssets(families) {
  await mkdirp(CSS_DIR);
  for (const famPlus of families) {
    const cssBase = famPlus.replace(/\+/g, '');
    const cssPath = path.join(CSS_DIR, `${cssBase}.css`);
    const gfUrl = `https://fonts.googleapis.com/css2?family=${encodeURIComponent(famPlus)}&display=swap`;
    let cssText;
    try {
      cssText = (await fetchUrl(gfUrl)).toString('utf-8');
    } catch (err) {
      console.warn(`Failed to fetch CSS for ${famPlus}: ${err.message}`);
      continue;
    }
    const urls = [...new Set(cssText.match(/https?:\/\/[^)'" ]+/g) || [])];
    for (const url of urls) {
      const fname = path.basename(new URL(url).pathname) || encodeURIComponent(url);
      const localName = sanitizeName(fname);
      const localPath = path.join(FONTS_DIR, localName);
      if (!await fs.pathExists(localPath)) {
        try {
          const data = await fetchUrl(url);
          await fs.writeFile(localPath, data);
        } catch (err) {
          console.warn(`Failed to download ${url}: ${err.message}`);
        }
      }
      cssText = cssText.replace(new RegExp(url, 'g'), `../fonts/${localName}`);
    }
    await fs.writeFile(cssPath, cssText, 'utf-8');
  }
}

async function main() {
  await mkdirp(FONTS_DIR);
  await mkdirp(CSS_DIR);
  await copyAndSanitizeFonts();
  const families = await detectFamilies();
  if (families.length) {
    await downloadCssAndAssets(families);
  } else {
    console.log('No families detected.');
  }
  // Move any fonts from TEMP_OUT to FONTS_DIR
  if (await fs.pathExists(TEMP_OUT)) {
    const tempFiles = await fs.readdir(TEMP_OUT);
    for (const file of tempFiles) {
      if (/\.(ttf|woff2?|svg)$/i.test(file)) {
        await fs.move(path.join(TEMP_OUT, file), path.join(FONTS_DIR, file), { overwrite: true });
      }
    }
  }
  // 🔥 Delete everything in ROOT except fonts/ and css/
  const keep = new Set(['fonts', 'css']);
  const rootItems = await fs.readdir(ROOT);
  for (const item of rootItems) {
    if (!keep.has(item)) {
      await fs.remove(path.join(ROOT, item));
    }
  }
  console.log('Cleanup complete. Only /fonts and /css remain.');
}

main().catch(err => {
  console.error(err);
  process.exit(1);
});
