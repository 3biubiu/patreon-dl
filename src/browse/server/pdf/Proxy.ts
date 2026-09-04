import { commonLog } from '../../../utils/logging/Logger.js';
import type Logger from '../../../utils/logging/Logger.js';
import { createProxyAgentFor } from '../../../utils/Proxy.js';

/**
 * The undici dispatcher for `proxyUrl`, or `undefined` to go direct.
 *
 * A bad proxy URL is reported and then ignored, so what the caller sees is the
 * request failing rather than the configuration being rejected - the clearer
 * of the two errors, and the one that names the host that would not answer.
 */
export function dispatcherFor(proxyUrl: string | null, logName: string, logger?: Logger | null) {
  if (!proxyUrl) {
    return undefined;
  }
  try {
    return createProxyAgentFor({ url: proxyUrl })?.agent;
  }
  catch (error) {
    commonLog(logger, 'warn', logName, `Ignoring the PDF translation proxy "${proxyUrl}":`, error);
    return undefined;
  }
}
