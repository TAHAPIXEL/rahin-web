const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const { execSync } = require('child_process');

async function main() {
  let srcDir = process.cwd();

  // If api/ and index.html are not in cwd (single-file deployment), download RAHIN_BUNDLE_URL
  if (!fs.existsSync(path.join(srcDir, 'index.html')) || !fs.existsSync(path.join(srcDir, 'api'))) {
    const bundleUrl = process.env.RAHIN_BUNDLE_URL;
    const expectedSha = process.env.RAHIN_BUNDLE_SHA;
    if (!bundleUrl) {
      throw new Error('RAHIN_BUNDLE_URL is not set and source files are not in cwd');
    }
    console.log('[rahin-build] Downloading bundle from', bundleUrl);
    const res = await fetch(bundleUrl);
    if (!res.ok) {
      throw new Error(`Failed to download bundle: HTTP ${res.status}`);
    }
    const buf = Buffer.from(await res.arrayBuffer());
    const sha = crypto.createHash('sha256').update(buf).digest('hex');
    if (expectedSha && sha !== expectedSha) {
      console.error(`FAILED sha mismatch: got ${sha}, expected ${expectedSha}`);
      process.exit(1);
    }
    console.log(`bundle ok ${buf.length} sha ${sha}`);
    const tarPath = '/tmp/rahin-bundle.tar.gz';
    srcDir = '/tmp/rahin-app';
    fs.rmSync(srcDir, { recursive: true, force: true });
    fs.mkdirSync(srcDir, { recursive: true });
    fs.writeFileSync(tarPath, buf);
    execSync(`tar -xzf ${tarPath} -C ${srcDir}`);
  }

  const outDir = path.join(process.cwd(), '.vercel', 'output');
  const staticDir = path.join(outDir, 'static');
  const funcsBaseDir = path.join(outDir, 'functions', 'api');

  fs.rmSync(outDir, { recursive: true, force: true });
  fs.mkdirSync(staticDir, { recursive: true });
  fs.mkdirSync(funcsBaseDir, { recursive: true });

  // 1. Copy static assets into .vercel/output/static
  const staticItems = ['css', 'fonts', 'icons', 'index.html', 'js', 'manifest.webmanifest', 'sw.js', 'vendor'];
  const copiedStatic = [];
  for (const item of staticItems) {
    const srcPath = path.join(srcDir, item);
    if (fs.existsSync(srcPath)) {
      fs.cpSync(srcPath, path.join(staticDir, item), { recursive: true });
      copiedStatic.push(item);
    }
  }
  console.log('static:', copiedStatic.join(' '));

  // 2. Build serverless functions in .vercel/output/functions/api/<name>.func
  const apiDir = path.join(srcDir, 'api');
  const handlers = fs
    .readdirSync(apiDir)
    .filter((f) => f.endsWith('.js'))
    .sort();
  console.log('handlers:', handlers.join(' '));

  const builtFuncs = [];
  for (const file of handlers) {
    const name = path.basename(file, '.js');
    const funcDir = path.join(funcsBaseDir, `${name}.func`);
    fs.mkdirSync(funcDir, { recursive: true });

    // Copy standalone handler as index.js
    fs.copyFileSync(path.join(apiDir, file), path.join(funcDir, 'index.js'));

    // Also copy _lib if present
    const libDir = path.join(apiDir, '_lib');
    if (fs.existsSync(libDir)) {
      fs.cpSync(libDir, path.join(funcDir, '_lib'), { recursive: true });
    }

    // Write package.json to enforce CommonJS
    fs.writeFileSync(
      path.join(funcDir, 'package.json'),
      JSON.stringify({ name: `rahin-fn-${name}`, private: true, type: 'commonjs' }, null, 2)
    );

    // Write .vc-config.json
    fs.writeFileSync(
      path.join(funcDir, '.vc-config.json'),
      JSON.stringify(
        {
          runtime: 'nodejs22.x',
          handler: 'index.js',
          launcherType: 'Nodejs',
          maxDuration: 15,
          shouldAddHelpers: true,
        },
        null,
        2
      )
    );

    builtFuncs.push(`${name}.func`);
  }
  console.log('functions:', builtFuncs.join(' '));

  // 3. Write .vercel/output/config.json (Build Output API v3)
  const routeNames = handlers.map((f) => path.basename(f, '.js')).join('|');
  const config = {
    version: 3,
    routes: [
      {
        src: '^/api/(.*)$',
        headers: {
          'Access-Control-Allow-Origin': '*',
          'Access-Control-Allow-Methods': 'GET, POST, PUT, PATCH, DELETE, OPTIONS',
          'Access-Control-Allow-Headers': 'Content-Type, Authorization',
        },
        continue: true,
      },
      {
        src: `^/api/(${routeNames})/?$`,
        dest: '/api/$1',
      },
      {
        handle: 'filesystem',
      },
      {
        src: '/(.*)',
        dest: '/index.html',
      },
    ],
  };
  fs.writeFileSync(path.join(outDir, 'config.json'), JSON.stringify(config, null, 2));
  console.log('[rahin-build] Build Output API v3 generated successfully');
}

main().catch((err) => {
  console.error('BUILD FAILED:', err);
  process.exit(1);
});
