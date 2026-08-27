import { createHash } from "crypto";
import { type DownloaderOptions, type ProxyOptions } from "../downloaders/DownloaderOptions.js";
import { ProxyAgent, type Dispatcher } from 'undici';
import { socksDispatcher } from 'fetch-socks';

export interface ProxyAgentInfo {
  protocol: 'http' | 'https' | 'socks4' | 'socks5';
  proxyURL: string;
  agent: Dispatcher;
}

const proxyAgents: Record<string, ProxyAgentInfo> = {};

export function createProxyAgent(options: DownloaderOptions) {
  return createProxyAgentFor(options.request?.proxy);
}

/**
 * The same thing for a caller that has proxy options on their own rather than
 * a whole `DownloaderOptions` - the web server's translation requests, which
 * are configured per feature and not per download.
 *
 * Agents are cached by their options, so callers may ask on every request and
 * still share one connection pool.
 */
export function createProxyAgentFor(proxy?: ProxyOptions | null) {
  if (!proxy) {
    return null;
  }
  const key = createHash('md5').update(JSON.stringify(proxy)).digest('hex');
  if (proxyAgents[key]) {
    return proxyAgents[key];
  }
  const proxyURL = proxy.url;
  const urlObj = new URL(proxyURL);
  const protocol = urlObj.protocol.endsWith(':') ? urlObj.protocol.substring(0, urlObj.protocol.length - 1) : urlObj.protocol;
  if (protocolMatches(protocol, ['http', 'https'])) {
    const agent = createHTTPProxyAgent(proxy);
    proxyAgents[key] = { protocol, proxyURL, agent };
    return proxyAgents[key];
  }
  if (protocolMatches(protocol, ['socks4', 'socks5'])) {
    const agent = createSocksProxyAgent(proxy);
    proxyAgents[key] = { protocol, proxyURL, agent };
    return proxyAgents[key];
  }
  throw Error(`Unsupported proxy protocol '${protocol}'`);
}

function createHTTPProxyAgent(options: ProxyOptions) {
  const urlObj = new URL(options.url);
  const agent = new ProxyAgent({
    uri: options.url,
    connect: {
      requestCert: urlObj.protocol === 'https',
      rejectUnauthorized: options.rejectUnauthorizedTLS
    },
    requestTls: {
      requestCert: urlObj.protocol === 'https',
      rejectUnauthorized: options.rejectUnauthorizedTLS
    },
    proxyTls: {
      requestCert: urlObj.protocol === 'https',
      rejectUnauthorized: options.rejectUnauthorizedTLS
    }
  });
  return agent;
}

function createSocksProxyAgent(options: ProxyOptions) {
  const urlObj = new URL(options.url);
  const type = urlObj.protocol === 'socks4' ? 4 : 5;
  const agent = socksDispatcher({
    type,
    host: urlObj.hostname,
    port: Number(urlObj.port),
    userId: urlObj.username || undefined,
    password: urlObj.password
  }, {
    connect: {
      rejectUnauthorized: options.rejectUnauthorizedTLS
    }
  });
  return agent;
}

function protocolMatches<T extends ProxyAgentInfo['protocol'][]>(protocol: string, match: T): protocol is T[number] {
  return match.includes(protocol as any);
}