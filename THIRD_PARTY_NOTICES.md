# Third-party notices

Lapis is licensed under Apache-2.0. Its npm runtime and development dependencies remain governed by their publishers' licenses. The exact name, version, usage scope, and SPDX expression derived from `package-lock.json` are recorded in [`docs/third-party-licenses.csv`](docs/third-party-licenses.csv) and checked by `npm run licenses:check`.

Reviewed license families include MIT/MIT-0, ISC, BSD-2-Clause, BSD-3-Clause, Apache-2.0, 0BSD, BlueOak-1.0.0, CC0-1.0, MPL-2.0 and Unicode-style permissive terms. Notable alternatives or additional terms are:

- DOMPurify is offered under MPL-2.0 or Apache-2.0; this distribution relies on the Apache-2.0 option.
- JSZip is offered under MIT or GPL-3.0-or-later; this distribution relies on the MIT option.
- pako includes MIT and Zlib terms.
- Optional libvips binaries in the development toolchain include LGPL-3.0-or-later components; they are not part of the Lapis Windows launcher runtime.
- `caniuse-lite` browser compatibility data is CC-BY-4.0 and is used only by the build toolchain.

The demo cover in `assets/lapis-demo-cover.jpg` is derived from [Night Sky - Boney Mountain](<https://commons.wikimedia.org/wiki/File:Night_Sky_-_Boney_Mountain_(12957596483).jpg>), photographed by Santa Monica Mountains National Recreation Area. Wikimedia Commons identifies the source as a work of the U.S. National Park Service and marks it as public domain. The source image is retained as `assets/lapis-cover-source.jpg` for provenance.

The installed packages include their own license and notice files. Release archives must preserve those files inside `node_modules`; removing them is not supported. Projects referenced in design/research documents were studied for patterns but their source is not copied into Lapis.

## Fonts

The interface bundles three typefaces licensed under the SIL Open Font License, Version 1.1 (OFL-1.1). OFL-1.1 is a reviewed license for these bundled font files.

| Typeface      | Copyright                                        | Folder                                 |
| ------------- | ------------------------------------------------ | -------------------------------------- |
| Alegreya      | Copyright 2011 The Alegreya Project Authors      | `apps/web/public/fonts/alegreya/`      |
| Alegreya Sans | Copyright 2013 The Alegreya Sans Project Authors | `apps/web/public/fonts/alegreya-sans/` |
| Courier Prime | Copyright 2015 The Courier Prime Project Authors | `apps/web/public/fonts/courier-prime/` |

Each folder keeps the full license text as `OFL.txt`. The WOFF2 files and their `@font-face` rules were copied from the Fontsource 5.3.0 packages (`@fontsource-variable/alegreya`, `@fontsource/alegreya-sans`, `@fontsource/courier-prime`) as files, not as npm dependencies, so they are not listed in `docs/third-party-licenses.csv`. The Lapis wordmark outlines in `assets/lapis-logo-wide*.svg` and `apps/web/src/components/lapis-logo-paths.ts` are derived from Alegreya.

## Upstream project

This repository is a derivative of the [NarraLume project](https://github.com/abligail/narralume), licensed under Apache-2.0. The attribution required by the Apache-2.0 license is recorded in the [`NOTICE`](NOTICE) file; the changes made here are described in the [`CHANGELOG.md`](CHANGELOG.md) and the Git history.
