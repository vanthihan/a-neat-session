'use strict';

const USAGE = [
  'usage: a-neat-session [--global | --local] [--uninstall] [--force]',
  '',
  '  --global     install for all projects into $CLAUDE_CONFIG_DIR (default ~/.claude)',
  '  --local      install for this project into ./.claude',
  '  --uninstall  remove the files and settings entries a-neat-session installed',
  '  --force      overwrite files you edited or that a-neat-session does not own',
  '               (the previous file is saved as <file>.neat-old)',
  '  -h, --help   show this help',
  '',
  'examples:',
  '  npx a-neat-session --global',
  '  npx a-neat-session --local',
  '',
].join('\n');

const MAX_PROMPTS = 3;

class InstallerUsageError extends Error {}

function parseInstallerArgs(argv) {
  const opts = { scope: null, uninstall: false, force: false, help: false };
  for (const arg of argv) {
    if (arg === '--global' || arg === '--local') {
      const scope = arg.slice(2);
      if (opts.scope && opts.scope !== scope) {
        throw new InstallerUsageError('choose one of --global or --local');
      }
      opts.scope = scope;
    } else if (arg === '--uninstall') {
      opts.uninstall = true;
    } else if (arg === '--force') {
      opts.force = true;
    } else if (arg === '--help' || arg === '-h') {
      opts.help = true;
    } else {
      throw new InstallerUsageError(`unknown option ${arg}`);
    }
  }
  return opts;
}

// Ask which scope to use. `ask(question)` returns a promise of the answer line.
async function chooseScope({ isTTY, ask, globalTarget, localTarget }) {
  if (!isTTY) {
    throw new InstallerUsageError('no terminal to ask on; re-run with --global or --local');
  }
  const question = `Install for (1) all projects [${globalTarget}] or (2) this project [${localTarget}]? `;
  for (let i = 0; i < MAX_PROMPTS; i += 1) {
    const answer = String((await ask(question)) ?? '').trim();
    if (answer === '1') return 'global';
    if (answer === '2') return 'local';
  }
  throw new InstallerUsageError('no valid choice; re-run with --global or --local');
}

module.exports = { parseInstallerArgs, chooseScope, USAGE, InstallerUsageError };
