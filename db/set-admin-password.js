#!/usr/bin/env node
/**
 * Creates an admin sign-in, or changes an existing one's password.
 *
 * It prints the SQL to run. Nothing here touches a database, so you can read
 * what it produces before anything is written.
 *
 *   node db/set-admin-password.js stuart
 *   node db/set-admin-password.js stuart --name "Stuart Shaw"
 *
 * The password is typed at a prompt rather than passed as an argument, so it
 * does not end up in your shell history. Then run what it prints:
 *
 *   npx wrangler d1 execute shaws-carpentry --remote --command "<the SQL>"
 *
 * Changing a password signs out every session that account had open, because
 * the session cookie is signed with a key derived from the stored hash.
 *
 * --iterations lowers or raises the PBKDF2 work factor. The default suits a
 * paid Cloudflare plan. On the free plan a Worker gets about 10ms of CPU per
 * request, and if signing in fails with a CPU limit error, set an account up
 * again with --iterations 10000.
 */

const crypto = require('node:crypto');
const fs = require('node:fs');
const path = require('node:path');
const readline = require('node:readline');

const DEFAULT_ITERATIONS = 100000;
const KEY_LENGTH_BYTES = 32;

function parseArgs(argv) {
  const args = { username: null, name: '', iterations: DEFAULT_ITERATIONS };
  const rest = [];

  for (let i = 0; i < argv.length; i++) {
    if (argv[i] === '--name') args.name = argv[++i] || '';
    else if (argv[i] === '--iterations') args.iterations = Number(argv[++i]);
    else rest.push(argv[i]);
  }

  args.username = (rest[0] || '').trim().toLowerCase();
  return args;
}

function readAllStdin() {
  return new Promise((resolve) => {
    let data = '';
    process.stdin.setEncoding('utf8');
    process.stdin.on('data', (chunk) => {
      data += chunk;
    });
    process.stdin.on('end', () => resolve(data));
  });
}

/**
 * Asks the two questions.
 *
 * At a terminal it hides what is typed. Piped in, it reads the lines it was
 * given: readline's own prompt never fires once stdin has ended, which leaves
 * the script sitting there having asked and heard nothing.
 */
async function createPrompt() {
  if (!process.stdin.isTTY) {
    const lines = (await readAllStdin()).split(/\r?\n/);
    let next = 0;
    return {
      async ask(question) {
        process.stdout.write(question + '\n');
        return lines[next++] || '';
      },
      close() {},
    };
  }

  const rl = readline.createInterface({ input: process.stdin, output: process.stdout });

  let muted = false;
  rl._writeToOutput = function (chunk) {
    if (!muted) rl.output.write(chunk);
  };

  return {
    ask(question) {
      process.stdout.write(question);
      muted = true;
      return new Promise((resolve) => {
        rl.question('', (answer) => {
          muted = false;
          process.stdout.write('\n');
          resolve(answer);
        });
      });
    },
    close() {
      rl.close();
    },
  };
}

function quote(value) {
  return `'${String(value).replace(/'/g, "''")}'`;
}

async function main() {
  const args = parseArgs(process.argv.slice(2));

  if (!args.username) {
    console.error('Usage: node db/set-admin-password.js <username> [--name "Their Name"] [--iterations N]');
    process.exit(1);
  }
  if (!/^[a-z0-9._-]{3,60}$/.test(args.username)) {
    console.error('The username should be 3 to 60 characters: letters, numbers, dot, dash or underscore.');
    process.exit(1);
  }
  if (!Number.isInteger(args.iterations) || args.iterations < 1000 || args.iterations > 2000000) {
    console.error('--iterations should be a whole number between 1000 and 2000000.');
    process.exit(1);
  }

  const prompt = await createPrompt();
  const password = await prompt.ask('New password: ');
  const again = await prompt.ask('Type it again: ');
  prompt.close();

  if (password !== again) {
    console.error('Those did not match. Nothing has been changed.');
    process.exit(1);
  }
  if (password.length < 12) {
    console.error('Use at least 12 characters. Three or four unrelated words works well and is easy to type on a phone.');
    process.exit(1);
  }

  const salt = crypto.randomBytes(16);
  const hash = crypto.pbkdf2Sync(password, salt, args.iterations, KEY_LENGTH_BYTES, 'sha256');
  const stored = [
    'pbkdf2',
    'sha256',
    args.iterations,
    salt.toString('base64url'),
    hash.toString('base64url'),
  ].join('$');

  const sql =
    `-- Sign-in for ${args.username}, generated ${new Date().toISOString()}.\n` +
    `-- Delete this file once it has been applied.\n` +
    `INSERT INTO admin_users (username, password_hash, display_name)\n` +
    `VALUES (${quote(args.username)}, ${quote(stored)}, ${quote(args.name)})\n` +
    `ON CONFLICT(username) DO UPDATE SET\n` +
    `  password_hash = excluded.password_hash,\n` +
    `  display_name = excluded.display_name,\n` +
    `  updated_at = datetime('now');\n`;

  // Written to a file rather than printed as a one-liner: the hash contains
  // `$` characters, which both bash and PowerShell would try to expand out of
  // a pasted command, and the statement would then be applied wrong.
  const outputPath = path.join(__dirname, 'admin-password.sql');
  fs.writeFileSync(outputPath, sql, { mode: 0o600 });

  console.log(`\nWritten to db/admin-password.sql. Apply it with:\n`);
  console.log(`npx wrangler d1 execute shaws-carpentry --remote --file=db/admin-password.sql`);
  console.log(`\nOr against your local database, for testing:\n`);
  console.log(`npx wrangler d1 execute shaws-carpentry --local --file=db/admin-password.sql`);
  console.log(`\nThen delete db/admin-password.sql. It is git-ignored, so it will not`);
  console.log(`be committed, but there is no reason to keep it lying about.\n`);
}

main();
