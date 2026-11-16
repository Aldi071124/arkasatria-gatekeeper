// Fetch the official gatekeeper circuit files at install time, if missing.
// The two circuit binaries (wasm + zkey) are too large to push through the
// GitHub connector, so they are NOT committed: Railway runs `npm install`,
// which runs this postinstall script and downloads them from the official
// zkVerify Agent Games site. Sizes are verified after download; a mismatch
// or failed download fails the install loudly instead of deploying a server
// that cannot prove anything.
const fs = require('fs');
const path = require('path');
const https = require('https');

const CIRCUITS_DIR = process.env.GATEKEEPER_CIRCUITS_DIR
  || path.join(__dirname, '..', 'circuits');

const FILES = [
  {
    name: 'gatekeeper.wasm',
    url: 'https://agentgames.zkverify.io/circuits/gatekeeper.wasm',
    size: 1755820,
  },
  {
    name: 'gatekeeper_final.zkey',
    url: 'https://agentgames.zkverify.io/circuits/gatekeeper_final.zkey',
    size: 309750,
  },
];

function download(url, dest) {
  return new Promise((resolve, reject) => {
    const file = fs.createWriteStream(dest);
    https.get(url, (res) => {
      if (res.statusCode >= 300 && res.statusCode < 400 && res.headers.location) {
        file.close();
        fs.unlinkSync(dest);
        return download(res.headers.location, dest).then(resolve, reject);
      }
      if (res.statusCode !== 200) {
        file.close();
        fs.unlinkSync(dest);
        return reject(new Error(`HTTP ${res.statusCode} for ${url}`));
      }
      res.pipe(file);
      file.on('finish', () => file.close(resolve));
    }).on('error', (err) => {
      try { fs.unlinkSync(dest); } catch {}
      reject(err);
    });
  });
}

(async () => {
  fs.mkdirSync(CIRCUITS_DIR, { recursive: true });
  for (const f of FILES) {
    const dest = path.join(CIRCUITS_DIR, f.name);
    let ok = false;
    try {
      ok = fs.statSync(dest).size === f.size;
    } catch {}
    if (ok) {
      console.log(`circuits: ${f.name} already present (${f.size} bytes)`);
      continue;
    }
    console.log(`circuits: downloading ${f.name} ...`);
    await download(f.url, dest);
    const got = fs.statSync(dest).size;
    if (got !== f.size) {
      fs.unlinkSync(dest);
      throw new Error(
        `circuits: ${f.name} size mismatch (expected ${f.size}, got ${got})`
      );
    }
    console.log(`circuits: ${f.name} ok (${got} bytes)`);
  }
})().catch((err) => {
  console.error(err.message);
  process.exit(1);
});
