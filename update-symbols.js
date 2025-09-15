const fs = require('fs-extra');
const path = require('path');
const fetch = require('node-fetch');

const ROOT = process.cwd();
const VARIABLE_DIR = path.join(ROOT, 'variablefont');
const TEMP_SVGS = path.join(ROOT, 'symbols', 'web'); // will be moved & renamed
const SVGS_DIR = path.join(ROOT, 'build', 'svgs');
const FONTS_DIR = path.join(ROOT, 'build', 'fonts');
const CSS_DIR = path.join(ROOT, 'build', 'css');

const USER_AGENT = 'Mozilla/5.0 (compatible; UpdateScript/1.0)';
const MATERIAL_SYMBOLS_RE = /(materialsymbols[0-9A-Za-z_-]*)/i;

const VALID_GOOGLE_FONT_FAMILIES = new Set([
  'Material+Symbols+Outlined',
  'Material+Symbols+Rounded',
  'Material+Symbols+Sharp'
]);

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
  base = base.replace(/\[.*\]$/, '');
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
  await fs.ensureDir(TEMP_SVGS);
  const files = await fs.readdir(VARIABLE_DIR);
  for (const file of files) {
    const src = path.join(VARIABLE_DIR, file);
    const stat = await fs.stat(src);
    if (!stat.isFile()) continue;
    if (!/\.(ttf|woff2?|codepoints)$/i.test(file)) continue;
    const dst = path.join(TEMP_SVGS, file);
    await fs.copy(src, dst);
    const sanitized = sanitizeName(file);
    if (sanitized !== file) {
      await fs.copy(src, path.join(TEMP_SVGS, sanitized));
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

    if (VALID_GOOGLE_FONT_FAMILIES.has(plus) && !families.includes(plus)) {
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
  await fs.ensureDir(CSS_DIR);
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
  await fs.ensureDir(FONTS_DIR);
  await fs.ensureDir(CSS_DIR);
  await fs.ensureDir(SVGS_DIR);

  // Copy and sanitize font files
  await copyAndSanitizeFonts();

  // Detect Google font families
  const families = await detectFamilies();
  if (families.length) {
    await downloadCssAndAssets(families);
  } else {
    console.log('No valid Google font families detected.');
  }

  // Move processed font/svg files to /build
  if (await fs.pathExists(TEMP_SVGS)) {
    const tempFiles = await fs.readdir(TEMP_SVGS);
    for (const file of tempFiles) {
      if (/\.(ttf|woff2?|svg|codepoints)$/i.test(file)) {
        await fs.move(
          path.join(TEMP_SVGS, file),
          path.join(SVGS_DIR, file),
          { overwrite: true }
        );
      }
    }
  }

  // Clean up original folders (symbols/, variablefont/)
  const deleteDirs = ['symbols', 'variablefont'];
  for (const dir of deleteDirs) {
    const dirPath = path.join(ROOT, dir);
    if (await fs.pathExists(dirPath)) {
      await fs.remove(dirPath);
    }
  }

  console.log('✅ Build complete. Output in /build directory.');
}

main().catch(err => {
  console.error('❌ Error:', err);
  process.exit(1);
});
