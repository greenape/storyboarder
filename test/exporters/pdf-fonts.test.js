//
// USAGE:  npx mocha test/exporters/pdf-fonts.test.js
//
// Pins the PDF exporter's font resolution (src/js/exporters/pdf/fonts.js). The
// original code used a cwd-relative path ('./src/fonts'), which only worked when cwd
// was the project root — in the packaged app cwd is '/', registerFont threw ENOENT on
// the THICCCBOI fonts, and PDF export failed (alpha.2 field report). The fix resolves
// relative to the module file; this pins that contract in the raw-require context
// (generate.js itself can't be raw-required — its @thi.ng deps are ESM-only — which
// is exactly why the resolution lives in this small requireable module).

const assert = require('assert')
const fs = require('fs')
const path = require('path')

const fonts = require('../../src/js/exporters/pdf/fonts')

describe('exporters/pdf font resolution', () => {
  it('resolves the font dir file-relative (absolute path, independent of cwd)', () => {
    assert.ok(path.isAbsolute(fonts.FONT_DIR), 'absolute, not cwd-relative')
    assert.strictEqual(
      fonts.FONT_DIR,
      path.resolve(__dirname, '..', '..', 'src', 'fonts'),
      'points at the repo src/fonts'
    )
  })

  it('finds every font the exporter registers', () => {
    for (const key of ['THIN', 'BOLD', 'REGULAR', 'FALLBACK', 'FALLBACK_BOLD']) {
      assert.ok(fs.existsSync(fonts[key]), `missing font for ${key}: ${fonts[key]}`)
    }
  })
})
