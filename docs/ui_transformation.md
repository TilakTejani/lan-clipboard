# Transforming the extension to match the mobile app's new architecture

The mobile app (`lan_clipboard_mobile`) was rebuilt this session around a
device-picker-first UI (`docs/app_architecture.md`, `docs/direct_drop.md`
over there) and a reactive state layer (Riverpod). This document plans the
equivalent transformation here — what maps directly, what needs a different
approach given a Chrome extension popup's real constraints, and a concrete
migration path. Nothing in this doc has been implemented yet.

## What's already at parity — no changes needed

Confirmed in earlier cross-repo work (`README.md`'s "Wire protocol
compatibility" section): `offscreen.js` already speaks the full protocol the
mobile app's new UI depends on — device types (`HANDSHAKE`'s `deviceType`,
`PARTICIPANTS`'s `deviceTypes` map), targeted single-device sends (`target`
field, already exposed via `@mention` in the current compose box), and
chunked large-file transfer. **The engine layer doesn't need to change for
this transformation** — this is purely a `popup.html`/`popup.js` UI
rewrite, same relationship as `offscreen.js` to `peer_service.dart` on the
other side.

## What needs to change

### 1. UI restructure: device-picker as the primary view

Current `popup.html` is a single flat form: username/room inputs, a
`badgesContainer` row of connected devices (small pills, not the primary
focus), a `manualInput` compose box with `@mention` targeting, and a
`historyList` below. The device list is secondary to the compose box.

Mobile's new structure inverts this — the device grid *is* the home screen,
selecting a device is the primary action, and the compose actions
(clipboard/file/text) are secondary buttons below it (see
`app_architecture.md`'s `DropScreen` description). The extension should
follow the same shape:

- **Device picker becomes the top section**: replace the small `badgesContainer`
  pill row with a proper grid/list of device tiles (icon by `deviceType`,
  name, tap-to-select with a visible selected state) — the popup already has
  the data (`onlineUserDeviceTypes` in `chrome.storage.local`, wired up
  earlier this session) but doesn't give it primary visual weight yet.
- **Selecting a device sets the `@mention` target implicitly** — instead of
  requiring the user to type `@name` in the compose box, tapping a device
  tile should insert/set the target the way `DropScreen`'s tap-to-select
  does, with typing `@mention` remaining as a secondary/power-user path
  rather than the only path.
- **Compose actions (paste clipboard / attach file / text) become clearly
  secondary**, below the device picker — mirrors `DropScreen`'s action bar
  sitting under the device grid, not the other way around.

### 2. Section structure: tabs, adapted to popup size constraints

Mobile has a real bottom nav (Storage / Share / Settings) because it has a
full screen to work with. **A literal bottom nav bar won't work well in a
~400×600px extension popup** — there isn't vertical room to spare. The
honest equivalent here is a **compact top tab strip** (3 small icon+label
tabs directly under the header) switching between:

- **Share** (default) — the device picker + compose actions described above
- **History** — the existing `historyList`, promoted from "section at the
  bottom of the same page" to its own tab, same reasoning as mobile's
  Storage tab (gets full vertical space instead of competing with everything
  else for scroll room)
- **Settings** — `userGroup`/`roomGroup` (username + room code inputs),
  currently inline at the top of the single page; move to their own tab so
  the default view isn't cluttered with connection setup once already
  connected

No FAB equivalent needed structurally, but see the Scanner section below —
it does need a place to live, likely a small icon button in the tab strip
or header rather than a floating button (Chrome extension popups don't
really have a "floating" layer the way a mobile screen does).

### 3. State management equivalent

Mobile's Riverpod migration was justified by `PeerService` already exposing
everything as `Stream`s. The extension's actual state is currently spread
across three places: `offscreen.js`'s local variables (`connections`,
`myName`, etc.), `chrome.storage.local` (the `background.js` relay layer),
and `popup.js`'s own module-level variables (`currentOnlineUsers`, etc.),
updated ad hoc wherever a `chrome.runtime.onMessage` listener happens to
fire.

**A full Riverpod-equivalent framework would be disproportionate here** —
this is ~1,650 lines of vanilla JS across 4 files, not a large app, and pulling
in a reactive framework (plus a build step, since none exists today) is a
bigger investment than the popup's complexity justifies. The lighter,
proportionate equivalent:

- Consolidate `popup.js`'s scattered module-level variables into one state
  object (e.g. `const state = { status, participants, deviceTypes, history, selectedTarget }`).
- One `render()` function that reads from `state` and updates the DOM,
  called after every mutation — replaces the current pattern of updating
  specific DOM nodes inline wherever a message handler happens to run.
- Keep `chrome.storage.local` as the actual persistence/cross-context
  transport (that part is Chrome-extension-specific plumbing, not something
  a JS framework would replace anyway) — this just cleans up how `popup.js`
  *consumes* it, same spirit as the mobile migration even though the
  mechanism is necessarily different.

This is a refactor, not a rewrite — `offscreen.js`/`background.js` don't
need to change for this either.

### 4. Visual rebrand

Apply the same palette from `lib/theme/app_colors.dart` on the mobile side
(dusty-navy: `#2F3061`/`#343434` background, `#93A4D4` primary,
`#B7B4C6` accent, `#DFDFDF`/`#ACACAC` text) to the extension's CSS, currently
inline in `popup.html`. Keeps both surfaces visually consistent as the same
product. Low effort, high visual-consistency payoff — worth doing early,
independent of the structural changes above.

### 5. Scanner — inverted role from mobile

Mobile's Scanner FAB will eventually *scan* a QR code with the camera.
Desktops don't have a camera pointed usefully at another device's screen —
the natural extension-side role, per `device_discovery.md`'s QR-pairing
plan on the mobile side, is the opposite: **the extension displays its own
room code as a QR code** for a phone to scan, rather than scanning one
itself. A `qrcode.js`-style library rendering the current room code to a
`<canvas>` is a small, self-contained addition — no camera/permissions
needed on this side at all.

## Suggested migration order

1. Visual rebrand (CSS-only, no structural risk, immediate consistency win).
2. Consolidate `popup.js` state into the single-object + `render()` pattern
   — do this *before* the structural UI change, so the tab/device-picker
   rewrite is built on the cleaner pattern instead of adding tabs on top of
   the current scattered-update code.
3. Tab strip + device-picker-primary restructure.
4. QR code display for the Scanner-equivalent slot.

No changes needed to `offscreen.js`, `background.js`, or the wire protocol
at any point in this plan — this is entirely a `popup.html`/`popup.js`
(and new CSS) transformation.
