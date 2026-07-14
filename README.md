# lan-clipboard

## Wire protocol compatibility

This extension (`offscreen.js`) and the companion mobile app
(`lan_clipboard_mobile`) speak the same PeerJS-based protocol and are kept in
sync feature-for-feature on the wire, even where the UI differs:

- **`HANDSHAKE`** carries `username` and `deviceType` (`Windows` / `macOS` /
  `ChromeOS` / `Linux` / `Android` / `iPhone` / `iPad`, detected via
  `detectDeviceType()` here and `Platform`/`device_info_plus` on mobile).
- **`PARTICIPANTS`** carries `names` plus a sibling `deviceTypes` map
  (`{ username: deviceType }`). Threaded all the way through to this
  extension's own popup UI via `background.js`'s `onlineUserDeviceTypes`
  storage key — see the device icon next to each badge in `popup.js`.
- **Targeted (single-device) sends**: an optional `target` field on
  `text/plain` / `image/png` / `file` / `file_chunk` messages routes a send
  to one specific device instead of broadcasting to the whole room. This
  extension's popup already exposes it via `@mention` in the compose box
  (see `currentOnlineUsers` usage in `popup.js`) — this was the reference
  implementation the mobile app's targeted-send support was built to match.
- **`file_chunk`**: payloads over `CHUNK_SIZE` (16000 chars) are split and
  reassembled on the other end — implemented identically on both sides.

For the Android-side consumer of `target` — DirectDrop, which surfaces
connected devices as individual Direct Share icons in Android's system share
sheet — see `docs/direct_drop.md` in the `lan_clipboard_mobile` repo. No
changes were needed here for that feature: this extension already spoke the
full protocol it depends on before DirectDrop existed.

## UI transformation plan

The mobile app was rebuilt around a device-picker-first UI and a Riverpod
state layer (see `docs/app_architecture.md` over there). `docs/ui_transformation.md`
in this repo plans the equivalent here — not yet implemented. Same story as
above: the protocol layer (`offscreen.js`) doesn't need to change, this is
purely a `popup.html`/`popup.js` restructure.
