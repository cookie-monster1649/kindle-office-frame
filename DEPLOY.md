# Deploying

Three machines, and it matters which is which:

| | Role | Needs |
|---|---|---|
| **Admin machine** | Where you edit code, preview frames, and SSH to the Kindle | Node, ImageMagick, the SSH key |
| **NUC** | Runs the container the panel fetches from | Docker, the two tokens |
| **Kindle** | The panel | The read token, the SSH public key |

Nothing secret is in the repository. Four files have to travel separately, all
of them in `secrets/`.

---

## 1. What must be carried across

```
secrets/
  kindle_dash_ed25519       private SSH key   — admin machine only
  kindle_dash_ed25519.pub   public key        — goes on the Kindle
  known_hosts               the Kindle's host key
  tokens.env                FRAME_READ_TOKEN and FRAME_WRITE_TOKEN
```

Move them over a channel you trust — an encrypted volume, a password manager,
`scp` between your own machines. Not email, not Slack.

```sh
chmod 600 secrets/kindle_dash_ed25519 secrets/tokens.env
```

If you would rather not move the private key at all, generate a new pair on the
new machine and append its `.pub` to the Kindle's `authorized_keys`. A device
can hold several keys, so the old one keeps working until you remove it.

**If `tokens.env` is lost**, generate new tokens and update three places
together — they must match or the panel silently stops updating:

```sh
openssl rand -hex 24   # read  -> server .env, and the Kindle's local/env.sh
openssl rand -hex 24   # write -> server .env, and Home Assistant
```

---

## 2. Admin machine

```sh
git clone git@github.com:cookie-monster1649/kindle-office-frame.git
cd kindle-office-frame
# copy secrets/ into place here

brew install imagemagick        # or: apt install imagemagick
cd server && npm install
npm test                        # 52 tests, no configuration needed
OFFLINE=1 npm run preview       # renders all frames to ./out, no network
```

Requirements are only **Node ≥ 20** and **ImageMagick** — `magick` is the one
external binary the server shells out to, for the 16-level dither. There is no
browser to install; Satori and resvg run in-process.

Fonts are auto-detected locally and will usually find Georgia. The container
uses Charis SIL. Metrics are close but not identical, so long text can break
lines differently — set `FONT_REGULAR` and `FONT_BOLD` if you need an exact
match with production.

---

## 3. NUC

```sh
git clone git@github.com:cookie-monster1649/kindle-office-frame.git /opt/stacks/kindleframe
cd /opt/stacks/kindleframe/server
cp .env.example .env
```

Edit `.env`: paste both tokens from `secrets/tokens.env`, and set the location
if it is not Melbourne.

### Pull the prebuilt image (preferred)

CI publishes `linux/amd64` to GHCR on every push to `main`, after the tests and
a smoke test of the image itself. Pulling avoids a five-minute build on the NUC
and guarantees you are running the exact bytes that passed.

**The package is private, because the repo is**, so the NUC has to authenticate
once. This is a one-off — Docker stores the credential and every later `pull`
just works.

**1. Create the token.** On github.com, signed in as `cookie-monster1649`:

> Settings → Developer settings → Personal access tokens → **Tokens (classic)**
> → Generate new token (classic)

- **Note:** something you will recognise later, e.g. `nuc-ghcr-pull`
- **Expiration:** your call. No expiry never has to be rotated but also never
  stops working if it leaks; 90 days is a reasonable middle
- **Scopes:** tick **`read:packages`** and nothing else

Classic tokens, not fine-grained: GHCR still expects those for package pulls.
`read:packages` alone cannot read your code, push images, or change anything —
if this token leaks, it can pull this one private image and that is all.

Copy it when shown. GitHub will not display it again.

**2. Log in on the NUC:**

```sh
export GHCR_TOKEN=ghp_xxxxxxxxxxxxxxxxxxxx
echo "$GHCR_TOKEN" | docker login ghcr.io -u cookie-monster1649 --password-stdin
unset GHCR_TOKEN
```

Passing it on stdin keeps it out of your shell history and out of the process
list, which `docker login -p <token>` would not.

Expect `Login Succeeded`. The credential lands in `~/.docker/config.json`,
**base64-encoded, not encrypted** — so that file is now worth the same as the
token. Log out with `docker logout ghcr.io` if the machine changes hands.

**3. Check it:**

```sh
docker pull ghcr.io/cookie-monster1649/kindle-office-frame:latest
```

The compose file points at the published image and has no `build:` key, so
there is only one thing to run:

```sh
docker compose pull && docker compose up -d
docker compose logs -f          # expect the security warning about /
```

To pin a specific build rather than following `main`, set `IMAGE_TAG` in `.env`
to one of the `sha-<commit>` tags CI publishes:

```sh
IMAGE_TAG=sha-6fdb348de68009877267e2c623e0e3724d276104
```

### Building from source instead

There is no `build:` key on purpose: with both, `up` prefers a stale local
image over the published one, so a deploy could quietly do nothing. Build
explicitly when you want to:

```sh
docker build -t kindleframe:dev .
IMAGE_REPO=kindleframe IMAGE_TAG=dev docker compose up -d
```

Useful offline, or to try a change before pushing it.

The compose file expects an external network named `internal`; create it or
change the name to match your stack. Nothing is published to the host — the
proxy reaches the container over that shared network.

