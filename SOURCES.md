# Source code for bundled binaries

BreadCrumbs is licensed under the GNU General Public License version 3, and it
ships prebuilt FFmpeg binaries that are themselves GPL v3. The GPL requires
that anyone receiving those binaries can obtain the corresponding source code.

This file is how that requirement is met. It records exactly which builds are
shipped and where to get their source.

If any link here is broken, or you cannot obtain the source by these means,
please open an issue on the project repository and it will be corrected.

---

## FFmpeg — `ffmpeg`

| | |
|---|---|
| **Version** | `6.1.1-essentials_build-www.gyan.dev` |
| **Upstream source** | https://ffmpeg.org/releases/ffmpeg-6.1.1.tar.xz |
| **Upstream repository** | https://git.ffmpeg.org/ffmpeg.git — tag `n6.1.1` |
| **Obtained via** | npm package [`ffmpeg-static`](https://github.com/eugeneware/ffmpeg-static) 5.3.0 |
| **Build produced by** | Gyan Doshi's Windows builds, https://www.gyan.dev/ffmpeg/builds/ |
| **Licence** | GPL v3 or later (`--enable-gpl --enable-version3`) |

### Build configuration

The binary reports this configuration. It is reproduced in full because the GPL
requires the *corresponding* source — meaning the source together with the
information needed to rebuild the same thing.

```
--enable-gpl --enable-version3 --enable-static --pkg-config=pkgconf
--disable-w32threads --disable-autodetect --enable-fontconfig --enable-iconv
--enable-gnutls --enable-libxml2 --enable-gmp --enable-bzlib --enable-lzma
--enable-zlib --enable-libsrt --enable-libssh --enable-libzmq --enable-avisynth
--enable-sdl2 --enable-libwebp --enable-libx264 --enable-libx265
--enable-libxvid --enable-libaom --enable-libopenjpeg --enable-libvpx
--enable-mediafoundation --enable-libass --enable-libfreetype --enable-libfribidi
--enable-libharfbuzz --enable-libvidstab --enable-libvmaf --enable-libzimg
--enable-amf --enable-cuda-llvm --enable-cuvid --enable-ffnvcodec --enable-nvdec
--enable-nvenc --enable-dxva2 --enable-d3d11va --enable-libvpl --enable-libgme
--enable-libopenmpt --enable-libopencore-amrwb --enable-libmp3lame
--enable-libtheora --enable-libvo-amrwbenc --enable-libgsm
--enable-libopencore-amrnb --enable-libopus --enable-libspeex --enable-libvorbis
--enable-librubberband
```

To retrieve it from the binary itself:

```bash
ffmpeg -hide_banner -version
```

The components making this build GPL rather than LGPL are `libx264`,
`libx265`, `libxvid`, `libvidstab` and `librubberband`. Each carries its own
licence and its own source, available from its own project.

---

## FFmpeg — `ffprobe`

| | |
|---|---|
| **Version** | `4.0.2` |
| **Upstream source** | https://ffmpeg.org/releases/ffmpeg-4.0.2.tar.xz |
| **Upstream repository** | https://git.ffmpeg.org/ffmpeg.git — tag `n4.0.2` |
| **Obtained via** | npm package [`ffprobe-static`](https://github.com/joshwnj/ffprobe-static) 3.1.0 |
| **Licence** | GPL v3 or later (`--enable-gpl --enable-version3`) |

`ffprobe` is part of the FFmpeg project and built from the same source tree as
`ffmpeg`; the release above contains it.

> **Note.** The npm package `ffprobe-static` declares itself MIT. That covers
> its own JavaScript wrapper, not the executable it installs, which is GPL v3
> as recorded here. It also does not ship the GPL text alongside the binary —
> BreadCrumbs supplies it (see `LICENSE`).

To retrieve the configuration from the binary:

```bash
ffprobe -hide_banner -version
```

---

## How BreadCrumbs uses these

Both are invoked as **separate operating-system processes** via Node's `spawn`,
receiving command-line arguments and returning output. Neither is modified, and
neither is linked into BreadCrumbs. The call sites are in `src/main/media/`.

Replacing either binary with another build of the same version is supported:
the paths are resolved at startup in `src/main/media/binaries.ts`.

---

## Everything else

All other bundled components are under permissive licences (MIT, BSD, ISC,
Apache-2.0) and are published on npm, from which their source is directly
available. `package-lock.json` in this repository pins every one to an exact
version, so the full set is reproducible with `npm ci`.

The complete inventory is in [THIRD-PARTY.md](THIRD-PARTY.md).
