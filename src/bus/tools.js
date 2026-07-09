import { z } from 'zod';
import { listBusAgents, registerBusAgent, runBusAgentDaemonOnce } from './agentd.js';
import { listBusSessions, registerBusSession, runBusGatewayOnce } from './gateway.js';
import { readBusInbox, readBusStatus, sendBusMessage } from './service.js';

function ok(payload) {
  return { content: [{ type: 'text', text: JSON.stringify(payload, null, 2) }] };
}

function fail(error) {
  return { content: [{ type: 'text', text: `Error: ${error.message}` }], isError: true };
}

export function getBusToolDefinitions() {
  return [
    {
      name: 'bus_send',
      description: 'Send an append-only markdown message to a local cross-agent channel. Use this for Codex↔Claude↔Gemini handoffs, status updates, and task completion reports.',
      schema: {
        channel: z.string().describe('Free-form channel ID (e.g. ticket:TICKET-42, session:1234, swarm:frontend)'),
        sender: z.string().describe('Sender label (e.g. codex, claude, gemini, deploy-watcher)'),
        message: z.string().describe('Markdown message body'),
        kind: z.string().optional().default('message').describe('Message kind (e.g. message, sync, heartbeat, status, question, decision, handoff, artifact, ack, control, blocked, done)'),
        thread: z.string().optional().describe('Logical thread/correlation label'),
        reply_to: z.number().optional().describe('Message id being replied to'),
        recipient: z.string().optional().describe('Directed recipient reader id, or "*" for broadcast'),
        to_reader: z.string().optional().describe('Deprecated alias for recipient'),
        deadline: z.string().optional().describe('Optional ISO-8601 deadline'),
        expects_reply: z.boolean().optional().describe('Whether the sender expects a reply'),
        metadata_json: z.string().optional().describe('Optional JSON metadata string. Protocol hints may include status, step, files_touched, diff_since_last_ack, ack_decision, ack_message_id, control_command, tests, risk.'),
      },
      handler: async ({ channel, sender, message, kind, thread, reply_to, recipient, to_reader, deadline, expects_reply, metadata_json }) => {
        try {
          return ok(sendBusMessage({
            channel,
            sender,
            message,
            kind,
            thread,
            reply_to,
            recipient: recipient ?? to_reader,
            deadline,
            expects_reply,
            metadata_json,
          }));
        } catch (error) {
          return fail(error);
        }
      },
    },

    {
      name: 'bus_status',
      description: 'Inspect a local bus channel: readers, unread backlog, latest heartbeat/status per participant, and latest control message. Use when diagnosing silent peers or coordination drift.',
      schema: {
        channel: z.string().describe('Channel ID'),
        readers: z.array(z.string()).optional().default([]).describe('Optional reader identities to include even if they have not read or hooked yet'),
      },
      handler: async ({ channel, readers }) => {
        try {
          return ok(readBusStatus({ channel, readers }));
        } catch (error) {
          return fail(error);
        }
      },
    },

    {
      name: 'bus_read',
      description: 'Read new messages for a named reader using a stored per-reader cursor. This is the recommended agent-facing read API: non-blocking by default, optional wait when explicitly requested.',
      schema: {
        channel: z.string().describe('Channel ID'),
        reader: z.string().describe('Stable reader identity (e.g. claude:architect, codex:implementer)'),
        wait: z.boolean().optional().default(false).describe('Wait for new messages before returning'),
        timeout_ms: z.number().optional().default(30000).describe('Maximum wait time when wait=true (max 300000)'),
        limit: z.number().optional().default(50).describe('Maximum number of messages to return'),
        peek: z.boolean().optional().default(false).describe('Inspect messages without advancing the stored cursor'),
      },
      handler: async ({ channel, reader, wait, timeout_ms, limit, peek }) => {
        try {
          return ok(await readBusInbox({ channel, reader, wait, timeout_ms, limit, peek }));
        } catch (error) {
          return fail(error);
        }
      },
    },

    {
      name: 'bus_session_register',
      description: 'Register the current parent agent session as a routable recipient for the local bus gateway.',
      schema: {
        channel: z.string().describe('Workstream channel'),
        reader: z.string().describe('Stable reader identity (e.g. claude:architect, codex:implementer)'),
        agent: z.string().describe('Agent host (claude, codex, gemini, service)'),
        adapter: z.string().optional().default('hook').describe('Delivery adapter. Current safe default is hook; noop is useful for tests.'),
        cwd: z.string().optional().describe('Workspace root for hook pending files'),
        id: z.string().optional().describe('Optional stable session id'),
      },
      handler: async ({ channel, reader, agent, adapter, cwd, id }) => {
        try {
          return ok(registerBusSession({ channel, reader, agent, adapter, cwd, id }));
        } catch (error) {
          return fail(error);
        }
      },
    },

    {
      name: 'bus_sessions',
      description: 'List registered bus sessions known to the local bus gateway.',
      schema: {
        channel: z.string().optional().describe('Optional channel filter'),
        reader: z.string().optional().describe('Optional reader filter'),
      },
      handler: async ({ channel, reader }) => {
        try {
          return ok(listBusSessions({ channel, reader }));
        } catch (error) {
          return fail(error);
        }
      },
    },

    {
      name: 'bus_gateway_once',
      description: 'Run one local bus-gateway delivery pass. This writes pending hook digests for registered sessions without consuming messages.',
      schema: {
        channel: z.string().optional().describe('Optional channel filter'),
        limit: z.number().optional().default(50).describe('Maximum candidate messages per session'),
      },
      handler: async ({ channel, limit }) => {
        try {
          return ok(runBusGatewayOnce({ channel, limit }));
        } catch (error) {
          return fail(error);
        }
      },
    },

    {
      name: 'bus_agent_register',
      description: 'Register a local executable worker that the bus agent daemon may launch for directed tasks.',
      schema: {
        channel: z.string().describe('Workstream channel'),
        reader: z.string().describe('Stable worker identity (e.g. codex:implementer, claude:architect)'),
        agent: z.string().describe('Agent host/command family (codex, claude, gemini, service)'),
        adapter: z.string().optional().default('exec').describe('Current supported runner adapter is exec'),
        cwd: z.string().optional().describe('Working directory for launched worker'),
        command: z.string().optional().describe('Executable command. Defaults to agent name.'),
        args: z.array(z.string()).optional().describe('Command args. Use {prompt} placeholder for the bootstrap prompt.'),
        prompt_template: z.string().optional().describe('Optional bootstrap prompt template'),
        id: z.string().optional().describe('Optional stable agent id'),
      },
      handler: async ({ channel, reader, agent, adapter, cwd, command, args, prompt_template, id }) => {
        try {
          return ok(registerBusAgent({ channel, reader, agent, adapter, cwd, command, args, prompt_template, id }));
        } catch (error) {
          return fail(error);
        }
      },
    },

    {
      name: 'bus_agents',
      description: 'List local executable workers registered for the bus agent daemon.',
      schema: {
        channel: z.string().optional().describe('Optional channel filter'),
        reader: z.string().optional().describe('Optional reader filter'),
      },
      handler: async ({ channel, reader }) => {
        try {
          return ok(listBusAgents({ channel, reader }));
        } catch (error) {
          return fail(error);
        }
      },
    },

    {
      name: 'bus_agentd_once',
      description: 'Run one local agent-daemon pass. This launches registered exec workers for wake-worthy bus tasks.',
      schema: {
        channel: z.string().optional().describe('Optional channel filter'),
        limit: z.number().optional().default(50).describe('Maximum candidate messages per agent'),
        dry_run: z.boolean().optional().default(false).describe('Return candidates without launching workers'),
      },
      handler: async ({ channel, limit, dry_run }) => {
        try {
          return ok(await runBusAgentDaemonOnce({ channel, limit, dry_run }));
        } catch (error) {
          return fail(error);
        }
      },
    },
  ];
}
