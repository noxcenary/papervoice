# Papervoice — React frontend

Active UI for Papervoice, built with React 19 and Vite. It talks to the Flask backend in the repository root through Vite's dev proxy.

See the [root README](../README.md) for project setup and [ARCHITECTURE.md](../ARCHITECTURE.md) for the backend pipeline.

## Run

Start the Flask backend first (`python app.py` from the repo root), then:

```powershell
npm install
npm run dev
```

The app is served at `http://127.0.0.1:5173`. Requests to `/convert`, `/progress`, and `/audio` are proxied to `http://127.0.0.1:5000` (configured in `vite.config.js`).

## Scripts

| Command | Description |
|---|---|
| `npm run dev` | Start Vite with HMR on port 5173 |
| `npm run build` | Production build in `dist/` |
| `npm run preview` | Preview the production build |
| `npm run lint` | Run oxlint |

The production build is not served by Flask yet; the deployed app still uses `templates/index.html`.

## Components

| File | Responsibility |
|---|---|
| `src/App.jsx` | Upload form, job polling, progress percentages, ETA formatting, analog countdown clock, result player |
| `src/AnimatedDropdown.jsx` | Shared animated select used by the voice and speed pickers |
| `src/VoiceDropdown.jsx` / `src/SpeedDropdown.jsx` | Voice and speed option definitions |
| `src/VoiceAuroraWave.jsx` | Audio-reactive orb visualizer (Three.js / OGL) |
| `src/RippleDistortion.jsx` | Background ripple effect |
| `src/App.css` | Theme, typography, drop zone, buttons, clock, and status styles |

Typography uses Bodoni Moda for the headline and Instrument Sans for the subtitle, with the two sizes locked to a 1.618 ratio via `--title-size` / `--subtitle-size`. The mobile breakpoint uses a 32px headline so the title stays on two lines.

## Notes

- The clock minute hand sweeps 360° over the current phase's ETA; the hour hand runs at 1/12 speed. Both are driven by `etaTotal` / `eta` from `/progress`, not by pipeline percentage.
- `npm run lint` currently reports three pre-existing unused-variable warnings (`RippleDistortion.jsx`, and `phase` / `setPhase` in `App.jsx`).
