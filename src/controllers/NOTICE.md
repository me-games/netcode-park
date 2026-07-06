# Third-party notices

The controller code and assets in this directory are vendored into your game
by `npx genex controller`. They bundle the following third-party work:

## ecctrl — MIT License

The character, vehicle, and drone controllers are a vanilla-TypeScript port of
the **ecctrl** character/vehicle controller library (a pmndrs project),
pinned at upstream commit `e2f4eb8`.

Copyright (c) 2023-2026 Erdong Chen

Permission is hereby granted, free of charge, to any person obtaining a copy
of this software and associated documentation files (the "Software"), to deal
in the Software without restriction, including without limitation the rights
to use, copy, modify, merge, publish, distribute, sublicense, and/or sell
copies of the Software, and to permit persons to whom the Software is
furnished to do so, subject to the following conditions:

The above copyright notice and this permission notice shall be included in all
copies or substantial portions of the Software.

THE SOFTWARE IS PROVIDED "AS IS", WITHOUT WARRANTY OF ANY KIND, EXPRESS OR
IMPLIED, INCLUDING BUT NOT LIMITED TO THE WARRANTIES OF MERCHANTABILITY,
FITNESS FOR A PARTICULAR PURPOSE AND NONINFRINGEMENT. IN NO EVENT SHALL THE
AUTHORS OR COPYRIGHT HOLDERS BE LIABLE FOR ANY CLAIM, DAMAGES OR OTHER
LIABILITY, WHETHER IN AN ACTION OF CONTRACT, TORT OR OTHERWISE, ARISING FROM,
OUT OF OR IN CONNECTION WITH THE SOFTWARE OR THE USE OR OTHER DEALINGS IN THE
SOFTWARE.

Every ported source file carries its own SPDX header
(`SPDX-FileCopyrightText: 2023-2026 Erdong Chen`,
`SPDX-License-Identifier: MIT`).

## Quaternius Universal Animation Library — CC0 1.0 Universal

- `assets/animation-library.glb` — the Universal Animation Library by
  **Quaternius** (quaternius.com): 46 humanoid animation clips on a
  Blender-Rigify-style skeleton, as bundled by upstream ecctrl.

Dedicated to the public domain under the Creative Commons CC0 1.0 Universal
license (SPDX: `CC0-1.0`). No attribution is required by the license; this
notice is provided as a courtesy.

## Default avatar — CC0 1.0 Universal

The character controller plays as your VRM avatar. When you have not chosen one
(or run offline), the bundled default `assets/default-avatar.vrm` is copied to
`public/assets/avatar.vrm`. It is **Wizzir** from the **100 Avatars** project by
**Polygonal Mind** (polygonalmind.com), dedicated to the public domain under
CC0 1.0 Universal (SPDX: `CC0-1.0`). Attribution is a courtesy, not required.

## @pixiv/three-vrm — MIT License

The VRM support in `character/vrm/` (loader, animation retargeter, foot IK) is
built on the **@pixiv/three-vrm** npm package, MIT-licensed by pixiv Inc.
`vrm-retarget.ts` adapts that package's official humanoid-retarget example (MIT)
to the Quaternius rig. Install it into your game with `npm i @pixiv/three-vrm`.

Copyright (c) 2019-2026 pixiv Inc. — Permission is hereby granted, free of
charge, to any person obtaining a copy of this software and associated
documentation files, to deal in the Software without restriction. THE SOFTWARE
IS PROVIDED "AS IS", WITHOUT WARRANTY OF ANY KIND. (Full MIT text ships with the
`@pixiv/three-vrm` package's LICENSE file.)
