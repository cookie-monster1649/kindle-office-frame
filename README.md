# Frame

An always-on e-ink desk panel built from a Kindle Paperwhite 3, driven by a
small render service on a homelab NUC.

The Kindle sleeps for almost all of its life, waking on a timer to fetch a
pre-rendered image and paint it. All layout, typography and dithering happen
server-side; the device does an HTTP request and a framebuffer write.

```
┌──────────────────┐         HTTP(S)        ┌────────────────────────────┐
│  Kindle PW3      │  ───────────────────▶  │  NUC                       │
│  FW 5.16.2.1.1   │   HEAD + If-None-Match │  kindleframe container     │
│                  │  ◀───────────────────  │                            │
│  wake → fetch    │   304, or a PNG        │  Satori → SVG → PNG        │
│  → paint → sleep │                        │  → 16-level dither         │
└──────────────────┘                        └────────────────────────────┘
        ▲                                          ▲          │
        │ power button → menu                      │          └─ Open-Meteo
        │                                   POST /status
                                       (phone, script, HA)
```

---

## 1. Why this shape

### Server-side rendering

The Kindle's software is from 2015: an ancient WebKit, a slow CPU, few fonts.
Anything laid out on the device looks worse and takes longer than the same work
done on the NUC. Rendering server-side inverts that — the Kindle's job shrinks
to a fetch and a blit, which is the one thing it does cheaply and reliably.

The renderer is **Satori + resvg**, not headless Chromium. A browser buys real
CSS layout, but costs ~400MB of image, 150–300MB of RSS per render, a 256MB
`shm_size` workaround, zombie process reaping, and output that drifts when
Chromium changes its font hinting. Satori renders a fixed subset
deterministically from fonts the image ships itself, in ~9MB of dependencies.

The trade is a smaller CSS subset — flexbox, absolute positioning, borders,
text properties; no stylesheets, no grid, no selectors. For a fixed-size panel
with a designed layout that is not a real constraint.

### Poll and suspend

E-ink holds its image with zero power, and the whole design leans on that. The
device wakes on an RTC alarm, fetches, paints, and suspends to RAM. Measured on
the hardware: a 60-second alarm produced a 61-second gap with uptime
continuous, so this is a genuine suspend/resume, not a reboot.

The cost is latency — content appears within one poll interval, not instantly.
At a 15-minute cadence that costs nothing real.

### Conditional requests

Most polls find nothing changed. A conditional `HEAD` carrying the stored ETag
returns 304 in a few hundred bytes, and the screen is never touched: no image
transfer, no refresh, no ghosting, no power.

This is why the ETag deliberately **excludes the current time**. Including it
would change the frame every minute, so every poll would return 200 and repaint
— defeating the whole design. It also excludes `weather.fetchedAt`, which moves
on every cache refresh even when the readings are identical.

A consequence worth understanding: the rendered "updated" stamp shows when the
frame was last genuinely re-rendered, not when it was last requested. If the
server dies, the panel keeps showing its old stamp and the staleness is
visible. That is the more useful behaviour — e-ink fails silently, and stale
content presented as current is the worst available failure mode.

---

## 2. Who decides what is shown

Two paths, and the distinction is the point of the design.

| Device menu | Requests | Who decides |
|---|---|---|
| **In office** | nothing — paints a local asset | The device. A local override. |
| **Out of office** | nothing — paints a local asset | The device. A local override. |
| **Show server** | `?mode=server&orient=…` | **The server**, from its `display` state. |

`In` and `out` never touch the network, so they still work with the server down.

`Show server` is the useful one for an in/out board: you decide you are working
from home on the way in, not while standing at the panel.

```sh
curl -X POST -H "Authorization: Bearer $WRITE_TOKEN" \
     https://kindleframe.example/status/out
```

The panel follows within one poll. That works because the ETag hashes the
*resolved* display and the store's version counter, so a status change
invalidates the device's cached frame and it stops 304ing.

### Displays and the weekend rule

`display` is one of **`in`**, **`out`** or **`text`**, plus a **`weekendMode`**
toggle and a short **`customText`** string.

