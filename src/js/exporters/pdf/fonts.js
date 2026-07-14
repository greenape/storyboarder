// Font locations for the PDF exporter — resolved relative to THIS FILE, not the
// working directory. The original cwd-relative path ('./src/fonts') only worked when
// cwd happened to be the project root (dev): in the packaged app cwd is '/', so
// registerFont threw ENOENT on the THICCCBOI fonts and PDF export failed (alpha.2
// field report).
//
// Two __dirname contexts exist, hence two candidates:
//   - inside the print-project webpack bundle (node.__dirname:false → the runtime
//     value, i.e. the bundle's own directory src/build/) → fonts at ../fonts
//   - this source file required directly (tests) from src/js/exporters/pdf/ →
//     fonts at ../../../fonts
// (fs.existsSync is asar-aware in Electron, so this also resolves inside app.asar.)

const path = require('path')
const fs = require('fs')

const FONT_DIR = [
  path.join(__dirname, '..', 'fonts'),
  path.join(__dirname, '..', '..', '..', 'fonts'),
  path.join(process.cwd(), 'src', 'fonts')
].find(p => fs.existsSync(p)) || path.join('.', 'src', 'fonts')

module.exports = {
  FONT_DIR,
  THIN: path.join(FONT_DIR, 'thicccboi', 'THICCCBOI-Thin.woff2'),
  BOLD: path.join(FONT_DIR, 'thicccboi', 'THICCCBOI-Bold.woff2'),
  REGULAR: path.join(FONT_DIR, 'thicccboi', 'THICCCBOI-Regular.woff2'),
  FALLBACK: path.join(FONT_DIR, 'unicore.ttf'),
  FALLBACK_BOLD: path.join(FONT_DIR, 'unicore.ttf') // TODO bold version of unicore?
}
