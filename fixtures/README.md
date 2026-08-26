# Fixtures

Test clips for `npm run inspect` and every phase gate. Media files are
gitignored (see `.gitignore`) — this folder is tracked, its contents are not.

MILESTONES.md requires at least five clips, each **under 30 seconds**:

| Filename (expected)   | What it must be                                              | Which gates need it |
|-----------------------|--------------------------------------------------------------|---------------------|
| `live-action.mp4`     | Live action with unambiguous hard cuts                       | 1, 3, 4, 7 |
| `animation.mp4`       | Animation or CG, ideally with held frames (2s/3s)            | 4 |
| `screencap.mp4`       | Screen or game capture                                        | 1, 4 |
| `rotated.mov`         | Phone video with 90° rotation metadata, portrait              | 1, 2, 5, 7 |
| `vfr.mkv`             | Genuine variable frame rate                                   | 1, 2 |
| `long-1080p.mp4`      | ~2 minutes, 1080p — the performance-budget clip               | 2, 3 |

Extensions may differ; `inspect` discovers whatever is in this folder.
