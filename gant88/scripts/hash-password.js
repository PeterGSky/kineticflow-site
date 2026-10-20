// Prints a bcrypt hash for SEED_PASSWORD_HASH. The password is read from stdin,
// so it doesn't end up in shell history:  npm run hash-password
'use strict';
const bcrypt = require('bcryptjs');

let input = '';
process.stdin.setEncoding('utf8');
if (process.stdin.isTTY) process.stderr.write('Password: ');
process.stdin.on('data', (d) => { input += d; if (process.stdin.isTTY && input.includes('\n')) process.stdin.pause(); });
process.stdin.on('pause', done);
process.stdin.on('end', done);

let finished = false;
function done() {
  if (finished) return;
  finished = true;
  const pw = input.replace(/\r?\n$/, '');
  if (pw.length < 10) { console.error('Use at least 10 characters.'); process.exit(1); }
  console.log(bcrypt.hashSync(pw, 12));
}
