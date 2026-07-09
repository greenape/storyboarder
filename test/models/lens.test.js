//
// USAGE:  npx mocha test/models/lens.test.js
//
// Pure Node test (no Electron) — runs under `npm run test:node`.

const assert = require('assert')
const fs = require('fs')
const path = require('path')

const lensModel = require('../../src/js/models/lens')
const projectModel = require('../../src/js/models/project')

const sgScene = JSON.parse(
  fs.readFileSync(path.join(__dirname, '..', 'fixtures', 'shot-generator', 'shot-generator.storyboarder'), 'utf8')
)
const sgBoard = sgScene.boards.find((b) => b.sg)

describe('models/lens (lens-from-ShotGenerator)', () => {
  describe('focalLengthFromFov', () => {
    it('is bit-identical to three.js PerspectiveCamera.getFocalLength()', () => {
      const THREE = require('three')
      for (const fov of [12, 24, 33.932915758162025, 45, 60, 90]) {
        const camera = new THREE.PerspectiveCamera(fov, lensModel.SG_ASPECT)
        // three.js default filmGauge is 35, matching SG_FILM_GAUGE
        assert.ok(
          Math.abs(camera.getFocalLength() - lensModel.focalLengthFromFov(fov)) < 1e-9,
          `mismatch at fov ${fov}`
        )
      }
    })

    it('converts the fixture camera fov to ~24mm', () => {
      const mm = lensModel.focalLengthFromFov(33.932915758162025)
      assert.ok(Math.abs(mm - 24.41965) < 1e-4, `got ${mm}`)
    })

    it('is monotonic — a wider fov is a shorter focal length', () => {
      assert.ok(lensModel.focalLengthFromFov(60) < lensModel.focalLengthFromFov(30))
    })
  })

  describe('cameraFovFromBoard', () => {
    it('reads the active camera fov from a board with Shot Generator data', () => {
      assert.ok(typeof lensModel.cameraFovFromBoard(sgBoard) === 'number')
    })

    it('returns null for a board with no sg data', () => {
      assert.strictEqual(lensModel.cameraFovFromBoard({ uid: 'x' }), null)
      assert.strictEqual(lensModel.cameraFovFromBoard({ sg: { data: {} } }), null)
    })
  })

  describe('parseLensMm', () => {
    it('parses the mm out of a lens name', () => {
      assert.strictEqual(lensModel.parseLensMm('35mm'), 35)
      assert.strictEqual(lensModel.parseLensMm('50 mm'), 50)
      assert.strictEqual(lensModel.parseLensMm('Anamorphic'), null)
    })
  })

  describe('findOrCreateLensId', () => {
    it('creates a lens named for the focal length and returns its id', () => {
      const project = projectModel.defaultProject()
      const result = lensModel.findOrCreateLensId(project, sgBoard)
      assert.ok(result.id)
      assert.strictEqual(result.created, true, 'a new lens was minted')
      const lens = project.breakdown.lensKit.find((l) => l.id === result.id)
      assert.strictEqual(lens.name, '24mm')
    })

    it('reuses an existing matching lens instead of duplicating', () => {
      const project = projectModel.defaultProject()
      const existing = projectModel.addVocabItem(project, 'lensKit', { name: '24mm' })
      const result = lensModel.findOrCreateLensId(project, sgBoard)
      assert.strictEqual(result.id, existing.id, 'reused')
      assert.strictEqual(result.created, false, 'not minted, reused')
      assert.strictEqual(project.breakdown.lensKit.length, 1, 'no duplicate created')
    })

    it('returns null for a board with no 3D camera', () => {
      const project = projectModel.defaultProject()
      assert.strictEqual(lensModel.findOrCreateLensId(project, { uid: 'x' }), null)
      assert.strictEqual(project.breakdown.lensKit.length, 0)
    })
  })
})
