/**
 * The control page.
 *
 * One HTML file, no build step, no framework. Anything more would be more code
 * to maintain than the service it controls.
 *
 * There is no token field. `GET /` issues an httpOnly SameSite=Strict session
 * cookie and the page's writes ride on that, so the page can simply be opened
 * and used. The consequence is explicit and worth stating: **anyone who can
 * reach this page can drive the panel**, so it must be protected at the proxy.
 * The cookie is there for CSRF protection, not authentication.
 */

export function controlPage({ personName }) {
  return `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1, viewport-fit=cover">
<meta name="theme-color" content="#111">
<title>Frame</title>
<style>
  :root { color-scheme: light dark; --fg:#111; --bg:#fff; --line:#dcdcdc; --muted:#666; --panel:#fafafa; }
  @media (prefers-color-scheme: dark) {
    :root { --fg:#f2f2f2; --bg:#141414; --line:#333; --muted:#999; --panel:#1c1c1c; }
  }
  * { box-sizing: border-box; }
  body {
    margin: 0; background: var(--bg); color: var(--fg);
    font: 17px/1.5 system-ui, -apple-system, "Segoe UI", sans-serif;
    display: flex; justify-content: center; padding: 24px;
  }
  main { width: 100%; max-width: 780px; }
  h1 { font-size: 22px; margin: 0 0 2px; font-weight: 600; }
  .sub { color: var(--muted); font-size: 15px; margin-bottom: 22px; }
  h2 { font-size: 13px; text-transform: uppercase; letter-spacing: .07em;
       color: var(--muted); margin: 0 0 10px; font-weight: 600; }

  .cols { display: grid; gap: 26px; grid-template-columns: 1fr; }
  @media (min-width: 720px) { .cols { grid-template-columns: 1fr 300px; } }

  .buttons { display: grid; gap: 10px; grid-template-columns: 1fr 1fr; }
  button {
    font: inherit; font-weight: 600; color: var(--fg); background: transparent;
    border: 1.5px solid var(--line); border-radius: 12px;
    padding: 16px; cursor: pointer; min-height: 58px;
    display: flex; align-items: center; gap: 10px;
  }
  button:hover:not(:disabled) { border-color: var(--fg); }
  button[aria-pressed="true"] { background: var(--fg); color: var(--bg); border-color: var(--fg); }
  button:disabled { opacity: .5; cursor: default; }
  .dot { width: 9px; height: 9px; border-radius: 50%; background: currentColor; opacity: .3; }
  button[aria-pressed="true"] .dot { opacity: 1; }

  .textrow { display: flex; gap: 8px; margin-top: 10px; }
  input[type=text] {
    flex: 1; font: inherit; padding: 14px; border-radius: 12px;
    border: 1.5px solid var(--line); background: var(--bg); color: var(--fg); min-width: 0;
  }
  input[type=text]:focus { outline: none; border-color: var(--fg); }
  .textrow button { min-height: 0; padding: 0 18px; }

  .toggle {
    display: flex; align-items: center; justify-content: space-between; gap: 14px;
    border: 1.5px solid var(--line); border-radius: 12px; padding: 14px 16px;
    cursor: pointer; user-select: none; margin-top: 22px;
  }
  .toggle .label { font-weight: 600; }
  .toggle .hint { color: var(--muted); font-size: 14px; font-weight: 400; }
  .switch { width: 50px; height: 30px; border-radius: 15px; background: var(--line);
            position: relative; flex: 0 0 auto; transition: background .15s; }
  .switch::after { content:''; position:absolute; top:3px; left:3px; width:24px; height:24px;
                   border-radius:50%; background:#fff; transition: transform .15s; }
  .toggle[aria-checked="true"] .switch { background: var(--fg); }
  .toggle[aria-checked="true"] .switch::after { transform: translateX(20px); }

  /* Both orientations, always. The device decides which it is showing, not
     the server, so a single preview would be a guess. */
  .previews { display: grid; gap: 12px; }
  .preview { border: 1px solid var(--line); border-radius: 12px; padding: 10px; background: var(--panel); }
  .preview img { width: 100%; display: block; border-radius: 5px; background: #fff; }
  /* Landscape frames are stored rotated 90deg, because eips always paints into
     the portrait framebuffer. Un-rotate for a browser, which is not holding the
     device sideways.
     A rotated element keeps its original layout box, so the image's *width*
     has to equal the wrapper's height for it to fill after rotation:
     H = W x 1072/1448, hence width: 74.03%. */
  .wrap { position: relative; width: 100%; aspect-ratio: 1448 / 1072; overflow: hidden;
          border-radius: 5px; background: #fff; }
  .wrap img { position: absolute; top: 50%; left: 50%; width: 74.03%;
              transform: translate(-50%, -50%) rotate(-90deg); border-radius: 0; }
  .preview .cap { color: var(--muted); font-size: 12px; margin-top: 8px;
                  text-transform: uppercase; letter-spacing: .06em; }
  .showing { color: var(--muted); font-size: 13px; margin-bottom: 10px; }

  .msg { margin-top: 16px; font-size: 15px; min-height: 1.4em; color: var(--muted); }
  .msg.err { color: #c0392b; }
  @media (prefers-color-scheme: dark) { .msg.err { color: #ff8a7a; } }
</style>
</head>
<body>
<main>
  <h1>Frame</h1>
  <div class="sub">${personName}'s desk panel</div>

  <div class="cols">
    <section>
      <h2>Status</h2>
      <div class="buttons">
        <button data-display="in"  aria-pressed="false"><span class="dot"></span>In office</button>
        <button data-display="out" aria-pressed="false"><span class="dot"></span>Out of office</button>
      </div>

      <div class="textrow">
        <input id="text" type="text" maxlength="120" placeholder="Custom message…">
        <button id="send">Show</button>
      </div>

      <div class="toggle" id="weekend" role="switch" tabindex="0" aria-checked="true">
        <div>
          <div class="label">Show away on weekends</div>
          <div class="hint">Saturday and Sunday override the selection</div>
        </div>
        <div class="switch"></div>
      </div>

      <div class="msg" id="msg"></div>
    </section>

    <section>
      <h2>On the panel</h2>
      <div class="showing" id="cap">…</div>
      <div class="previews">
        <div class="preview">
          <img id="shot-p" alt="Portrait frame">
          <div class="cap">Portrait</div>
        </div>
        <div class="preview">
          <div class="wrap">
            <img id="shot-l" alt="Landscape frame">
          </div>
          <div class="cap">Landscape</div>
        </div>
      </div>
    </section>
  </div>
</main>

<script>
const $ = (id) => document.getElementById(id);
const buttons = [...document.querySelectorAll('button[data-display]')];
const LABELS = { in: 'In office', out: 'Out of office', text: 'Custom message', weekend: 'Weekend' };

function say(text, isError) {
  const el = $('msg');
  el.textContent = text;
  el.className = 'msg' + (isError ? ' err' : '');
}

function paint(s) {
  buttons.forEach((b) => b.setAttribute('aria-pressed', String(b.dataset.display === s.display)));
  $('weekend').setAttribute('aria-checked', String(s.weekendMode));
  if (document.activeElement !== $('text')) $('text').value = s.customText || '';

  $('cap').textContent = s.autoWeekend
    ? 'Showing ' + LABELS.weekend.toLowerCase() + ' — automatic today'
    : 'Showing ' + (LABELS[s.effective] ?? s.effective).toLowerCase();

  // Both orientations: the device chooses which one it asks for, so showing a
  // single guess would be misleading. Cache-busted on the version counter so
  // the previews follow a change without re-fetching unchanged bytes.
  const bust = '&v=' + s.version;
  $('shot-p').src = '/frame.png?mode=server&orient=portrait' + bust;
  $('shot-l').src = '/frame.png?mode=server&orient=landscape' + bust;
}

async function api(path, options) {
  // No Authorization header: the session cookie set by GET / authorises this.
  const res = await fetch(path, { credentials: 'same-origin', ...options });
  if (res.status === 401 || res.status === 403) throw new Error('Not authorised. Reload the page.');
  if (!res.ok) {
    let detail = 'Server error (' + res.status + ').';
    try { const b = await res.json(); if (b.error) detail = b.error; } catch {}
    throw new Error(detail);
  }
  return res.json();
}

const refresh = async () => { try { paint(await api('/status')); } catch (e) { say(e.message, true); } };

async function send(patch, note) {
  buttons.forEach((b) => (b.disabled = true));
  try {
    paint(await api('/status', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(patch),
    }));
    say(note);
  } catch (err) { say(err.message, true); }
  finally { buttons.forEach((b) => (b.disabled = false)); }
}

buttons.forEach((b) =>
  b.addEventListener('click', () =>
    send({ display: b.dataset.display }, 'Updated. The panel follows on its next poll.')));

const sendText = () => {
  const text = $('text').value.trim();
  if (!text) { say('Type a message first.', true); return; }
  send({ display: 'text', text }, 'Message set.');
};
$('send').addEventListener('click', sendText);
$('text').addEventListener('keydown', (e) => { if (e.key === 'Enter') sendText(); });

const toggle = () => {
  const on = $('weekend').getAttribute('aria-checked') !== 'true';
  send({ weekendMode: on }, on ? 'Weekends will show away.' : 'Weekend override off.');
};
$('weekend').addEventListener('click', toggle);
$('weekend').addEventListener('keydown', (e) => {
  if (e.key === ' ' || e.key === 'Enter') { e.preventDefault(); toggle(); }
});

refresh();
// The panel can change without us - the weekend rule rolls over at midnight,
// and the weather moves - so keep the preview honest.
setInterval(refresh, 60000);
</script>
</body>
</html>`;
}
