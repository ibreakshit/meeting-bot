# human-cursor (vendored)

Source: https://github.com/CloverLabsAI/human-cursor at commit `b5eb4581351ee7e4d891e28587664d8499fbc65e` (MIT, see `LICENSE`).
The files under this directory are copied verbatim from that commit's `src/` directory.

It is vendored because the repository does not commit its build output and its `prepare` script needs yarn, so `npm ci` cannot install it from GitHub.
The npm package named `human-cursor` is an unrelated project.

To update, copy `src/*.ts` (excluding `__debug__` and `__test__`) from a newer commit and update the hash above.
Use it through `src/lib/humanCursor.ts`, not directly.
