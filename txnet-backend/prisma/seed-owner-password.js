// The platform owner's first password (hosting R13, OPS-1-o-x). Every release
// seeds after its migrations, and a Job's output reaches Loki, so on a release
// the password is the sealed file PLATFORM_OWNER_PASSWORD_FILE names and is
// never printed. With no file, as on the dev host, one is made and shown once.
const { readFileSync } = require('fs');

/** `{ password, printable }`: the file's password, or `generate()`'s to show once. */
function ownerPassword(env, generate) {
  const file = env.PLATFORM_OWNER_PASSWORD_FILE;
  if (!file) return { password: generate(), printable: true };
  const password = readFileSync(file, 'utf8').trim();
  if (!password) throw new Error(`${file} is empty: seal the owner's password before a release seeds`);
  return { password, printable: false };
}

module.exports = { ownerPassword };
