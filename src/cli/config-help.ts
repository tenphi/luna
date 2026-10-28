/**
 * Curated help for the unified `luna config <topic>` command family.
 */
import { getResource } from './crud.js';
import { register } from './registry.js';

const INSTALL_TOPICS = ['users', 'memory', 'apple', 'email', 'host-mcp', 'mcp-tools'] as const;

/** Skip shorthand aliases when an explicit `topic get` verb exists. */
function dedupeConfigVerbs(customOperations: Record<string, { access: string; description: string }>): string[] {
  const verbs: string[] = [];
  for (const [verb, op] of Object.entries(customOperations)) {
    if (!verb.includes(' ') && customOperations[`${verb} get`]) continue;
    verbs.push(`${verb} [${op.access}] — ${op.description}`);
  }
  return verbs;
}

function topicHelpLines(topic: string): string {
  const res = getResource('config');
  const op = res?.customOperations?.[topic] ?? res?.customOperations?.[`${topic} get`];
  const lines = [`config ${topic}: ${op?.description ?? 'Install-wide config topic.'}`, ''];
  if (res?.customOperations) {
    const related = Object.entries(res.customOperations).filter(
      ([verb]) => verb === topic || verb.startsWith(`${topic} `),
    );
    const verbs = dedupeConfigVerbs(Object.fromEntries(related));
    lines.push('Verbs:');
    for (const v of verbs) lines.push(`  ${v}`);
  }
  lines.push('');
  lines.push(`Examples:`);
  lines.push(`  luna config ${topic}`);
  lines.push(`  luna config ${topic} set …`);
  return lines.join('\n');
}

export function registerConfigHelpCommands(): void {
  register({
    name: 'config-help',
    description: 'Show unified config topics and verbs.',
    access: 'hidden',
    parseArgs: () => ({}),
    handler: async () => {
      const res = getResource('config');
      const lines = ['config: Install-wide and agent Luna configuration.', '', 'Topics:'];
      lines.push('  agent — agent container config (model, MCP, packages)');
      for (const topic of INSTALL_TOPICS) {
        const op = res?.customOperations?.[topic];
        if (op) lines.push(`  ${topic} — ${op.description}`);
      }
      lines.push('');
      lines.push('Run `luna config <topic> help` for topic-specific verbs.');
      if (res?.customOperations) {
        lines.push('');
        lines.push('Install-wide verbs:');
        for (const v of dedupeConfigVerbs(res.customOperations)) {
          lines.push(`  ${v}`);
        }
      }
      return lines.join('\n');
    },
  });

  for (const topic of INSTALL_TOPICS) {
    register({
      name: `config-${topic}-help`,
      description: `Show help for config ${topic}.`,
      access: 'hidden',
      resource: 'config',
      parseArgs: () => ({}),
      handler: async () => topicHelpLines(topic),
    });
  }
}
