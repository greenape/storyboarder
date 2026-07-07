/*
 * notarize for macOS (electron-builder afterSign hook)
 *
 * Uses Apple's `notarytool` via @electron/notarize. The legacy `altool`
 * transport (used by the old `electron-notarize` package) was shut off by
 * Apple in November 2023, so modern macOS notarization must go through
 * notarytool, which additionally requires the Team ID.
 *
 * Two ways to authenticate — pick one, via `electron-builder.env` or the
 * shell environment:
 *
 *   1. App Store Connect API key (recommended for CI):
 *        APPLE_API_KEY=/path/to/AuthKey_XXXXXXXXXX.p8
 *        APPLE_API_KEY_ID=XXXXXXXXXX
 *        APPLE_API_ISSUER=aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee
 *
 *   2. Apple ID + app-specific password:
 *        APPLEID=you@example.com
 *        APPLEIDPASS=abcd-efgh-ijkl-mnop   (an app-specific password)
 *        APPLETEAMID=XXXXXXXXXX            (10-char Team ID, now required)
 *
 * to skip signing and notarizing during development, use this env var:
 *   CSC_IDENTITY_AUTO_DISCOVERY=false
 */

console.log('  + scripts/notarize.js')

const { notarize } = require('@electron/notarize')

const skip =
  Object.prototype.hasOwnProperty.call(process.env, 'CSC_IDENTITY_AUTO_DISCOVERY') &&
  process.env.CSC_IDENTITY_AUTO_DISCOVERY == 'false'

exports.default = async function notarizing (context) {
  if (skip) {
    console.log('    ... skipped because CSC_IDENTITY_AUTO_DISCOVERY was false')
    return
  }

  if (context.electronPlatformName !== 'darwin') {
    console.log('    ... skipped because platform is not darwin')
    return
  }

  const { appOutDir } = context
  const appName = context.packager.appInfo.productFilename
  const appPath = `${appOutDir}/${appName}.app`

  const {
    APPLE_API_KEY,
    APPLE_API_KEY_ID,
    APPLE_API_ISSUER,
    APPLEID,
    APPLEIDPASS,
    APPLETEAMID,
  } = process.env

  let credentials
  if (APPLE_API_KEY && APPLE_API_KEY_ID && APPLE_API_ISSUER) {
    console.log('      • notarizing with App Store Connect API key')
    credentials = {
      appleApiKey: APPLE_API_KEY,
      appleApiKeyId: APPLE_API_KEY_ID,
      appleApiIssuer: APPLE_API_ISSUER,
    }
  } else if (APPLEID && APPLEIDPASS && APPLETEAMID) {
    console.log('      • notarizing with Apple ID + app-specific password')
    credentials = {
      appleId: APPLEID,
      appleIdPassword: APPLEIDPASS,
      teamId: APPLETEAMID,
    }
  } else {
    console.warn(
      '    ... skipped: no notarization credentials found. Set either ' +
        'APPLE_API_KEY / APPLE_API_KEY_ID / APPLE_API_ISSUER, or ' +
        'APPLEID / APPLEIDPASS / APPLETEAMID.'
    )
    return
  }

  console.log(`      • notarizing ${appPath} with notarytool`)

  return await notarize({
    tool: 'notarytool',
    appPath,
    ...credentials,
  })
}
