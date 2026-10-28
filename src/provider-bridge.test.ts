import { describe, expect, it } from 'vitest';

import { CONTAINER_HOST_GATEWAY } from './container-runtime.js';
import { resolveProviderBridgePorts } from './provider-bridge.js';

describe('resolveProviderBridgePorts', () => {
  it('bridges providers on the container host alias', () => {
    const ports = resolveProviderBridgePorts({
      providers: { openai: { baseUrl: 'http://host.docker.internal:8080/v1' } },
    });
    expect(ports).toEqual([8080]);
  });

  it('bridges providers on the bridge gateway', () => {
    const ports = resolveProviderBridgePorts({
      providers: { rerank: { kind: 'llama-server-reranker', baseUrl: `http://${CONTAINER_HOST_GATEWAY}:8081/v1` } },
    });
    expect(ports).toEqual([8081]);
  });

  it('dedupes providers sharing one port', () => {
    const ports = resolveProviderBridgePorts({
      providers: {
        openai: { baseUrl: 'http://host.docker.internal:8080/v1' },
        rerank: { kind: 'llama-server-reranker', baseUrl: `http://${CONTAINER_HOST_GATEWAY}:8080/v1` },
      },
    });
    expect(ports).toEqual([8080]);
  });

  it('bridges providers on loopback', () => {
    // The natural spelling for a local inference server, and the one
    // containerReachableUrl rewrites to the gateway on the way into a container
    // — so the gateway has to be listening.
    const ports = resolveProviderBridgePorts({
      providers: {
        local: { baseUrl: 'http://127.0.0.1:8080/v1' },
        named: { baseUrl: 'http://localhost:11434/v1' },
      },
    });
    expect(ports.sort((a, b) => a - b)).toEqual([8080, 11434]);
  });

  it('leaves remote and unparseable providers alone', () => {
    const ports = resolveProviderBridgePorts({
      providers: {
        openai: { baseUrl: 'https://api.openai.com/v1' },
        lan: { baseUrl: 'http://10.0.0.5:8080/v1' },
        broken: { baseUrl: 'not a url' },
      },
    });
    expect(ports).toEqual([]);
  });

  it('returns nothing when no providers are configured', () => {
    expect(resolveProviderBridgePorts({})).toEqual([]);
  });
});
