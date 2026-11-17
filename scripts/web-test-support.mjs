import { build } from 'esbuild';
import { createRequire } from 'node:module';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { resolve, join } from 'node:path';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { createHash } from 'node:crypto';
import { DatabaseSync } from 'node:sqlite';
const execute = promisify(execFile);
export async function productionHost() {
  const output = resolve('artifacts/web-flutter-runtime/web-test-host.cjs');
  await build({
    entryPoints: ['tests/fixtures/web/host.ts'],
    outfile: output,
    bundle: true,
    platform: 'node',
    format: 'cjs',
    target: 'node20',
  });
  return createRequire(import.meta.url)(output);
}
export async function certificate(root) {
  await mkdir(root, { recursive: true });
  await writeFile(
    join(root, 'ca.conf'),
    '[req]\ndistinguished_name=dn\nx509_extensions=ca\n[dn]\n[ca]\nbasicConstraints=critical,CA:TRUE\nkeyUsage=critical,keyCertSign,cRLSign\n',
  );
  await execute('/usr/bin/openssl', [
    'req',
    '-x509',
    '-newkey',
    'rsa:2048',
    '-nodes',
    '-keyout',
    join(root, 'ca.key'),
    '-out',
    join(root, 'ca.pem'),
    '-days',
    '1',
    '-subj',
    '/CN=Pilot fixture CA',
    '-config',
    join(root, 'ca.conf'),
  ]);
  await execute('/usr/bin/openssl', [
    'req',
    '-newkey',
    'rsa:2048',
    '-nodes',
    '-keyout',
    join(root, 'leaf.key'),
    '-out',
    join(root, 'leaf.csr'),
    '-subj',
    '/CN=localhost',
  ]);
  await writeFile(
    join(root, 'leaf.conf'),
    'basicConstraints=critical,CA:FALSE\nkeyUsage=critical,digitalSignature,keyEncipherment\nextendedKeyUsage=serverAuth\nsubjectAltName=DNS:localhost,IP:127.0.0.1\n',
  );
  await execute('/usr/bin/openssl', [
    'x509',
    '-req',
    '-in',
    join(root, 'leaf.csr'),
    '-CA',
    join(root, 'ca.pem'),
    '-CAkey',
    join(root, 'ca.key'),
    '-CAcreateserial',
    '-out',
    join(root, 'leaf.pem'),
    '-days',
    '1',
    '-extfile',
    join(root, 'leaf.conf'),
  ]);
  return {
    ca: join(root, 'ca.pem'),
    key: await readFile(join(root, 'leaf.key')),
    cert: await readFile(join(root, 'leaf.pem')),
  };
}
/** Chrome's private-profile trust store; does not change system or user trust. */
export async function seedTrust(profile, certificates) {
  await mkdir(join(profile, 'Default'), { recursive: true });
  const db = new DatabaseSync(join(profile, 'Default', 'ServerCertificate'));
  try {
    db.exec(
      "CREATE TABLE meta(key LONGVARCHAR NOT NULL UNIQUE PRIMARY KEY,value LONGVARCHAR); INSERT INTO meta VALUES('version','1'); INSERT INTO meta VALUES('last_compatible_version','1'); CREATE TABLE certificates(sha256hash_hex TEXT PRIMARY KEY,der_cert BLOB NOT NULL,trust_settings BLOB NOT NULL);",
    );
    for (const file of certificates) {
      const { stdout } = await execute('/usr/bin/openssl', ['x509', '-in', file, '-outform', 'DER'], {
        encoding: 'buffer',
      });
      db.prepare('INSERT OR IGNORE INTO certificates VALUES (?,?,?)').run(
        createHash('sha256').update(stdout).digest('hex'),
        stdout,
        Buffer.from('0a020803', 'hex'),
      );
    }
  } finally {
    db.close();
  }
}
export const listen = (server) =>
  new Promise((done, reject) => {
    server.once('error', reject);
    server.listen(0, '127.0.0.1', () => done(server.address().port));
  });
export const closeServer = async (server) => {
  server.closeAllConnections?.();
  await new Promise((done) => server.close(done));
};
export async function until(operation, message, timeout = 10000) {
  const deadline = Date.now() + timeout;
  while (true) {
    const value = await operation();
    if (value) return value;
    if (Date.now() >= deadline) throw new Error(message);
    await new Promise((done) => setTimeout(done, 30));
  }
}
