import type { RequestHandler } from 'express';

function hostnameFromUrl(rawUrl: string | undefined): string | undefined {
  if (!rawUrl) return undefined;
  try {
    return new URL(rawUrl).hostname.toLowerCase();
  } catch {
    return undefined;
  }
}

function isLoopbackHostname(hostname: string): boolean {
  return hostname === 'localhost'
    || hostname.endsWith('.localhost')
    || hostname === '127.0.0.1'
    || hostname === '[::1]'
    || hostname === '::1';
}

export function isPaymentPublicHost(requestHostname: string, publicUrl: string | undefined): boolean {
  const configuredHostname = hostnameFromUrl(publicUrl);
  return Boolean(configuredHostname
    && !isLoopbackHostname(configuredHostname)
    && requestHostname.toLowerCase() === configuredHostname);
}

export function isAllowedPaymentRequest(method: string, path: string): boolean {
  const verb = method.toUpperCase();
  if ((verb === 'GET' || verb === 'HEAD') && /^\/assets\//.test(path)) return true;
  if ((verb === 'GET' || verb === 'HEAD') && /^\/pay\/[^/]+\/?$/.test(path)) return true;
  if ((verb === 'GET' || verb === 'HEAD' || verb === 'DELETE')
    && /^\/api\/work\/payment-sessions\/[^/]+\/?$/.test(path)) return true;
  if ((verb === 'GET' || verb === 'HEAD')
    && /^\/api\/work\/payment-sessions\/[^/]+\/(frame|stream)\/?$/.test(path)) return true;
  if (verb === 'POST' && /^\/api\/work\/payment-sessions\/[^/]+\/(claim|input)\/?$/.test(path)) return true;
  return false;
}

export function shouldRestrictToPaymentRoutes(
  requestHostname: string,
  publicUrl: string | undefined,
  hasCloudflareRay: boolean,
): boolean {
  return hasCloudflareRay || isPaymentPublicHost(requestHostname, publicUrl);
}

/** The payment hostname is public, so it must never expose the admin UI/API. */
export function paymentHostGuard(getPublicUrl: () => string | undefined): RequestHandler {
  return (req, res, next) => {
    if (!shouldRestrictToPaymentRoutes(req.hostname, getPublicUrl(), Boolean(req.header('cf-ray')))) return next();
    if (isAllowedPaymentRequest(req.method, req.path)) return next();
    res.status(404).json({ error: 'Not found' });
  };
}
