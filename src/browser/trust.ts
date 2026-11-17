import { X509Certificate, createHash } from 'node:crypto';
import { mkdir } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { BrowserError } from './protocol';

/** Explicit trust applies only to this disposable managed Chromium Profile. */
export async function trustedProfile(certificates: string[]) {
  if (process.platform !== 'darwin')
    throw new BrowserError(
      'TARGET_UNSUPPORTED',
      'Private Chromium certificate trust is currently verified on macOS only.',
    );
  const parsed = certificates.map((pem) => new X509Certificate(pem));
  if (parsed.some((cert) => !cert.ca))
    throw new BrowserError('INVALID_ARGUMENTS', 'Only explicit CA certificates may be trusted.');
  const profile = join(tmpdir(), 'trusted-profile');
  await mkdir(join(profile, 'Default'), { recursive: true, mode: 0o700 });
  const sql =
    "CREATE TABLE meta(key LONGVARCHAR NOT NULL UNIQUE PRIMARY KEY,value LONGVARCHAR); INSERT INTO meta VALUES('version','1'); INSERT INTO meta VALUES('last_compatible_version','1'); CREATE TABLE certificates(sha256hash_hex TEXT PRIMARY KEY,der_cert BLOB NOT NULL,trust_settings BLOB NOT NULL);" +
    parsed
      .map(
        (cert) =>
          `INSERT OR IGNORE INTO certificates VALUES('${createHash('sha256').update(cert.raw).digest('hex')}',X'${cert.raw.toString('hex')}',X'0a020803');`,
      )
      .join('');
  await promisify(execFile)('/usr/bin/sqlite3', [
    '-batch',
    '-bail',
    join(profile, 'Default', 'ServerCertificate'),
    sql,
  ]);
  return { profile, fingerprints: parsed.map((c) => c.fingerprint256) };
}
