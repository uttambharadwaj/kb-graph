import { z } from 'zod';
import { listBusAgents, registerBusAgent, runBusAgentDaemonOnce } from './agentd.js';
import { listBusDeliveries, listBusSessions, registerBusSession } from './sessions.js';
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
      description: 'Send a message to an agent running in a DIFFERENT tool or terminal — a Codex session, a Gemini session, another window — over a shared channel. Reach for this the moment work spans two harnesses and your own has no way to see the other agent: handing a task over, reporting a step done, asking a question that blocks you, announcing a decision that changes what a peer is building. Inside one harness, use that harness\'s own messaging; this bus exists for the boundary it cannot cross. Messages are append-only and persist, so a peer that starts later still receives them.',
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
      description: 'Inspect a channel as a whole: who reads it, how much backlog each reader carries, the latest heartbeat or status from each participant, and the latest control message. Reach for this when a peer in another tool has gone quiet and you need to tell "has not read it yet" from "read it and did not answer" — the two call for different next steps, and guessing wrong means either nagging a working peer or waiting on a dead one.',
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
      description: 'Collect your own mail on a cross-tool channel, from a stored per-reader cursor so you never re-read what you have already seen. Reach for this whenever you are one of several agents on a shared channel: when you pick the work back up, after finishing a step, and before starting anything a peer in another harness may already be doing. This is the agent-facing read API — prefer it over bus_status for your own messages. Non-blocking by default; pass wait only when you are deliberately parked on a peer\'s reply.',
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
      description: 'Register a session as a routable recipient, so handoffs on this channel are delivered into it. Reach for this when bus_sessions does not list you on a channel you are meant to be working: an unregistered session sends mail perfectly well and silently receives none, which reads from the inside as a channel where nobody is talking. Hook-wired sessions register themselves; this is for a workspace whose hooks are not wired yet.',
      schema: {
        channel: z.string().describe('Workstream channel'),
        reader: z.string().describe('Stable reader identity (e.g. claude:architect, codex:implementer)'),
        agent: z.string().describe('Agent host (claude, codex, gemini, service)'),
        adapter: z.string().optional().default('hook').describe('Delivery adapter. Current safe default is hook; noop is useful for tests.'),
        // No default: this server's cwd is its own install directory, never the caller's workspace.
        cwd: z.string().describe('Absolute workspace root of the session being registered'),
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
      description: 'List the sessions registered as recipients, with the workspace and delivery adapter each hooks through. Reach for this before sending directed mail, to learn who is actually reachable on a channel and in which working directory — a message to an unregistered reader is stored and readable, but nothing pushes it into a session, so it waits until that reader thinks to pull.',
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
      name: 'bus_deliveries',
      description: 'Show which message reached which session, and when. Reach for this when a peer says it never saw your handoff, or before you conclude that silence means the message was ignored — an undelivered message is a wiring problem and an unanswered one is not, and only this distinguishes them.',
      schema: {
        channel: z.string().optional().describe('Optional channel filter'),
        session_id: z.string().optional().describe('Optional session filter'),
      },
      handler: async ({ channel, session_id }) => {
        try {
          return ok(listBusDeliveries({ channel, session_id }));
        } catch (error) {
          return fail(error);
        }
      },
    },

    {
      name: 'bus_agent_register',
      description: 'Register a local executable the bus daemon may launch to service directed tasks on a channel. Reach for this when work should be picked up while no session is open to receive it — an unattended worker, as opposed to a peer you are in conversation with. A registered session receives mail; a registered agent gets started by it.',
      schema: {
        channel: z.string().describe('Workstream channel'),
        reader: z.string().describe('Stable worker identity (e.g. codex:implementer, claude:architect)'),
        agent: z.string().describe('Agent host/command family (codex, claude, gemini, service)'),
        adapter: z.string().optional().default('exec').describe('Current supported runner adapter is exec'),
        // No default: this server's cwd is its own install directory, never the worker's workspace.
        cwd: z.string().describe('Absolute working directory for the launched worker'),
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
      description: 'List the executable workers registered for the bus daemon, per channel. Reach for this before registering another one, to see whether a channel already has a worker that would race yours for the same task.',
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
      description: 'Run a single daemon pass, launching registered workers for the tasks waiting on a channel. Reach for this to drain a queue on demand rather than wait for the scheduled pass, or with dry_run to see which messages count as wake-worthy and which worker each would start. dry_run launches nothing; without it, this starts real processes.',
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
