# Design: manual flight controls, Spaceflight Simulator style (2026-11-26)

Status: approved 2026-11-26 ("Game-like, as in SFS").

## Intent

Web and Android app (same build) get hand controls on all three flight screens, laid out like the
game Spaceflight Simulator: throttle lever and engine switch on the left, large hold-to-rotate
arrows at the bottom, stage button on the right, time controls at the top. Layout only; no art or
assets are copied from the game.

## Today

- Mission mode: "Fly it yourself" opens a panel of text buttons (`src/app/pilotControls.ts`).
- Lunar descent: manual buttons in the bottom dock (`src/landing/main.ts`).
- Built or imported rockets (main flight screen): no hand control.

## Approaches

1. **Game-like (picked).** Manual flight throttles, shuts off and restarts the motor (the same
   propellant burned slower, so total impulse is unchanged), turns the rocket while burning or
   coasting, and fires the parachute or stage by hand.
2. Realistic only: nozzle gimbal while burning, no throttle on solids. Controls barely do anything
   on small rockets.
3. Restyle Mission and Lunar only. Leaves the reported gap open.

## Shared deck: `src/app/flightDeck.ts` + `flightDeck.css`

One component, used by all three screens. The interface in `flightDeck.ts` is the contract.

- Left, bottom: throttle readout, vertical lever (drag or tap), MAX / MIN, round engine ON/OFF.
- Bottom right: two large round rotate buttons (counter-clockwise, clockwise); above them the
  smaller tilt pair. Press and hold; pointer capture; several fingers at once.
- Right, above the arrows: stage button, then the screen's toggle buttons.
- Top centre: mode chip (button when `onMode` is set), readouts, warp - / x1 / +, pause, reset, close.
- Keys (only while visible and active, consumed so page shortcuts do not also fire): A/D or
  left/right rotate, W/S or up/down tilt, E/Q throttle, Z full, X cut, Space stage, T mode, each
  toggle's own key. Shift = 0.3x. Ctrl/Meta/Alt combinations are left to the browser.
- Held inputs are released on window blur, tab hide and when the deck is hidden.
- Hosts position it with CSS variables `--fdk-top`, `--fdk-bottom`, `--fdk-left`, `--fdk-right`.
- Touch targets at least 48 px; works at 360x740 portrait, 780x360 landscape and desktop; respects
  safe-area insets and `prefers-reduced-motion`.

## Main flight screen

- "Fly manually" button (desktop dock, phone rail) resets the flight and shows the deck.
- Stage button: Launch on the pad, then drop stage (multi-stage), then parachute.
- SAS toggle (default on): holds attitude when no arrow is held. Off: the airframe flies itself.
- Rotate turns the nose on screen as seen by the camera; tilt leans it away from or toward the camera.
- Warp 0.25, 0.5 (default), 1, 2, 5.
- Manual flights show only the pre-flight design checks and do not count for challenges.
- Normal (non-manual) launches behave exactly as before.

### Physics (`src/physics/sim.ts`)

`Controls` gains optional `throttle` (0..1) and `rate` (world-frame angular velocity command).
Absent, results are identical to today. `Sim` gains `deployChutes()` and `separateStage()`.

## Mission and Lunar

Same deck over the existing logic (`mission/pilot.ts`, `lunar/lander.ts`); physics unchanged.
Mission engines are staged by the autopilot, so engine and stage buttons are shown disabled or
hidden there. Lunar keeps its dock for autopilot, warp, restart and panels.

## Non-goals

RCS translation, orbital map controls, gamepad support, changing mission or lunar physics.