`weekend` is deliberately *not* a selectable display. It is a rule, driven by
the toggle: when on, Saturday and Sunday override whatever is selected. Making
it a value as well would mean two ways to say the same thing and an obvious
question about which wins. Turn the toggle off if you work weekends.

Setting `text` shows the custom message — capped at 120 characters, sized to
its length, wrapping rather than truncating. Sending `text` without a `display`
switches to it, since that is almost always what was meant.

`GET /status` reports the selection and the outcome, so a caller can always
explain what is on the wall:

```json
{
  "display": "in",        // what was selected
  "customText": "",
  "weekendMode": true,    // the toggle
  "effective": "weekend", // what the panel actually shows
  "autoWeekend": true,    // the rule is overriding the selection
  "version": 12
}
```

The day is decided in the display timezone, always server-side: the Kindle's
clock is UTC and it ships no tzdata, so `TZ=… date` is silently ignored there.

### Control page

`GET /` serves a single page — two status buttons, a custom-text field, the
weekend toggle, and a live preview of the frame in **both orientations**. The
device chooses which orientation it asks for, so showing one would be a guess.

No token is typed in. `GET /` issues an httpOnly `SameSite=Strict` session
cookie and the page's writes ride on that, so it can simply be opened and used.

**Be clear about what that is.** It is not authentication — anyone who can
reach the page can drive the panel. The cookie buys CSRF protection: another
site cannot make your browser POST here. **Protect the page at the proxy.** The
server says so at startup rather than leaving it implied.

### Two tokens, and Cloudflare Access

The device holds a **read token**. It sits unattended, possibly somewhere you
do not control, and could be lost — so it must be able to fetch frames and
nothing else. Every write requires a separate **write token** the Kindle never
sees, and returns `403` to the read token. Verified against the real device,
not just in tests.

Behind Cloudflare Access, use **two applications on the same hostname**:

| Application | Policy action | Who |
|---|---|---|
| `kindleframe.example/frame.png` | **Service Auth** | the Kindle, via a service token |
| `kindleframe.example` | Allow | you, via SSO |

Cloudflare matches the more specific path first, so the device's credential
only unlocks `/frame.png` — it cannot reach the control page or any write
endpoint. The policy action must be **Service Auth**; with `Allow`, Access
still demands an interactive login and the Kindle just receives a login page.

Set `CF_ACCESS_CLIENT_ID` and `CF_ACCESS_CLIENT_SECRET` in the device's
`local/env.sh` and the fetch script sends them alongside the bearer token.
They are checked by different things: the Access headers get the request
*through Cloudflare*, the bearer token gets it *past the application*.

The result is a decent position if the Kindle is stolen: the attacker holds a
credential that can fetch a picture of the weather. They cannot reach the
control page, because Cloudflare will not route them there, and they cannot
write, because the read token is refused. That holds even if one layer is
misconfigured — which is why the tokens stay even with Access in front.

TLS is fine here despite the device's age: `xh` is built against rustls
(TLS 1.2/1.3), not the 2015-era OpenSSL. The real constraint is that rustls
refuses HTTPS to bare IPs, so the endpoint must be a hostname.

---

## 3. Integrations

Setting the display is deliberately easy to call from anything that can make an
authenticated POST. Four request shapes are accepted, because integrations vary
in what they can send and a webhook that fails opaquely is close to
undebuggable from the sending end.

| Shape | Example | Suits |
|---|---|---|
| **Path, no body** | `POST /status/out` | Anything. Shortcuts, HA, cron |
| JSON | `{"display":"out"}` | Home Assistant `rest_command` |
| Form-encoded | `display=out`, or Slack's `text=out` | Slack slash commands |
| Bare string | `out` | Minimal webhook senders |

`POST /status` takes any subset of `display`, `text` and `weekendMode`:

```sh
# custom message
-d '{"text":"Back at 3pm"}'
# stop overriding weekends
-d '{"weekendMode":false}'
```

All of them need `Authorization: Bearer <write token>`.

An unknown value returns `400` and says what it will accept, rather than
failing silently:

```json
{ "error": "unknown display", "allowed": ["in","out","text"], "received": "lunch" }
```

### Home Assistant

Home Assistant runs on the same NUC, so it talks to the container directly over
the Docker network and never touches Cloudflare — no service token, no Access
policy, nothing to expire. Only the Kindle needs to come in from outside.

