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

BreadCrumbs' own code is Apache License 2.0 (`LICENSE`).

**31 third-party packages ship with the application.** 27 are MIT, one Apache
2.0, one ISC, one BSD — all permissive, all satisfied by including their notice
text. Electron itself is MIT.

**Two components are the entire licensing question, and they are the same
project twice over: `ffmpeg` and `ffprobe`.** Both are currently GPL v3 builds.
Everything else is routine.

There are two findings that need a decision, in §4.

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

**That reading is widely relied on and genuinely contested.** Bundling the
binary inside our own installer is a weaker position than the user installing
ffmpeg themselves. This document does not assume the argument succeeds; §4
recommends removing the need to make it.

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

## 5. The decision to make

BreadCrumbs' own code is Apache 2.0. Apache 2.0 and GPL v3 are compatible in
one direction: Apache-licensed code may be incorporated into a GPL v3 work, not
the reverse. So both routes below are available.

### Route A — Replace ffmpeg and ffprobe with LGPL builds

The GPL parts of ffmpeg are optional. A build made without them (`libx264`,
`libx265`, `libxvid` and the rest omitted) is LGPL v2.1 or later, which permits
bundling inside a work under any licence, including Apache 2.0.

Obligations that remain, and are routine: ship the LGPL text, state that
ffmpeg is used and unmodified, and make its corresponding source available.
Because ffmpeg is a separate executable rather than a linked library, the LGPL
relinking requirement is satisfied by the user's ability to substitute the
binary.

**Consequence for the product:** `libx264` is what currently encodes the
preview copy, so it needs replacing. See §6.

### Route B — Keep the GPL builds

Requires either relying on the arm's-length argument in §2 for BreadCrumbs'
own code, or releasing BreadCrumbs under GPL v3.

In both cases the GPL obligations for ffmpeg and ffprobe themselves stand:
ship their licence texts, and make their corresponding source available to
every recipient — including the exact build configuration used.

### Recommendation

**Route A.** Apache 2.0 was chosen so that others can use this freely; leaning
on a contested reading to achieve it undercuts the intent, and Route A removes
the argument rather than winning it.

---

## 6. What Route A costs technically

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
| `LICENSE` | Apache License 2.0, verbatim and unmodified |
| `NOTICE` | Copyright and required attributions |
| `THIRD-PARTY.md` | This document |

---

*Prepared by inspecting the installed dependency tree and querying each
prebuilt binary for its own build configuration. It states what is present and
what the licences say; it is not legal advice, and the routes in §5 should be
confirmed by a qualified adviser before distribution.*
