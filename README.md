# Space Flight Builder

Drop in an OpenRocket (`.ork`) design, see it in 3D on a launch pad, fly it with a 6-DOF physics sim, and get a list of where and when the design fails. One codebase, two builds: a website and an Android app.

Plan, status and validation numbers: [docs/PLAN.md](docs/PLAN.md).

## Website

```
npm install
npm run dev        # http://localhost:5173
npm test           # unit tests
npm run build      # production site in dist/ (installable, works offline)
```

## Android app

Needs JDK 17 and the Android SDK. The app is the same web build inside a Capacitor WebView.

```
npm run android:apk
```

The debug APK lands in `android/app/build/outputs/apk/debug/app-debug.apk`. Install it with `adb install -r <path>` or copy it to the phone. `npm run android:sync` only rebuilds the web part and copies it into the Android project (then run it from Android Studio).

## Data scripts

```
node scripts/fetch-data.mjs   # certified motor curves (ThrustCurve.org) + OpenRocket example designs for tests
node scripts/make-icons.mjs   # app icons for web and Android
```

OpenRocket's example files are GPL, so they are downloaded into `fixtures/external/` and not committed. Tests that need them skip when the folder is missing.

## Space imagery

Planet, Moon and Sun maps in `public/assets/space/` are the NASA-derived textures distributed with the three.js examples. The star catalogue, Milky Way outline and constellation lines are from d3-celestial (BSD-3-Clause). Press `C` in the map view to toggle constellation lines.
