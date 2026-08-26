# Third-party components

Everything BreadCrumbs ships that someone else wrote, what it is licensed
under, and what that obliges. Written to be read by a lawyer without needing
the codebase explained.

Compiled from the actual installed packages and, where a package ships a
prebuilt executable, from that executable's own reported build configuration —
not from package metadata alone, because in one case (see **ffprobe**) the
metadata is misleading.

Last checked: 26 August 2026, against the tree in `package-lock.json`.

---

## 1. Summary for the impatient

BreadCrumbs' own code is **GNU General Public License v3** (`LICENSE`).

**31 third-party packages ship with the application.** 27 are MIT, one Apache
2.0, one ISC, one BSD — all permissive, all satisfied by including their notice
text. Electron itself is MIT.

**Two components are the entire licensing question, and they are the same
project twice over: `ffmpeg` and `ffprobe`.** Both are currently GPL v3 builds.
Everything else is routine.

Two findings came out of compiling this, in §4. The decision they fed into has
since been made — see §5.

---

## 2. How BreadCrumbs uses ffmpeg — the fact the analysis turns on

BreadCrumbs does **not** link ffmpeg into its own program. It runs `ffmpeg.exe`
and `ffprobe.exe` as **separate operating-system processes**, passing
command-line arguments and reading their output.

Every call site does this, and there are no native bindings anywhere in the
project. The relevant code is `src/main/media/run.ts`, `proxy.ts`,
`analyze.ts`, `exportFrames.ts` and `indexVideo.ts`; all use Node's `spawn`.

This matters because the Free Software Foundation's own position is that
programs communicating at arm's length — separate processes, command lines,
pipes — are separate works rather than one derived work. On that reading,
shipping a GPL ffmpeg alongside BreadCrumbs is *aggregation*: the GPL
obligations attach to ffmpeg, and BreadCrumbs' own code keeps its own licence.

**That reading is widely relied on and genuinely contested**, and bundling the
binary inside our own installer is a weaker position than the user installing
ffmpeg themselves.

**The decision in §5 makes the argument unnecessary.** BreadCrumbs is GPL v3
and FFmpeg is GPL v3, so there is no licence conflict to resolve and nothing
turns on whether the two count as one work. This section is retained because it
is the first thing anyone reviewing the project will ask, and because it would
become load-bearing again if BreadCrumbs were ever relicensed.

---

## 3. What ships

### 3.1 The application runtime

| Component | Version | Licence | Obligation |
|---|---|---|---|
| Electron | 44.0.0 | MIT | Include notice. Bundles Chromium (BSD-3-Clause and others) and Node.js (MIT); Electron ships their licence texts and electron-builder includes them automatically. |

### 3.2 Media binaries — the ones that matter

| Component | Version | Licence | Evidence |
|---|---|---|---|
| **ffmpeg** (via `ffmpeg-static` 5.3.0) | 6.1.1 | **GPL v3 or later** | Built `--enable-gpl --enable-version3`, including `libx264`, `libx265`, `libxvid`, `libvidstab`, `librubberband` — each of which is GPL and each of which makes the whole binary GPL. |
| **ffprobe** (via `ffprobe-static` 3.x) | 4.0.2 | **GPL v3 or later** | Built `--enable-gpl --enable-version3`, including `libx264`, `libx265`, `libxvid`. |

Both are used only as separate processes (§2). Neither is modified.

### 3.3 Application dependencies

31 packages ship. By licence:

| Licence | Count | Notable |
|---|---|---|
| MIT | 27 | react, react-dom, zustand, ffprobe-static (wrapper only — see §4.1) |
| Apache-2.0 | 1 | caseless |
| ISC | 1 | inherits |
| BSD | 1 | parse-cache-control |
| GPL-3.0-or-later | 1 | ffmpeg-static |

All permissive licences here are satisfied by reproducing their notices in the
distribution, which `electron-builder` does for bundled modules.

Development-only tools (TypeScript, Vite, electron-builder, tsx and their
trees) are **not** distributed and carry no obligation.

---

## 4. Findings

### 4.1 `ffprobe-static` declares MIT, but ships a GPL binary

The npm package `ffprobe-static` is MIT licensed. That covers roughly forty
lines of JavaScript that resolve a file path. The executable it installs is a
GPL v3 build of ffprobe.