```yaml
rest_command:
  frame_status:
    # Container name on the shared Docker network, or the NUC's LAN address.
    url: "http://kindleframe:8080/status/{{ display }}"
    method: POST
    headers:
      Authorization: !secret frame_write_token

# Then, from an automation, script or dashboard button:
#   service: rest_command.frame_status
#   data: { display: out }
```

A device tracker makes it automatic:

```yaml
automation:
  - alias: Frame follows presence
    trigger:
      - platform: state
        entity_id: person.jj
    action:
      - service: rest_command.frame_status
        data:
          display: "{{ 'in' if trigger.to_state.state == 'home' else 'out' }}"
```

### Slack

A slash command posts form-encoded with the argument in `text`, which is read
directly — so `/frame out` works with the command URL pointed at `/status`.

Two caveats, since Slack reaches you from the internet rather than the LAN:
it cannot set an `Authorization` header on slash commands, and it would have to
get through Access. Both point at the same answer — a small proxy or workflow
step that adds the header, with an Access policy to match.

### Shortcuts, cron, anything else

```sh
curl -X POST -H "Authorization: Bearer $WRITE_TOKEN" \
     https://kindleframe.example/status/weekend
```

That is the whole integration surface: one URL, one header, no body.

---

## 4. The device

### Jailbreak

LanguageBreak, which supports firmware **≤ 5.16.2.1.1**. Nothing exists above
that, so if the device takes an OTA update the project ends permanently. OTA
blocking is mandatory rather than hardening.

Blocking is done by `renameotabin` (renames `/usr/bin/otaupd` and `otav3`) and
verified at the filesystem level — only the `.bck` copies should exist.
Verification matters: there is a documented case of someone running the
blocker, assuming it worked, connecting anyway and losing the jailbreak.

### Installed on the device

| Component | Purpose |
|---|---|
| Universal Hotfix 2.5.0 | Includes `sh_integration`, without which `.sh` files never appear in the library |
| KUAL | Extension launcher |
| MRPI | Package installer |
| USBNetwork | SSH over Wi-Fi, key auth |
| renameotabin | OTA blocking |

`sh_integration` is the non-obvious one: KUAL is itself a shell script in
`documents/`, and something has to make the Kindle index `.sh` files as library
items. The hotfix bundled with LanguageBreak predates it, so KUAL silently
never appears.

### Using it

`Frame` appears in the Kindle library. Tap it to start; press the power button
for the menu; `Exit` hands the screen back.

```
Library → Frame ──▶ menu ──▶ Show server / In office / Out of office
                     ▲                    │
              power button                ▼
                     └────────────  content on screen
                                          │
                                    Exit ─┴──▶ Kindle home screen
```

Five options, each in both orientations: `Show server`, `In office`,
`Out of office`, `Rotate screen`, `Exit`.

Menu taps get on-screen acknowledgement — `Fetching from server…`, or a named
error. Scheduled refreshes stay silent: nobody is watching, and a flash every
cycle would defeat the 304 path.

### Four device quirks that cost real time

**The RTC node.** `kindle-dash` upstream targets a Kindle 4 and writes relative
seconds to `/sys/devices/platform/mxc_rtc.0/wakeup_enable`. The PW3 has no such
node — it uses `/sys/class/rtc/rtc0/wakealarm`, which takes an absolute epoch.
Upstream would suspend with no alarm armed and never wake. `dash.sh` probes for
both and fails loudly if neither is writable, *before* taking over the screen.

**Stopping the UI.** Upstream calls `/etc/init.d/framework stop`, which does not
exist on 5.x, and a bare `initctl`, which is not on `PATH` (`/usr/bin:/bin`
only). Both fail silently, so the Kindle keeps drawing its status bar over the
frame.

Worse, anything that *does* kill `cvm` — `stop framework`, `stop lab126_gui` —
cannot be undone without a reboot; every restart path reports success while the
panel stays frozen. So Frame follows KOReader's default and never kills
anything: it disables pillow over lipc, `SIGSTOP`s `awesome`, and stops the
separate `statusbar` upstart job. Handing back is a `SIGCONT` and a lipc call
to show the home screen.

