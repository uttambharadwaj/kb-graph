import { parseRegisterArgs, registerAgents } from './mcp-register.js';

export function register(args = []) {
  const agents = parseRegisterArgs(args);
  const results = registerAgents(agents, undefined, { force: args.includes('--force') });
  const written = results.filter(result => result.written);
  const refused = results.filter(result => !result.written);

  if (written.length > 0) {
    console.log('MCP server registered for:');
    for (const result of written) console.log(`- ${result.agent}: ${result.path}`);
    console.log('');
  }

  // Non-zero so a setup script stops here instead of carrying on believing it
  // is pointed at a knowledge base it is not pointed at.
  if (refused.length > 0) {
    console.error('Refusing to move an existing registration:');
    for (const result of refused) {
      console.error(`- ${result.agent}: ${result.path}`);
      console.error(`    now: ${result.from}`);
      console.error(`    new: ${result.to}`);
    }
    console.error('');
    console.error('Register from the checkout that owns the config, or pass --force to move it.');
    process.exitCode = 1;
    if (written.length === 0) return;
  }

  console.log('Restart these local agent sessions to activate the updated knowledge-base tools.');
  console.log('Core tools: kb_search, kb_list, kb_read, kb_ingest, ...');
  console.log('Local-only bus tools: bus_send, bus_read');
  console.log('Long-lived sessions that cannot restart can still use the CLI fallback: bus-bind / bus-send / bus-read / bus-hook / bus-hook-current');
}
