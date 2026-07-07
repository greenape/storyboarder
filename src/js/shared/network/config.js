// Signaling host for the Shot Generator's phone / VR / AR peer (WebRTC) connections.
//
// This is a Wonder Unit dependency: `stbr.link` is their public PeerJS signaling
// broker (see server/README.md). The revival keeps it working by default but no
// longer hardcodes it — set the STBR_HOST env var to point at your own broker.
// Fully cutting this cord (standing up our own signaling/sync infra) is Phase 5.
//
// The `typeof process` guard keeps this safe after Phase 1 removes nodeIntegration
// from the renderer: until a preload bridge exposes the value it falls back to the
// default rather than throwing.
export const STBR_HOST =
  (typeof process !== 'undefined' && process.env && process.env.STBR_HOST) || 'stbr.link'