**Touch cannot wake the device.** The touch controller has no `power/wakeup`
node; only the RTC, the PMIC onkey and USB can wake it. So interaction is:
press power to wake early, then tap. There is no kernel wake-reason to read, so
`dash.sh` infers it from the clock — an RTC wakeup lands on its target, a button
press arrives before it.

**Reachability probes are the wrong tool.** An earlier version pinged a host
before fetching. Pinging something public succeeds before the route to the
server is usable; pinging the server fails permanently against any host
filtering ICMP, which includes a Mac with stealth mode on. The fetch now simply
retries with a short timeout — testing the one connection that has to work.

### Rotation

The framebuffer is always 1072×1448 portrait and touch always reports in device
coordinates, however you hold the device. Landscape therefore means composing
at 1448×1072, rotating 90° into the portrait buffer, and pushing the hit regions
through the same transform.

All of that lives in `render/`. It emits a PNG *and* a `.regions` file already
in device coordinates, so the on-device code never does rotation maths — it just
loads `menu-landscape.png` alongside `menu-landscape.regions`.

---

## 5. The server

### Endpoints

| Method | Path | Auth | Notes |
|---|---|---|---|
| `GET` | `/` | none | Control page; reveals nothing without a token |
| `GET` | `/frame.png?mode=&orient=` | read | The rendered frame, ETag, 304 |
| `HEAD` | `/frame.png?mode=&orient=` | read | What the device actually polls with |
| `GET` | `/status` | read | `display`, `effective`, `autoWeekend`, `version` |
| `POST` | `/status` | **write** | `display`, `text`, `weekendMode` — any subset |
| `POST` | `/status/:display` | **write** | Path form, no body |
| `POST` | `/content` | **write** | Markdown, stored but not yet displayed |
| `GET` | `/content` | read | Current markdown and version |
| `GET` | `/healthz` | none | Liveness |

`mode` is `server`, `in`, `out`, `text` or `weekend`; `orient` is `portrait` or
`landscape`. Both
are validated against an allow-list and fall back to defaults. They select a
rendering only — they change no server state, and the device's read token could
not change anything if they did.

Markdown is stored and rendered but not yet reachable: `mode=server` resolves to
`in`/`out` only. The pipeline is kept wired and tested so adding a `text`
display later is a small change rather than a rebuild.

### Render pipeline

```
markdown ──▶ markdown-it tokens ──▶ Satori element tree
                                            │
                                     Satori ──▶ SVG
                                            │
                                      resvg ──▶ PNG
                                            │
                        rotate if landscape ─┤
                                            │
                      greyscale + Floyd–Steinberg
                                            │
                       remap to 16 fixed grey levels
                                            │
                     force PNG colour-type 0 ──▶ device
```

Two steps are easy to get subtly wrong, and both fail silently on the device:

- **`-colors 16` is wrong.** It picks an *adaptive* palette from image content —
  18 content-derived levels when measured. The panel has 16 *fixed* levels
  (`i*255/15`); feed it anything else and it re-quantises with a worse
  algorithm. We `-remap` onto an explicit ramp instead.
- **`eips` refuses palette-indexed PNGs** with `paint_image> … 8bit only`.
  Remapping produces one by default, so the output is forced back to true
  greyscale with `png:color-type=0`.

Both are asserted in the test suite.

### Layout

Landscape is two columns (55/45, status | weather) with a vertical rule.
Portrait stacks them and drops the horizontal rules — stacked sections are
already separated by whitespace and a change of type size, so the lines read as
clutter there.

Weather glyphs are inline SVG, not Unicode. `☀ ☁ ☂` render inconsistently
across fonts and come out spindly once dithered; drawn strokes stay crisp
because we control the weight.

**Satori has no font fallback.** It renders only from the faces handed to it, so
any character the shipped font lacks becomes a tofu box — which is how the
high/low arrows first rendered, since Georgia has no U+2191. They are drawn as
SVG now, removing the dependency on glyph coverage.

Type is **Charis SIL** in the container, **Georgia** locally — both Matthew
Carter designs for low-resolution screens, which is exactly the e-ink problem.
Charter itself is a `.ttc` collection, which Satori cannot read.

### Weather

