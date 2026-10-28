import { appleProvider } from './apple/provider.js';
import { emailProvider } from './email/provider.js';
import { memoryProvider } from './memory/provider.js';
import type { BuiltinMcpProvider } from './types.js';

export const BUILTIN_PROVIDERS: BuiltinMcpProvider[] = [appleProvider, emailProvider, memoryProvider];
