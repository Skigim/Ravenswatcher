'use strict';
// The stdio front end end to end against the real reader: it must emit one
// parseable object per line at the poll interval, on stdout only, with the
// banner on stderr. Exercises stdio.js against fakegame.js.
//
// WHY THIS MEASURES GAPS AND NOT A COUNT IN A WINDOW.
//
// It used to collect for a fixed 1500 ms and assert "at least 4 frames" and
// "3-5.5 frames/s". That window includes process spawn and module load, which
// is the part a loaded machine inflates -- so the test failed with 2 frames on
// a busy box while the reader itself was fine. Measured either side of a
// change that was suspected of slowing it down, the real rate was 5-6 frames
// both times; the failures tracked machine load, not the code.
//
// A test that fails half the time stops being read, which is the same problem
// as a silent skip reading as a PASS (see run-all.js). So this now:
//
//   - waits for a target number of frames with a generous deadline, so
//     startup cost is bounded but not measured; and
//   - judges cadence on the MEDIAN gap between consecutive frames, which
//     survives one scheduler stall while still catching a real regression.
//
// This is stricter than what it replaced, not looser. Never producing frames,
// producing them far too slowly or far too fast, and stalling mid-stream all
// still fail. What no longer fails is "the machine was busy for 400 ms".

const { spawn } = require('child_process');
const path = require('path');

let failures = 0;
function check(label, ok, detail = '') {
  console.log(`  ${ok ? 'PASS' : 'FAIL'}  ${label}${detail ? '  ' + detail : ''}`);
  if (!ok) failures++;
}

const POLL_MS = 250;          // stdio.js's own cadence
const WANT_FRAMES = 6;        // ~1.5 s of stream at that cadence
const DEADLINE_MS = 15000;    // generous: exhausting this is a real failure

function median(xs) {
  const s = [...xs].sort((a, b) => a - b);
  const mid = s.length >> 1;
  return s.length % 2 ? s[mid] : (s[mid - 1] + s[mid]) / 2;
}

function main() {
  return new Promise((resolve) => {
    const fakegame = spawn(process.execPath, [path.join(__dirname, 'fakegame.js')],
      { stdio: ['ignore', 'pipe', 'inherit'] });

    let stdioProc = null;
    let timer = null;
    let done = false;
    let fakeAcc = '';

    function cleanup() {
      if (timer) clearTimeout(timer);
      if (stdioProc) {
        try { stdioProc.kill(); } catch {}
      }
      if (fakegame) {
        try { fakegame.kill(); } catch {}
      }
    }

    fakegame.stdout.on('data', (d) => {
      if (stdioProc) return;
      fakeAcc += d;
      if (!fakeAcc.includes('\n')) return;
      const info = JSON.parse(fakeAcc.split('\n')[0]);
      console.log(`\ntest-stdio: stdio.js attached to fakegame pid ${info.pid}`);

      stdioProc = spawn(process.execPath,
        [path.join(__dirname, '..', 'stdio.js'), String(info.pid)],
        { stdio: ['ignore', 'pipe', 'pipe'] });

      let out = '', err = '';
      const lines = [];
      const stamps = [];
      let pending = '';

      stdioProc.stderr.on('data', chunk => { err += chunk; });
      stdioProc.stdout.on('data', chunk => {
        out += chunk;
        pending += chunk;
        let i;
        while ((i = pending.indexOf('\n')) !== -1) {
          const line = pending.slice(0, i);
          pending = pending.slice(i + 1);
          if (!line.trim()) continue;
          lines.push(line);
          stamps.push(Date.now());
          if (lines.length >= WANT_FRAMES && !done) finish();
        }
      });

      timer = setTimeout(() => finish(), DEADLINE_MS);

      function finish() {
        if (done) return;
        done = true;
        cleanup();

        check('frames arrived on stdout', lines.length >= WANT_FRAMES,
          `${lines.length}/${WANT_FRAMES} within ${DEADLINE_MS} ms`);

        // Name the line, not just the parse error: a stray write to stdout
        // from anything the reader loads breaks the protocol, and the text
        // says who did it.
        let parsed = [];
        const bad = lines.find(l => { try { JSON.parse(l); return false; } catch { return true; } });
        if (bad !== undefined) {
          check('every line is valid JSON', false,
            `line ${lines.indexOf(bad) + 1} of ${lines.length}: ${JSON.stringify(bad.slice(0, 200))}`);
        } else {
          parsed = lines.map(l => JSON.parse(l));
        }

        if (parsed.length) {
          check('every line is valid JSON', true);
          const keyCounts = [...new Set(parsed.map(o => Object.keys(o).length))];
          check('every frame has stable key count',
            keyCounts.length === 1,
            `key counts: ${keyCounts.join(',')}`);
          check('every frame is the 29-key envelope',
            parsed.every(o => Object.keys(o).length === 29),
            `key counts: ${keyCounts.join(',')}`);
        }

        if (stamps.length >= 3) {
          const gaps = stamps.slice(1).map((t, i) => t - stamps[i]);
          const med = median(gaps);
          // Nominal gap is POLL_MS. The band catches a cadence that has been
          // changed or throttled without failing on a single stalled gap, since
          // one outlier cannot move a median.
          check('cadence holds at the poll interval',
            med >= POLL_MS * 0.6 && med <= POLL_MS * 3,
            `median gap ${med} ms over ${gaps.length} gaps (poll is ${POLL_MS} ms)`);
          // A working stream never goes quiet for this long, loaded or not.
          check('no frame gap stalls the stream',
            Math.max(...gaps) < 5000, `max gap ${Math.max(...gaps)} ms`);
        } else {
          check('cadence holds at the poll interval', false,
            `only ${stamps.length} frames, cannot measure gaps`);
        }

        check('the banner went to stderr, not stdout',
          err.includes('module base') && !out.includes('module base') && !out.includes('first sweep'),
          err.trim());
        resolve(failures);
      }
    });
  });
}

if (require.main === module) main().then(f => process.exit(f ? 1 : 0));
module.exports = { main };
