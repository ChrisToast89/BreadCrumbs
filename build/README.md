# Application icon

**To change the icon, replace `icon.png` in this folder. That is the whole job.**

`build/icon.png` is currently a **placeholder** and should be replaced before
any public release.

## What the file needs to be

| | |
|---|---|
| **Name** | `icon.png` — exactly this, in this folder |
| **Size** | **1024 × 1024** pixels. 512 × 512 is the minimum electron-builder accepts; 1024 gives it room to downscale cleanly. |
| **Shape** | Square. Not a rectangle that happens to be nearly square. |
| **Format** | PNG. Transparency is allowed and works on all three platforms. |

Everything else is automatic. electron-builder converts this one file into the
Windows `.ico` and the macOS `.icns`, at every size each platform asks for, and
Linux uses the PNG directly. There is no second file to produce and no
conversion step to run.

## After replacing it

```bash
npm run package:win
```

Then check it actually took, rather than assuming:

- The Start Menu and desktop shortcuts
- The taskbar while the app is running
- `release\win-unpacked\BreadCrumbs.exe` in Explorer, with large icons on

Windows caches icons aggressively. If a shortcut still shows the old one after
a rebuild, the icon is usually fine and the cache is stale — the executable
itself is the reliable place to look.

## Designing one

A few things that matter more than they sound:

- **It is seen at 16 pixels.** In the taskbar and the Start Menu list it will
  be tiny. Anything with fine detail or small text turns to mush. Test by
  shrinking your design to 16 × 16 and looking at it.
- **It sits on both light and dark.** Windows taskbars, macOS docks and
  Explorer backgrounds vary. A mark that relies on a dark background disappears
  on a light one.
- **It has to be distinguishable in a row of other icons**, which is the actual
  job — someone glancing at a taskbar of twenty things.

The application's own palette is in `src/renderer/src/styles/tokens.css` if you
want the icon to match: the surface is `#191c20` and the accent is `#9fb0c0`.

## Regenerating the placeholder

```bash
npm run icon:placeholder
```

Overwrites `icon.png` with the generated placeholder. Only useful for testing
the pipeline — it will destroy real artwork you have put there.
