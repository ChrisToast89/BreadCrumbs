# BreadCrumbs

**Give it a video. Get back one still from every shot.**

BreadCrumbs watches a clip, works out where the camera cuts, and picks a single
representative frame from each shot. You review its choices, nudge anything it
got wrong, drop the shots you don't want, and export the whole set as image
files in one go.

It is for storyboards, shot lists, contact sheets, thumbnails, reference
frames — any time you need "one picture per shot" and don't want to scrub
through a timeline pausing and screenshotting.

> **Public beta — version 0.90b.** It works, it's been used on real footage,
> and it may still surprise you. Please report anything odd.

---

## How it works

In plain language, four steps, all automatic:

1. **Index** — It reads through the file and builds a table of exactly where
   every frame sits in time. Everything afterwards refers to that table, so a
   frame you pick is the frame you get.
2. **Preview copy** — It makes a small, fast, throwaway copy of your video.
   That copy is what you scrub and play, which is why the interface stays
   instant even on a long or heavy clip. **Your original is never touched, and
   the exported images always come from the original — never from the small
   copy.**
3. **Measure** — It looks at every single frame and records how bright it is,
   how much it changed from the frame before, how sharp it is, and makes a
   thumbnail of it.
4. **Find the cuts** — Big jumps between neighbouring frames are cuts. It
   handles slow dissolves as well as hard cuts, and it adapts to the clip
   rather than using one fixed threshold, so a busy action sequence and a
   locked-off interview both work.

Then, within each shot, it avoids the flash at the start and the fade at the
end, skips blurry frames, and settles on one that actually represents the shot.

Where a shot changes a lot from beginning to end, you can give it **two**
frames — an in and an out — and BreadCrumbs names them `A` and `B` so the pair
reads as one shot in the folder listing.

Nothing is uploaded anywhere. It all happens on your machine.

---

## Requirements

| | |
|---|---|
| **Windows** | Windows 10 or newer, 64-bit |
| **macOS** | macOS 12 or newer (Intel or Apple Silicon) |
| **Linux** | 64-bit, most modern distributions |
| **Hardware** | Any consumer machine from the last five years or so. No special graphics card needed. |
| **Video files** | mp4, mov, mkv, webm |
| **Clip length** | Built for clips under about two minutes. Up to five minutes is fine. Longer will work but analysis takes a while. |

**You do not need to install anything else.** Video handling is built in.

---

## Installing

Downloads are on the [Releases](../../releases) page.

### Windows

Two options — pick one, they're the same program.

- **Installer** — `BreadCrumbs Setup 0.90.0-beta.exe`. Double-click it. There
  are no questions to answer; it installs, adds a desktop and Start Menu
  shortcut, and opens. Remove it later from *Settings → Apps* like anything
  else.
- **Portable** — `BreadCrumbs-0.90.0-beta-portable.exe`. One single file, no
  install. Double-click to run it, keep it wherever you like, delete it when
  you're done.

Windows may show a blue "Windows protected your PC" box, because this is a new
program from an independent developer rather than a big company. Click **More
info**, then **Run anyway**.

### macOS

Open the `.dmg` and drag BreadCrumbs to your Applications folder.

**The first time you open it, right-click (or Control-click) the app icon and
choose Open**, then confirm. Double-clicking the first time will just say the
app "cannot be opened" — that's macOS refusing anything not registered with
Apple's paid developer program, which this tool deliberately isn't. The
right-click-Open step tells macOS you meant it, once. Every launch after that
is a normal double-click.

### Linux

- **AppImage** — download it, mark it executable (right-click → Properties →
  Permissions, or `chmod +x` in a terminal), then double-click. No install.
- **.deb** — for Debian, Ubuntu and relatives. Double-click it, or
  `sudo apt install ./BreadCrumbs_0.90.0-beta_amd64.deb`.

> **Note for the beta:** Windows builds are the ones published so far. macOS and
> Linux packaging is configured and ready but has to be built on those
> platforms — see *Building it yourself* below, or ask and it'll be built.

---

## Using it

1. **Open a video.** Drag it onto the window, or click *Choose a video*. The
   four steps appear with a progress bar; a couple of minutes of footage takes
   seconds.
2. **Look at what it found.** The main image is the current frame, the strip
   below it is every shot it found with its chosen still, and the row under
   that is the frames within the selected shot.
3. **Fix anything wrong.**
   - **Wrong frame chosen?** Click a better one, or nudge with the **← →**
     arrow keys (hold **Shift** for jumps of ten).
   - **Shot needs two frames?** Press **B** to add an out frame, or double-click.
   - **It split one shot into two?** Select the second and press **M** to merge
     it back.
   - **It missed a cut?** Park on the frame where the new shot begins and press
     **S** to split there.
   - **Don't want a shot at all?** Press **X**, or click the green tick badge on
     its thumbnail to turn it into a red ⊘. Excluded shots stay visible so you
     can change your mind; the switch in the top bar hides them.
   - **Want to watch a shot?** Press **space** to play it, **L** to loop.
   - Changed your mind about anything: **Ctrl+Z**.

   There's a hint bar along the bottom of the window that always shows what the
   keys and mouse do right now, so none of this needs memorising.
4. **Export.** Choose a folder, pick PNG or JPEG, and adjust the filename
   pattern if you want — you see the resulting filename as you type. Default
   naming is `clipname_shot007_00-00-12-14`, with `A` and `B` added where a
   shot has a pair.

Alongside the images you get a `manifest.csv` listing every exported frame with
its shot number, frame number and timecode — useful if the stills are feeding
something else.

Images come out at full source resolution, upright, with the correct shape
even if the footage is rotated or anamorphic.

---

## Building it yourself

```bash
npm install
npm run dev
```

To produce installers:

```bash
npm run package:win
```

`package:mac` and `package:linux` do the same for those platforms, and must be
run on that platform. `SPEC.md` describes what the program is meant to do and
`MILESTONES.md` how it was built; the icon is one file, documented in
`build/README.md`.

---

## Licence

BreadCrumbs is free software under the **GNU General Public License v3 or
later**. You may use it, share it, and change it. If you distribute a changed
version, that version has to be free under the same terms and you have to make
your source available.

The full text is in [LICENSE](LICENSE).

It bundles **FFmpeg**, which does the actual video decoding, under the GPL —
that's why the whole program is GPL rather than something more permissive.
[THIRD-PARTY.md](THIRD-PARTY.md) lists everything included and its licence, and
[SOURCES.md](SOURCES.md) tells you where to get the source for the bundled
components, which the GPL requires.

There is no warranty. See the licence for the full disclaimer.