**Any automated licence scanner reading package metadata will report this
dependency as MIT and miss the GPL entirely.** If a scan has been run on this
project, or is run later, this is the row it gets wrong.

### 4.2 ffprobe's licence text is not currently shipped with it

`ffmpeg-static` includes the GPL v3 text next to its binary
(`ffmpeg.exe.LICENSE`). `ffprobe-static` ships only the MIT text covering its
wrapper; the GPL text for the binary is absent.

Distributing a GPL binary without its licence text does not satisfy the GPL.
As things stand this would need fixing before release, whichever route §5
takes.

### 4.3 ffprobe is from 2018

Version 4.0.2, built 2018. Not a licensing matter, but a seven-year-old media
parser handling untrusted files is worth raising separately on security
grounds.

---

## 5. The decision, settled

**BreadCrumbs is released under GPL v3, keeping the bundled GPL FFmpeg
binaries.** Decided 26 August 2026.

Apache 2.0 was the initial preference. Achieving it would have required LGPL
builds of both binaries, and that route failed on inspection:

- No trustworthy source of LGPL builds exists for macOS, which is a required
  platform.
- Every npm package claiming to provide LGPL builds was checked and found to
  ship GPL binaries — `@ffmpeg-installer/ffmpeg` and `@ffprobe-installer/ffprobe`
  both declare LGPL-2.1 and both are built `--enable-gpl --enable-libx264`.
  Swapping to them would have left the identical position while appearing
  solved.
- Building from source in CI across three platforms was the only remaining way
  to obtain verified LGPL builds, and was judged disproportionate for a
  single-function tool.

The alternative — not bundling FFmpeg and having users install it themselves —
removes the obligation entirely, but puts a Homebrew or terminal step in front
of a non-technical audience. Ease of installation was judged to matter more
than the difference between Apache and GPL, since both licences leave the tool
free to use, modify and share.

### What this obliges

1. **Ship the GPL v3 text.** `LICENSE`, included in the packaged application.
2. **Make the corresponding source available** for the FFmpeg binaries, not just
   for BreadCrumbs' own code. Exact versions, build configurations and source
   locations are recorded in [SOURCES.md](SOURCES.md).
3. **Supply the GPL text for `ffprobe`**, which its npm package omits (§4.2).
   `LICENSE` covers it.
4. **Keep BreadCrumbs' own source available**, which a public repository does.

### Consequence

The technical work in §6 is **not required**. `libx264` stays, the preview copy
is encoded as it always has been, and no encoder needs replacing. §6 is retained
only as a record of what the Apache route would have cost, should the decision
ever be revisited.

## 6. What the Apache route would have cost — retained for reference

Removing `libx264` removes the encoder that produces the 480p preview copy.
That copy has two hard requirements: every frame must be a keyframe (so
scrubbing lands exactly), and the format must play in Electron's Chromium
video element.

`SPEC.md` §10 suggests `mpeg4` or `mjpeg` as replacements. **Both look
unsuitable and this should not be followed without testing:** Chromium does not
play MPEG-4 Part 2 at all, and its support for Motion JPEG in a video element
is unreliable. Following that suggestion risks a preview pane that shows
nothing.

**VP9 in a WebM container is the likely answer.** Its encoder, `libvpx`, is
BSD-licensed and therefore permitted in an LGPL build; it is already present in
the current binary; and Chromium plays VP9 natively.

Unverified and needing measurement before committing:

- **Encode speed.** x264 at `veryfast` builds the preview for a two-minute clip
  in 4.1 seconds against a 30-second budget. VP9 is slower and the margin is
  not yet known.
- **All-keyframe output** must be confirmed, since exact scrubbing depends on it.
- **File size**, which affects the on-disk cache.

Export is unaffected either way: PNG and JPEG encoders are part of ffmpeg's
LGPL core, so the frames BreadCrumbs actually produces carry no GPL component.

---

## 7. Files in this repository

| File | Contents |
|---|---|
| `LICENSE` | GNU General Public License v3, verbatim and unmodified |
| `NOTICE` | Copyright, licence summary and bundled-software attributions |
| `SOURCES.md` | Where to obtain source for the bundled FFmpeg binaries |
| `THIRD-PARTY.md` | This document |

---

*Prepared by inspecting the installed dependency tree and querying each
prebuilt binary for its own build configuration. It states what is present and
what the licences say; it is not legal advice, and the position in §5 should be
confirmed by a qualified adviser before distribution.*
