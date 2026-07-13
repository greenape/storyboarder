// electron-builder afterPack hook: give the macOS bundle a REAL ad-hoc signature.
//
// CI packages with CSC_IDENTITY_AUTO_DISCOVERY=false (no Apple Developer identity is
// available), which makes electron-builder skip signing entirely. That leaves the app
// with only the linker's per-binary stub signatures and NO bundle seal
// (_CodeSignature/CodeResources) — `codesign --verify --strict` fails with "code has no
// resources but signature indicates they must be present", and on Apple Silicon a
// quarantined download in that state gets Gatekeeper's dead-end "app is damaged" dialog
// (which right-click → Open does NOT bypass).
//
// A forced ad-hoc re-sign of the whole bundle produces a valid seal, turning that into
// the standard un-notarized flow (System Settings → "Open Anyway" on macOS 15+,
// right-click → Open on older) — still a warning, but a recoverable one. Removing the
// warning entirely needs the owner's Apple Developer ID + notarization.

const { execFileSync } = require('child_process')
const path = require('path')

module.exports = async (context) => {
  if (context.electronPlatformName !== 'darwin') return

  const appName = `${context.packager.appInfo.productFilename}.app`
  const appPath = path.join(context.appOutDir, appName)

  console.log(`  • afterPack: ad-hoc signing ${appName} (full bundle seal)`)
  // --deep: also re-signs the nested frameworks/helpers Electron ships; fine for ad-hoc.
  execFileSync('codesign', ['--force', '--deep', '--sign', '-', appPath], { stdio: 'inherit' })
  execFileSync('codesign', ['--verify', '--deep', '--strict', appPath], { stdio: 'inherit' })
  console.log('  • afterPack: ad-hoc signature verified')
}