Open-Meteo, because it needs no API key and so the service deploys without
secret management. Cached 15 minutes. `weather.js` returns a provider-agnostic
shape, so swapping to Home Assistant means rewriting one function.

**A weather outage does not take the frame down.** `getWeather()` returns `null`
rather than throwing, the template renders a visible "weather unavailable" gap,
and stale readings are preferred over none. A panel showing the date and
someone's status beats a blank panel.

---

## 6. Running it

Setting this up on a new machine, or moving it, is a separate runbook:
**[DEPLOY.md](DEPLOY.md)** — what must be carried across, what goes on the
NUC, and which credentials the Kindle needs.

### Locally

```sh
cd server
npm install
npm test                    # 52 tests, no setup needed
npm run preview             # renders all 6 frames to ./out
OFFLINE=1 npm run preview   # fixture weather, no network
FRAME_READ_TOKEN=r FRAME_WRITE_TOKEN=w npm start
```

`preview` asserts every frame against the constraints the device enforces —
dimensions, grey levels, PNG colour type — so a layout change that `eips` would
reject fails on your laptop instead of silently on the wall. It also writes the
intermediate SVG, which opens in any browser for iterating on layout without a
render cycle.

The font differs between local and container (Georgia vs Charis SIL). Metrics
are close but not identical, so long text can break lines differently. Set
`FONT_REGULAR` and `FONT_BOLD` if you need an exact match.

### On the NUC

```sh
cp .env.example .env      # set the two tokens and your location
docker compose up -d --build
```

The image needs only ImageMagick and a font — no browser, no `shm_size`, no
process reaping. Because Satori renders from fonts installed in the image
rather than discovering system fonts, output is reproducible.

### On the Kindle

```sh
./render/make-screens.sh                                   # generate assets
rsync -avz --exclude=local/state kindle/ kindle:/mnt/us/dashboard/
rsync -avz render/screens/ kindle:/mnt/us/dashboard/screens/
cp kindle/tools/Frame.sh /Volumes/Kindle/documents/        # library launcher
```

Then tap **Frame** in the library. Config is `local/env.sh`, where `FRAME_TOKEN`
must hold the **read** token.

Over TLS the endpoint **must be a hostname, not an IP** — `xh` is built against
rustls, which refuses HTTPS to bare IP addresses. Plain HTTP to an IP is fine
for local testing.

---

## 7. Repository layout

```
kindle/            on-device runtime
  dash.sh            state machine, RTC suspend, UI takeover, menu
  modal.sh           paints a screen, reads touch, reports the region hit
  start.sh stop.sh   launch and hand back
  local/env.sh       endpoint, token, schedule
  local/fetch-*.sh   conditional HEAD, retrying GET, PNG validation
  tools/Frame.sh     library launcher (needs sh_integration)
  tools/Block.OTA.sh on-device OTA blocker with reporting
  xh next-wakeup     bundled ARM binaries from kindle-dash
render/            generates the on-device screens
  make-screens.sh    menu + status cards, both orientations, with hit regions
  lib.sh             rotation, quantisation, region transforms
server/            the NUC service
  src/               config, fonts, weather, store, render, templates
  src/templates/ui   the control page
  scripts/preview    render every frame and check device constraints
  test/              52 tests: ETag, auth boundary, weekend rule, integrations
secrets/           SSH key and tokens (gitignored)
```

---

## 8. Known gaps

**WPA3.** The PW3 supports WPA2 only. WPA3 mandates Protected Management Frames,
which needs driver and firmware support a 2015 device on Linux 3.0.35 does not
have — not solvable in software. A travel router in repeater mode is the
practical fix, and has the side benefit of restoring network-level OTA blocking.

**Device in/out cards carry no weather.** They are static PNGs so they work
offline; the server renders richer versions of the same two modes. Whether the
device should prefer the server's version with the static one as a fallback is
undecided.

**Battery.** A 2015 lithium cell held permanently at 100% will swell. With
poll-and-suspend the device should run for weeks per charge, so charging
periodically rather than continuously is both sufficient and kinder to the cell.

**No git history.** `.gitignore` excludes `secrets/`, but the repository is not
initialised — worth doing before anything else, so the key and tokens never have
a chance to land in a commit.