### Reverse proxy

Two rules on the same hostname, because the device and you need different
treatment:

| Path | Who | How |
|---|---|---|
| `/frame.png` | the Kindle | Cloudflare Access application, policy action **Service Auth** |
| everything else | you | Access application, **Allow** your identity |

Cloudflare matches the more specific path first, so the device's service token
unlocks `/frame.png` and nothing else — not the control page, not any write
endpoint.

**The control page at `/` is not authenticated by this service.** It issues a
SameSite cookie for CSRF protection, not identity. Anyone who can reach it can
drive the panel, so the Access rule above is doing real work, not decoration.

**Home Assistant does not go through any of this.** It runs on the same NUC and
talks to the container directly over the Docker network:

```yaml
rest_command:
  frame_status:
    url: "http://kindleframe:8080/status/{{ display }}"
    method: POST
    headers:
      Authorization: !secret frame_write_token
```

---

## 4. Kindle

### If it is the same device

It is already jailbroken and configured. You only need to point it at the new
server and give it the read token:

```sh
ssh -i secrets/kindle_dash_ed25519 root@<kindle-ip>
vi /mnt/us/dashboard/local/env.sh
```

Set:

```sh
export FRAME_URL="https://kindleframe.example/frame.png"
export FRAME_TOKEN="<the READ token>"
# only if behind Cloudflare Access:
export CF_ACCESS_CLIENT_ID="...access"
export CF_ACCESS_CLIENT_SECRET="..."
```

Over TLS the endpoint **must be a hostname, not an IP** — `xh` is built against
rustls, which refuses HTTPS to bare IP addresses. Plain HTTP to an IP is fine
for local testing.

The device never gets the write token. It would be refused anyway — every write
endpoint returns `403` to the read token — but there is no reason for it to be
there.

Reaching the device over SSH is awkward once the dashboard is running: it
suspends between polls and the radio sleeps with it, so it is only reachable
for a few seconds each cycle. Press the power button first, or poll:

```sh
until nc -z <kindle-ip> 22; do sleep 3; done
```

### If it is a new device

The whole device-side setup has to be redone; none of it is in this repo.
Follow §4 of the README, in order:

1. Firmware **≤ 5.16.2.1.1**, jailbroken with LanguageBreak
2. **Universal Hotfix 2.5.0** — without its `sh_integration`, `.sh` files never
   appear in the library and KUAL simply will not show up
3. KUAL and MRPI
4. **USBNetwork**, with `USE_WIFI="true"` and, once you have logged in
   successfully, `USE_WIFI_SSHD_ONLY="true"` in `usbnet/etc/config`
5. **renameotabin**, then verify: only `/usr/bin/otaupd.bck` and `otav3.bck`
   should exist. Do not skip the verification — there is a documented case of
   someone running the blocker, assuming it worked, connecting anyway and
   losing the jailbreak

Then the credentials and files:

```sh
# public key -> the device
cat secrets/kindle_dash_ed25519.pub          # append to usbnet/etc/authorized_keys
mv /mnt/us/usbnet/DISABLED_auto /mnt/us/usbnet/auto   # start usbnet at boot

# generate assets and deploy
./render/make-screens.sh
rsync -avz --exclude=local/state --exclude=local/env.sh \
      kindle/ kindle:/mnt/us/dashboard/
rsync -avz render/screens/ kindle:/mnt/us/dashboard/screens/
cp kindle/tools/Frame.sh /Volumes/Kindle/documents/

# first deploy only: the device's config is not in the repo
scp kindle/local/env.sh.example kindle:/mnt/us/dashboard/local/env.sh
```

`local/env.sh` holds the read token and the Access service token, so it is
gitignored and excluded from the deploy above. That exclusion is load-bearing:
without it every deploy overwrites the device's credentials with the example's
placeholders, and the panel starts failing authentication - a 401 from the app,
or a 403 from Cloudflare Access if the service token is what got wiped.

Then tap **Frame** in the Kindle library.

---

## 5. Checking it worked

```sh
# server is up and rendering
curl -sI -H "Authorization: Bearer $READ" \
  "https://kindleframe.example/frame.png?mode=server&orient=portrait" | head -3

# the read token cannot write   -> expect 403
curl -s -o /dev/null -w '%{http_code}\n' -X POST \
  -H "Authorization: Bearer $READ" https://kindleframe.example/status/out

# the write token can           -> expect 200
curl -s -X POST -H "Authorization: Bearer $WRITE" \
  https://kindleframe.example/status/out
```

On the device, `/mnt/us/dashboard/logs/dash.log` is the thing to read. A
healthy cycle looks like:

```
Frame unchanged (304)
Content unchanged, leaving screen as-is
Suspending, next wakeup in 74s
```

`304` is the normal case and means it is working: unchanged content costs a few
hundred bytes and never touches the screen.

### When it does not work

| Symptom | Usually |
|---|---|
| `HEAD failed after 3 attempts` | Wrong hostname, or Access is refusing the service token |
| `Unexpected status from HEAD: 401` | Read token does not match the server's |
| `Unexpected status from HEAD: 403` | Cloudflare Access, not the app — check the Service Auth policy |
| Panel frozen, log looks fine | Content genuinely unchanged. Check the `updated` stamp on the frame |
| Kindle UI drawing over the frame | `statusbar` restarted; see §4 of the README |
