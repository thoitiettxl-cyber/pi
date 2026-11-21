# pi-provider-devin

Standalone Devin provider for pi. Requires Node.js 22.19+ and a current pi with
the native Provider API.

## Install

```sh
pi install git:github.com/thoitiettxl-cyber/pi@provider-devin
```

Restart pi after installing. For a local checkout:

```sh
pi install /absolute/path/to/pi-provider-devin
# Or load without installing:
pi -e /absolute/path/to/pi-provider-devin --list-models
```

## Sign in

Run `/login`, select **Devin**, then choose a login method:

- **Browser**: opens Devin's authorization page using PKCE. The callback listens
  only on `127.0.0.1:59653/callback`. For SSH or headless machines, paste the full
  callback URL (recommended) or authorization code into pi. If the local port is
  occupied, manual entry still works. A pasted URL must have the matching state.
- **Existing Devin CLI credentials**: first run `devin auth login`. The extension
  reads `windsurf_api_key` from `devin/credentials.toml` in `%APPDATA%` on Windows,
  `$XDG_DATA_HOME`, `~/.local/share`, or `~/Library/Application Support`.
  An optional API server must be `server.codeium.com` or
  `server.enterprise.windsurf.com`. Enterprise browser login is not included.

Alternatively, set a token or API key without logging in:

```sh
export DEVIN_API_KEY='your-token-or-key'
pi --provider devin --model swe-1-6
```

Pi stores OAuth credentials using its own credential store. Session tokens
expire at their JWT expiry (or after one year if not a JWT); expired credentials
require `/login` again. There is no refresh-token endpoint. Never commit your
token, credentials.toml, or pi credential store.

## Models

`swe-1-6` (SWE-1.6) is available synchronously, even before login: 200K context,
128K output, reasoning and parallel tool calls, text-only, with zero listed token
cost. It is the complete bundled seed from omp.

Pi's current `--list-models` command lists only authenticated providers, not
every synchronous model. To smoke-test loading without real credentials or
network calls, use `PI_OFFLINE=1 DEVIN_API_KEY=smoke-placeholder pi -e /path/to/package --list-models`.
The placeholder cannot authenticate a real turn. Without any credential the
provider still registers its seed, but this pi version hides it in that command.

After authentication, pi's model refresh discovers your account's catalog using
`GetCliModelConfigs`. Internal/review-only entries are hidden. Effort variants
collapse into logical models with selectable pi thinking levels; the account
default effort is retained. The `adaptive` router, when returned by the account,
uses `AssignModel` before each chat turn. The last successful catalog is
persisted through pi and retained if discovery fails. Use `pi update` to refresh
and `pi --list-models devin` to inspect available models.

## How it works

This is an **unofficial internal Cascade API** client, ported from oh-my-pi (MIT).
It sends self-contained protobuf messages using Connect framing to
`https://server.codeium.com`, with the native Devin CLI identity and credential
encoding. No Devin CLI process, Bun, protobuf library, or runtime dependency is
needed. The two pi packages are peer dependencies supplied by pi.

Supported: streaming text/thinking/signatures, tool-call arguments, image
history, token usage/cost, routing, request/response gzip, error trailers,
cancellation, and pi request/response/event hooks. Session IDs map to Cascade
thread IDs. Gemini tool schemas are normalized locally. Account quota reports
(`/usage`) are not included.

The API and pinned CLI identity may change without notice. Discovery is
account-scoped; a listed model may still be unavailable to your plan. Catalog
prices are estimates, not a billing guarantee.

## Troubleshooting

- **No Devin entry**: ensure the package is installed, restart pi, and check
  extension loading errors. This requires pi's native Provider API.
- **Expired or rejected token**: run `/login` again, or replace `DEVIN_API_KEY`.
- **Browser callback fails**: paste the full callback URL into pi. Forward port
  59653 for SSH if you want automatic callbacks. A mismatched state requires a
  fresh login.
- **Only SWE-1.6 is listed**: authenticate and refresh models. A failed or empty
  discovery response keeps the previous catalog. The internal CLI identity may
  need updating if the backend changes.
- **Opaque internal error**: try a smaller context or fewer images. Only large,
  shrinkable history failures are classified as context overflow.
- **Images ignored**: SWE-1.6 is text-only despite its upstream image flag; use
  an image-capable discovered model.

## Later live check

No live Devin request is required by the automated tests. With your own valid
token and the package installed, run these separately (they incur real usage):

```sh
# One text turn, without tools:
DEVIN_API_KEY='your-token' pi --provider devin --model swe-1-6 --no-session --no-tools -p 'Reply with exactly DEVIN_OK.'

# One read-only tool turn, then a response:
DEVIN_API_KEY='your-token' pi --provider devin --model swe-1-6 --no-session --tools read -p 'Call the read tool on README.md, then report its first heading.'
```

Run the second command in a directory containing a README.md. If the model
answers without calling a tool, inspect JSON events with `--mode json` and retry
with a tool-capable discovered model. No live credentials were used to develop
or test this package.

## Development

In a pi monorepo worktree, dependencies may resolve from the parent checkout:

```sh
npm run check
../node_modules/.bin/vitest run test/stream.test.ts test/auth.test.ts test/discovery.test.ts
```

Tests use mocked fetch transports and real protobuf/Connect encoding; the OAuth
test uses a loopback HTTP callback. Tests do not call Devin.

## License

MIT. Ported modules carry `Ported from oh-my-pi (MIT)`; see LICENSE for the full
upstream copyright and permission notices.
