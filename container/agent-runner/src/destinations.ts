import { getSessionClient } from './session/client.js';
export type DestinationEntry = {
  name: string;
  displayName: string;
  type: 'channel' | 'agent';
  channelType?: string;
  platformId?: string;
  agentGroupId?: string;
};
export async function getAllDestinations(): Promise<DestinationEntry[]> {
  return (await getSessionClient().getDestinations()).map((row) => ({
    type: row.type,
    name: row.name,
    displayName: row.display_name ?? row.name,
    channelType: row.channel_type ?? undefined,
    platformId: row.platform_id ?? undefined,
    agentGroupId: row.agent_group_id ?? undefined,
  }));
}
export async function findByName(name: string): Promise<DestinationEntry | undefined> {
  return (await getAllDestinations()).find((destination) => destination.name === name);
}
export function makeRoutingResolver(snapshot: DestinationEntry[]) {
  return (channel: string | null, address: string | null): DestinationEntry | undefined => {
    if (!channel || !address) return;
    return snapshot.find((destination) =>
      channel === 'agent'
        ? destination.type === 'agent' && destination.agentGroupId === address
        : destination.type === 'channel' && destination.channelType === channel && destination.platformId === address,
    );
  };
}
export async function resolveReplyDestination(origin: {
  channelType: string | null;
  platformId: string | null;
}): Promise<DestinationEntry | undefined> {
  const snapshot = await getAllDestinations();
  return (
    makeRoutingResolver(snapshot)(origin.channelType, origin.platformId) ??
    (snapshot.length === 1 ? snapshot[0] : undefined)
  );
}
export async function buildSystemPromptAddendum(assistantName?: string): Promise<string> {
  const destinations = await getAllDestinations();
  const sections = assistantName ? [`# Session identity\nYour name is **${assistantName}**.`] : [];
  const description = destinations.map((destination) => `- \`${destination.name}\`: ${destination.displayName}`);
  sections.push(
    [
      '## Connected destinations',
      ...(description.length ? description : ['No destinations are connected.']),
      'Reply to the incoming message’s `from` destination unless the user requests another connected destination.',
      ...(destinations.some((destination) => destination.channelType === 'telegram')
        ? ['Use GitHub-flavored Markdown for Telegram. HTML and MarkdownV2 escaping are unnecessary.']
        : []),
    ].join('\n'),
  );
  return sections.join('\n\n');
}
