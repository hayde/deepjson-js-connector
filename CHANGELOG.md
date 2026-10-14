# Changelog

All notable changes to `deepjson-connector`.

The format follows [Keep a Changelog](https://keepachangelog.com/en/1.1.0/), and
this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [Unreleased]

Nothing yet.

## [2.3.0] - 2026-10-14

### Added

- `getIfChanged(key, etag)` - a conditional read that revalidates a copy you
  already hold. Resolves to `{ changed: true, value, etag }` when the key has
  moved on, or `{ changed: false, value: undefined, etag }` when the server
  answers `304 Not Modified`. The returned `etag` is always the server's current
  version, so it feeds straight back into the next call.

  It exists as its own method rather than an option on `get()` because a
  conditional read has two legitimate outcomes and only one of them has a body.
  Only a `304` is absorbed: `404`, `403` and network failures still throw, so a
  missing key cannot be mistaken for an unchanged one.
- `err.notModified` on the error from a `304`, for callers driving
  `setIfNoneMatch()` through `get()` directly. `fetch` counts `304` as not-ok,
  so it arrives as a thrown error either way; the flag distinguishes it from a
  real failure.

### Fixed

- A `304` response no longer produces an empty-string `err.details`. Both `204`
  and `304` are defined to carry no body, so `details` is `null`.

### Notes

This release pairs with the server fix that made `If-None-Match` on `GET`/`HEAD`
answer `304` rather than `412`. Against the older behaviour a conditional read
raised `412`, which `getIfChanged()` does not absorb - it will throw. Browser
caching for `getBinaryURL()` URLs is unaffected by anything here: the browser
makes those requests, so stale-cache behaviour is governed by the server's
`Cache-Control`, which the connector cannot influence.

## [2.2.0] - 2026-10-10

Four server features that the client could not reach, plus two bugs found while
wiring them up.

### Added

- **Optimistic concurrency.** `getETag()` returns the version of the last
  response; `setIfMatch(etag)` makes the next write conditional, so a write that
  would clobber another client's change fails with `412` instead of succeeding
  silently. `setIfMatch('*')` requires the key to exist, `setIfNoneMatch('*')` is
  a conditional create. Both setters are one-shot, like `setBinary()`.
  A `412` carries the server's current version as `err.etag`, so a retry needs no
  extra read.
- **Listing options.** `listKeys(pattern, { limit, offset, count })` for paging
  and counting. The result reports `total` (the full match count, independent of
  paging) plus `offset`, `limit` and `truncated` when paged.
- **Direct binary URLs.** `getBinaryURL(key, imageOptions?)` builds a
  self-authenticating URL for an `<img src>`, `<a href>` or new tab, where no
  `Authorization` header can be set. Note that such a URL is a bearer credential
  in a query string and expires with the token that built it - see the README.
- **Server-side image modulation.** `setImageOptions({ width, height, fit,
  alignX, alignY, allowEnlarge, format, quality })` for binary reads, and the
  same options on `getBinaryURL()`. An unrecognised option throws rather than
  quietly returning the untouched image.
- **Admin API** under `dj.admin`, covering every administrative endpoint:
  `keys()`, `health()`, `modifications(since)`, `rebuildIndex()`,
  `rotateIndex()`, `reloadAccess()` and `logs()`. All require an admin account
  and answer `403` otherwise; `whoami().isAdmin` reports eligibility.

### Fixed

- `listKeys()` mangled any `RegExp` carrying flags. The pattern was derived by
  stringifying and slicing off the first and last character, so `/^users\./i`
  was sent as `^users\./` - a different expression, matching the wrong keys with
  no error. It now uses `regex.source`. Flags are dropped rather than smuggled
  into the pattern, because the server compiles with `new RegExp(pattern)` and
  no flags.
- `admin.modifications(since)` now rejects anything that is not a non-negative
  integer. The server `parseInt`s the value and compares with `>`, so `null`,
  `''` or `'abc'` returned an empty change list with a `200` - a silently wrong
  "nothing changed".

### Documentation

- The README documented `get(key, { binary: true, width: 800 })`, which never
  existed: those options were sent as the request *body* of a `POST`, with no
  binary mode and no resizing. Replaced with the forms that work.
- Added guidance on `key_list_limit`: an operator can cap every listing, so even
  an unpaged `listKeys()` may return part of the keyspace with `truncated: true`.

## [2.1.0] - 2026-09-30

### Added

- `version()` - `GET /version`. Behind authentication, so it doubles as a
  heartbeat and a token-validity check.
- `whoami(keys?)` - identity, groups and admin flag. Pass one or more keys to
  have the server resolve their effective permissions as `{ C, R, U, D, X }`.

  The response also carries a `rules` list flagged `rulesAreAdvisory`. It is for
  display only: the server evaluates rules in order with last-match-wins, so a
  client reimplementing "any matching rule grants it" disagrees with it exactly
  on revocations. Use `permissions` for anything load-bearing.

## [2.0.0] - 2026-09-18

Zero runtime dependencies, and sliding sessions.

### Changed - BREAKING

- **`connector.axios` is gone.** Nothing uses axios any more. Use the `headers`
  config option, or `onTokenRenewed`, in its place.
- **Node 18 or newer is required**, for the global `fetch`.

### Added

- **Sliding sessions.** The server renews the token on every authenticated
  response via `X-Renewed-Token`; the connector adopts it automatically, so an
  actively used session no longer expires at the original one-hour mark. New
  `onTokenRenewed` config callback for persisting it, and `setToken()` for
  restoring a persisted one. For `SyncConnector` a renewed token also reaches
  the socket handshake query, so its reconnects authenticate with the current
  token.
- `DeepJSONSocket`, a small socket.io v4 protocol client over a native
  `WebSocket`, used by `SyncConnector` by default. Pass `io` in the config to
  use `socket.io-client` instead - needed only for HTTP long-polling, which the
  built-in client does not implement.
- A test suite on `node:test`, so running the tests installs nothing either.

### Removed

- `axios`, `form-data` and `socket.io-client` as dependencies - 28 packages
  down to none. The connector now runs on platform built-ins only: `fetch`,
  `FormData`, `Blob`, `URL` and `WebSocket`. A browser can load a single file
  from a `<script>` tag with no network access.

### Internal

- `src/deepjson-connector.js` is now generated from `src/core.js` by
  `scripts/build-umd.js`. The two files were previously maintained by hand and
  had drifted apart.

## [1.2.2] - 2026-08-31

### Fixed

- Binary downloads in Node.js returned corrupted data; the request now sets
  `responseType: 'arraybuffer'`.

## [1.2.1] - 2026-08-31

### Fixed

- First attempt at the binary download fix above, completed in 1.2.2.

## [1.2.0] - 2026-04-07

### Changed

- Build outputs restructured: CommonJS and ESM for Node, a UMD bundle for a
  `<script>` tag, and a standalone browser ESM bundle, all generated from one
  source. No API change.

## [1.1.1] - 2026-04-07

### Changed

- Packaging and build fixes for the 1.1.0 outputs.

## [1.1.0] - 2026-04-07

### Changed

- ESM build added alongside the existing outputs.

## [1.0.9] - 2026-04-06

### Changed

- Maintenance release.

## [1.0.8] - 2025-12-11

### Security

- Dependency update addressing a vulnerability in a transitive dependency.

## [1.0.7] - 2025-06-16

### Added

- A `script` parameter on `get()`, `post()` and `put()`, for server-side
  script execution.

### Removed

- `setGetBody()` and `hasGetBody()`. `get()` now takes its parameters directly,
  which made the flag unnecessary.

### Changed

- `move()` reworked.

## [1.0.5] - 2025-05-15

### Fixed

- Browser stability improvements.

## [1.0.4] - 2025-05-14

### Added

- File upload support for Node.js.
- A minified browser bundle.

## [1.0.1] - [1.0.3] - 2025-05-10

### Fixed

- Packaging corrections: `.npmignore` and `.gitignore` settings, and a missing
  `dist` build in the published package.

## [1.0.0] - 2025-05-09

Initial release: key/value CRUD, authentication, file upload, key listing, and
real-time sync channels over socket.io.

---

Entries for 2.0.0 and later were written alongside the changes. Earlier entries
were reconstructed afterwards from the git history and the published packages,
so they describe what changed but not necessarily every detail; the API surface
was verified to be unchanged across 1.0.7 through 1.2.2. Version 1.0.6 was never
published.
