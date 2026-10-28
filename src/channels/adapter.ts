/** Messaging addresses come from adapters and are validated by the host router. */
export type DeliveryAddress = { channelType: string; platformId: string; threadId: string | null };
type MessageIdentity = {
  id: string;
  kind: 'chat' | 'chat-sdk';
  timestamp: string;
  /** Adapter-confirmed mention or direct message; never inferred from the assistant's display name. */
  isMention?: boolean;
  isGroup?: boolean;
};
export type InboundMessage = MessageIdentity & { content: unknown };
export type InboundEvent = DeliveryAddress & {
  message: MessageIdentity & { content: string };
  /** Protected CLI transport may redirect replies; agent tools cannot set this. */
  replyTo?: DeliveryAddress;
  ephemeral?: boolean;
};
export type OutboundFile = { data: Buffer; filename: string };
export type OutboundMessage = {
  content: unknown;
  kind: string;
  /** Queue identity lets a transport resume a partially accepted send. */
  id?: string;
  files?: OutboundFile[];
};
export type ConversationInfo = { name: string; isGroup: boolean; platformId: string };
export type ChannelSetup = {
  onAction(questionId: string, selectedOption: string, userId: string): void;
  onMetadata(platformId: string, name?: string, isGroup?: boolean): void;
  onInbound(platformId: string, threadId: string | null, message: InboundMessage): void | Promise<void>;
  onInboundEvent(event: InboundEvent): void | Promise<void>;
};
export type ChannelAdapter = {
  name: string;
  channelType: string;
  /** Threaded group conversations get separate sessions; Telegram uses the chat itself. */
  supportsThreads: boolean;
  isConnected(): boolean;
  setup(config: ChannelSetup): Promise<void>;
  teardown(): Promise<void>;
  deliver(platformId: string, threadId: string | null, message: OutboundMessage): Promise<string | undefined>;
  setTyping?(platformId: string, threadId: string | null): Promise<void>;
  syncConversations?(): Promise<ConversationInfo[]>;
  resolveChannelName?(platformId: string): Promise<string | null>;
  subscribe?(platformId: string, threadId: string): Promise<void>;
  openDM?(userHandle: string): Promise<string>;
};
export type ChannelAdapterFactory = () => ChannelAdapter | Promise<ChannelAdapter> | null;
export type ChannelRegistration = {
  factory: ChannelAdapterFactory;
  containerConfig?: {
    env?: Record<string, string>;
    mounts?: { hostPath: string; containerPath: string; readonly: boolean }[];
  };
};
