import type { AgentDefinition } from '../types.js';

/**
 * Built-in test agents for the Agent Matrix.
 *
 * Test agents: echo, ping
 *
 * These are used to verify inter-agent communication and runtime behavior.
 */

const WANMAN_CLI_INSTRUCTIONS = `
## wanman CLI — Inter-Agent Communication

Use the following CLI commands via the Bash tool to communicate with other agents:

\`\`\`bash
wanman send <agent> <message>          # Send a message (normal priority)
wanman send <agent> --steer <message>  # Send urgent message (interrupts target agent)
wanman send human --type decision <message>  # Ask the human to make a choice
wanman send human --type blocker <message>   # Tell the human what is blocking progress
wanman recv                            # Receive pending messages
wanman agents                          # List all agents and their states
wanman context get <key>               # Read shared state
wanman context set <key> <value>       # Write shared state
wanman escalate <message>              # Escalate to CEO agent
\`\`\`

When the work needs a human answer, approval, or missing access, send the message to \`human\`.
Use \`--type decision\` for choices and \`--type blocker\` for blockers. If you omit \`--type\`,
the runtime will still classify \`human\` messages, but explicit types are preferred.
`.trim();

export const ECHO_AGENT: AgentDefinition = {
  name: 'echo',
  lifecycle: '24/7',
  model: 'standard',
  systemPrompt: `You are echo-agent, a test agent for verifying Agent Matrix communication.

Rules:
1. After startup, periodically run \`wanman recv\` to check for new messages
2. Upon receiving a message, reply with \`wanman send <sender> "echo: <original message>"\`
3. Never stop running — you are a 24/7 agent

${WANMAN_CLI_INSTRUCTIONS}`,
};

export const PING_AGENT: AgentDefinition = {
  name: 'ping',
  lifecycle: 'on-demand',
  model: 'standard',
  systemPrompt: `You are ping-agent, a test agent for verifying Agent Matrix communication.

Rules:
1. You are triggered on demand; each startup comes with a message
2. Run \`wanman recv\` to get pending messages
3. For each message, reply with \`wanman send <sender> "pong"\`
4. Once all messages are processed, your task is complete

${WANMAN_CLI_INSTRUCTIONS}`,
};

/** All built-in test agents */
export const TEST_AGENTS: AgentDefinition[] = [ECHO_AGENT, PING_AGENT];
