import {
  createServer as createHttpServer,
  request as httpRequest,
  IncomingMessage,
  ClientRequest,
  ServerResponse,
  IncomingHttpHeaders,
} from 'node:http';
import {
  createServer as createHttpsServer,
  request as httpsRequest,
  ServerOptions as HttpsServerOptions,
} from 'node:https';

import { createSecureContext, SecureContext } from 'node:tls';
import { readdir, readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { EventEmitter } from 'node:events';
import { existsSync } from 'node:fs';
import { Socket } from 'node:net';

const HOP_BY_HOP_HEADERS = new Set([
  'connection',
  'keep-alive',
  'proxy-authenticate',
  'proxy-authorization',
  'te',
  'trailer',
  'transfer-encoding',
  'upgrade',
]);

function envPort(name: string, fallback: number): number | false {
  const value = process.env[name];
  if (value === undefined) return fallback;
  if (value.toLowerCase() === 'false') return false;
  return Number(value);
}

export class ProxyEntry {
  readonly domain: string;
  readonly target: string | URL;
  readonly authorization: string = '';
  readonly redirectToHttps: boolean = false;
  readonly redirectToUrl: string = '';
  readonly redirectToDomain: string = '';
  readonly headers: string = '';
  readonly path: string = '';
  readonly cors: boolean = false;
  readonly preserveHost: boolean = false;

  constructor(p: Partial<ProxyEntry>) {
    Object.assign(this, p);
  }
}

export type MinimalProxyEntry = Partial<ProxyEntry> & Pick<ProxyEntry, 'domain'>;

export class ProxySettings {
  readonly certificatesFolder: string = String(process.env.PROXY_CERTS_FOLDER || process.cwd());
  readonly certificateFile: string = 'fullchain.pem';
  readonly keyFile: string = 'privkey.pem';
  readonly httpPort: number | false = envPort('HTTP_PORT', 80);
  readonly httpsPort: number | false = envPort('HTTPS_PORT', 443);
  readonly autoReload: number = 1000 * 60 * 60 * 24; // 1 day
  readonly requestTimeout = 30_000;
  readonly maxProxyHops = 1;
  readonly host = '0.0.0.0';
  readonly enableDebug = !!process.env.DEBUG;
  readonly fallback: (req: IncomingMessage, res: ServerResponse) => void;
  readonly proxies?: ProxyEntry[];

  constructor(p: Partial<ProxySettings> = {}) {
    Object.assign(this, p);
  }
}

export type ProxyIncomingMessage = IncomingMessage & {
  originHost: string;
  originlUrl: URL | null;
  proxyEntry: ProxyEntry | null;
};

export class ProxyServer extends EventEmitter {
  protected certs: Record<string, SecureContext> = {};
  protected proxies: Array<MinimalProxyEntry> = [];
  protected servers: Array<ReturnType<typeof createHttpServer>> = [];
  protected settings: ProxySettings;
  protected autoReload: any;
  protected started = false;
  protected reloadPromise: Promise<this> | null = null;
  protected closePromise: Promise<void> | null = null;

  constructor(settings: ProxySettings) {
    super();
    this.settings = settings;
    this.reset();
  }

  get ports() {
    const { httpPort, httpsPort } = this.settings;
    const httpIndex = httpPort === false ? -1 : 0;
    const httpsIndex = httpsPort === false ? -1 : httpIndex + 1;
    const getPort = (configured: number | false, index: number) => {
      if (configured === false) return false;
      const address = this.servers[index]?.address();
      return address && typeof address !== 'string' ? address.port : configured;
    };

    return { httpPort: getPort(httpPort, httpIndex), httpsPort: getPort(httpsPort, httpsIndex) };
  }

  async createServers() {
    if (this.servers.length) return this;

    const { httpPort, httpsPort } = this.settings;
    const ssl = this.getSslOptions();
    const servers: Array<ReturnType<typeof createHttpServer>> = [];

    try {
      for (const [port, isSsl] of [[httpPort, false], [httpsPort, true]] as const) {
        if (port === false) continue;

        const server = this.setupServer(isSsl ? createHttpsServer(ssl) : createHttpServer(), isSsl);
        await new Promise<void>((resolve, reject) => {
          const onError = (error: Error) => reject(error);
          server.once('error', onError);
          server.listen({ port, host: this.settings.host }, () => {
            server.removeListener('error', onError);
            resolve();
          });
        });
        servers.push(server);
      }
    } catch (error) {
      await Promise.all(servers.map((server) => this.closeServer(server)));
      throw error;
    }

    this.servers = servers;
    return this;
  }

  async start() {
    if (this.started) return this;

    await this.closePromise;
    this.closePromise = null;
    this.validateSettings();
    await this.reload();

    if (this.settings.proxies) {
      for (const p of this.settings.proxies) this.add(p);
    }

    await this.createServers();
    this.started = true;

    if (this.settings.autoReload) {
      this.autoReload = setInterval(() => {
        this.reload().catch((error) => this.handleReloadError(error));
      }, this.settings.autoReload);
    }

    return this;
  }

  reset() {
    this.closePromise = Promise.all(this.servers.map((server) => this.closeServer(server))).then(() => undefined);
    this.servers = [];
    this.proxies = [];
    this.certs = {};
    this.started = false;
    clearInterval(this.autoReload);
    this.autoReload = undefined;

    return this;
  }

  async reload() {
    if (this.reloadPromise) return this.reloadPromise;

    this.reloadPromise = this.loadCertificates()
      .then(() => this)
      .finally(() => {
        this.reloadPromise = null;
      });

    return this.reloadPromise;
  }

  add(proxy: MinimalProxyEntry) {
    this.validateProxy(proxy);
    this.proxies.push(proxy);
    return this;
  }

  onRequest(_req: IncomingMessage, res: ServerResponse, isSsl: boolean) {
    _req.on('error', (error) => this.handleError(error, res));
    res.on('error', (error) => this.handleServerError(error));

    try {
      const req = this.matchProxy(_req);
      const proxyRequest = this.createRequest(req, res, isSsl);

      if (!proxyRequest) return;
      const { proxyEntry } = req;
      if (!proxyEntry) return;

      req.on('error', (error) => proxyRequest.destroy(error));
      req.on('aborted', () => proxyRequest.destroy());
      req.on('data', (chunk) => {
        try {
          proxyRequest.write(chunk);
        } catch (error) {
          this.handleError(error, res);
        }
      });
      req.on('end', () => {
        try {
          proxyRequest.end();
        } catch (error) {
          this.handleError(error, res);
        }
      });

      proxyRequest.on('error', (error) => this.handleError(error, res));
      proxyRequest.on('response', (proxyRes) => {
        try {
          proxyRes.on('error', (error) => this.handleError(error, res));
          this.setHeaders(proxyRes, res);

          const isCorsSimple = req.method !== 'OPTIONS' && proxyEntry.cors && req.headers.origin;
          if (isCorsSimple && !this.setCorsHeaders(req, res)) {
            res.writeHead(403, 'CORS origin not allowed');
            res.end();
            proxyRes.resume();
            return;
          }

          res.writeHead(proxyRes.statusCode, proxyRes.statusMessage);
          proxyRes.on('data', (chunk) => {
            try {
              res.write(chunk);
            } catch (error) {
              this.handleError(error, res);
            }
          });
          proxyRes.on('end', () => {
            try {
              res.end();
            } catch (error) {
              this.handleError(error, res);
            }
          });
        } catch (error) {
          this.handleError(error, res);
        }
      });
    } catch (error) {
      this.handleError(error, res);
    }
  }

  onUpgrade(_req: IncomingMessage, socket: Socket, head: any, isSsl: boolean) {
    _req.on('error', (error) => {
      socket.destroy();
      this.handleServerError(error);
    });

    try {
      const notValid =
        _req.method !== 'GET' || !_req.headers.upgrade || _req.headers.upgrade.toLowerCase() !== 'websocket';
      const req = this.matchProxy(_req);

      if (notValid || !req.proxyEntry) {
        socket.destroy();
        return;
      }

      const proxyReq = this.createRequest(req, socket as any, isSsl);
      if (!proxyReq) {
        socket.destroy();
        return;
      }

      socket.on('error', (error) => this.emit('proxyerror', error));
      socket.setTimeout(0);
      socket.setNoDelay(true);
      socket.setKeepAlive(true, 0);

      if (head && head.length) socket.unshift(head);

      proxyReq.on('error', (error) => this.emit('proxyerror', error));
      proxyReq.on('response', (proxyRes) => {
        proxyRes.resume();
        socket.end('HTTP/1.1 502 Bad Gateway\r\nConnection: close\r\n\r\n');
      });
      proxyReq.on('upgrade', (proxyRes, proxySocket, proxyHead) => {
        proxyReq.setTimeout(0);
        proxySocket.on('error', (error) => this.emit('proxyerror', error));
        socket.on('error', () => proxySocket.end());

        if (proxyHead && proxyHead.length) proxySocket.unshift(proxyHead);
        socket.write(this.createWebSocketResponseHeaders(proxyRes.headers));
        proxySocket.pipe(socket).pipe(proxySocket);
      });

      return proxyReq.end();
    } catch (error) {
      socket.destroy();
      this.handleServerError(error);
    }
  }

  protected createWebSocketResponseHeaders(headers: IncomingHttpHeaders) {
    return (
      Object.entries(headers)
        .reduce(
          function (head, next) {
            const [key, value] = next;

            if (!Array.isArray(value)) {
              head.push(`${key}: ${value}`);
              return head;
            }

            for (const next of value) {
              head.push(`${key}: ${next}`);
            }

            return head;
          },
          ['HTTP/1.1 101 Switching Protocols'],
        )
        .join('\r\n') + '\r\n\r\n'
    );
  }

  protected matchProxy(req: IncomingMessage) {
    const candidates = this.getHostCandidates(req.headers);

    for (const candidate of candidates) {
      try {
        const url = new URL(req.url || '/', 'http://' + candidate);
        if (!this.isManagedDomain(url.hostname)) continue;

        const proxyEntry = this.findProxyEntry(url);
        Object.assign(req, { originHost: candidate, originlUrl: url, proxyEntry });
        return req as ProxyIncomingMessage;
      } catch {}
    }

    Object.assign(req, { originHost: '', originlUrl: null, proxyEntry: null });

    return req as ProxyIncomingMessage;
  }

  protected getHostCandidates(headers: IncomingHttpHeaders) {
    const candidates: string[] = [];
    const add = (value: string | string[] | undefined) => {
      const values = Array.isArray(value) ? value : value ? [value] : [];
      for (const item of values) {
        for (const candidate of item.split(',')) {
          const host = candidate.trim().replace(/^"|"$/g, '');
          if (host) candidates.push(host);
        }
      }
    };

    add(headers['x-forwarded-host']);
    add(headers.host);

    const forwarded = headers.forwarded;
    const forwardedValues = Array.isArray(forwarded) ? forwarded : forwarded ? [forwarded] : [];
    for (const value of forwardedValues) {
      for (const parameter of value.split(',')) {
        const match = parameter.match(/(?:^|;)\s*host=([^;]+)/i);
        if (match) add(match[1]);
      }
    }

    return candidates;
  }

  protected isManagedDomain(hostname: string) {
    return this.proxies.some((proxy) => {
      const domain = proxy.domain.toLowerCase();
      const host = hostname.toLowerCase();
      return domain === host || (domain.startsWith('*.') && host.endsWith(`.${domain.slice(2)}`));
    });
  }

  protected createRequest(req: ProxyIncomingMessage, res: ServerResponse, isSsl: boolean) {
    const { originHost = 'none', originlUrl = null, proxyEntry = null } = req;

    if (this.settings.enableDebug) {
      res.on('finish', () => {
        console.log(
          '[%s] %s %s [%s] => %d %s',
          new Date().toISOString().slice(0, 19),
          req.method,
          req.url,
          originHost,
          res.statusCode,
          proxyEntry?.target || '(none)',
        );
      });
    }

    if (!(originlUrl && proxyEntry)) {
      if (this.settings.fallback) {
        this.settings.fallback(req, res);
        return;
      }

      this.notFound(res);
      return;
    }

    const rawHops = req.headers['x-px-hop'];
    const hops = Number(Array.isArray(rawHops) ? rawHops[0] : rawHops || 0);
    if (!Number.isInteger(hops) || hops < 0 || hops >= this.settings.maxProxyHops) {
      res.writeHead(508, 'Loop Detected');
      res.end();
      return;
    }

    if (proxyEntry.authorization) {
      const incomingHeader = (req.headers.authorization || '').replace(/^basic/i, '').trim();

      if (incomingHeader !== proxyEntry.authorization) {
        res.setHeader('WWW-Authenticate', 'Basic realm="Y u no password"');
        res.writeHead(401);
        res.end();

        return;
      }
    }

    const requestPath = originlUrl.pathname + originlUrl.search;

    if (proxyEntry.redirectToDomain) {
      const newURL = new URL(requestPath, `https://${proxyEntry.redirectToDomain}`);
      res.setHeader('Location', String(newURL));
      res.writeHead(302, 'Moved somewhere else');
      res.end();
      return;
    }

    if (proxyEntry.redirectToUrl) {
      res.setHeader('Location', String(proxyEntry.redirectToUrl));
      res.writeHead(302, 'Moved somewhere else');
      res.end();
      return;
    }

    if (proxyEntry.redirectToHttps && !isSsl) {
      const newURL = new URL(requestPath, `https://${originHost}`);
      res.setHeader('Location', String(newURL));
      res.writeHead(301, 'HTTPS is better');
      res.end();
      return;
    }

    const isCorsPreflight = Boolean(req.method === 'OPTIONS' && proxyEntry.cors && req.headers.origin);
    if (isCorsPreflight) {
      if (!this.setCorsHeaders(req, res)) {
        res.writeHead(403, 'CORS origin not allowed');
        res.end();
        return;
      }
      res.writeHead(204, { 'Content-Length': '0' });
      res.end();
      return;
    }

    const targetAddress = proxyEntry.target;
    // URL always starts with /, which defeats the purpose of a target with a path
    // removing the first slash allows for a relative path
    const targetUrl = new URL(requestPath.slice(1), targetAddress);

    if (proxyEntry.path) {
      targetUrl.pathname = targetUrl.pathname.replace(proxyEntry.path, '');
    }

    const requestOptions = { method: req.method };
    const proxyRequest = (targetUrl.protocol === 'https:' ? httpsRequest : httpRequest)(targetUrl, requestOptions);
    this.setHeaders(req, proxyRequest);

    if (proxyEntry.headers) {
      this.setExtraHeaders(proxyRequest, proxyEntry.headers);
    }

    if (proxyEntry.preserveHost) {
      const hostHeader = req.headers.host || '';
      proxyRequest.setHeader('host', hostHeader);
      proxyRequest.setHeader('x-forwarded-host', hostHeader);
      proxyRequest.setHeader('x-forwarded-proto', isSsl ? 'https' : 'http');
      proxyRequest.setHeader('forwarded', 'host=' + hostHeader + ';proto=' + (isSsl ? 'https' : 'http'));
    } else {
      const host = targetUrl.hostname + (targetUrl.port ? ':' + targetUrl.port : '');
      proxyRequest.setHeader('host', host);
    }

    proxyRequest.setHeader('x-forwarded-for', req.socket?.remoteAddress || '');
    proxyRequest.setHeader('x-px-hop', String(hops + 1));
    proxyRequest.setTimeout(this.settings.requestTimeout, () => {
      proxyRequest.destroy(Object.assign(new Error('Upstream request timed out'), { code: 'ETIMEDOUT' }));
    });

    return proxyRequest;
  }

  protected setupServer(server: any, isSsl: boolean) {
    server.on('error', (error) => this.handleServerError(error));
    server.on('request', (req, res) => this.onRequest(req, res, isSsl));
    server.on('upgrade', (req, socket, head) => this.onUpgrade(req, socket, head, isSsl));

    return server;
  }

  protected closeServer(server: ReturnType<typeof createHttpServer>) {
    return new Promise<void>((resolve) => {
      if (!server.listening) {
        resolve();
        return;
      }
      server.close(() => resolve());
    });
  }

  protected validateSettings() {
    for (const port of [this.settings.httpPort, this.settings.httpsPort]) {
      if (port !== false && (!Number.isInteger(port) || port < 0 || port > 65535)) {
        throw new Error(`Invalid port: ${String(port)}`);
      }
    }

    if (!Number.isInteger(this.settings.requestTimeout) || this.settings.requestTimeout <= 0) {
      throw new Error('requestTimeout must be a positive integer');
    }
    if (!Number.isInteger(this.settings.maxProxyHops) || this.settings.maxProxyHops < 1) {
      throw new Error('maxProxyHops must be a positive integer');
    }
  }

  protected validateProxy(proxy: MinimalProxyEntry) {
    if (!proxy.domain || typeof proxy.domain !== 'string') {
      throw new Error('Proxy domain is required');
    }

    if (proxy.target === undefined && !proxy.redirectToDomain && !proxy.redirectToUrl) {
      throw new Error('Proxy target or redirect is required');
    }

    if (proxy.target !== undefined) {
      const target = new URL(proxy.target);
      if (target.protocol !== 'http:' && target.protocol !== 'https:') {
        throw new Error(`Unsupported proxy target protocol: ${target.protocol}`);
      }
    }

    if (proxy.path && !proxy.path.startsWith('/')) {
      throw new Error('Proxy path must start with /');
    }

    if (proxy.headers) {
      for (const header of proxy.headers.split('|')) {
        const separator = header.indexOf(':');
        if (separator <= 0 || !header.slice(separator + 1).trim()) {
          throw new Error(`Invalid proxy header: "${header}"`);
        }
      }
    }
  }

  protected async loadCertificate(folder: string) {
    const { certificatesFolder, certificateFile, keyFile } = this.settings;

    if (this.settings.enableDebug) {
      console.log(`+ ${folder}`);
    }

    return createSecureContext({
      cert: await readFile(join(certificatesFolder, folder, certificateFile), 'utf8'),
      key: await readFile(join(certificatesFolder, folder, keyFile), 'utf8'),
    });
  }

  protected async loadCertificates() {
    const certs: Record<string, SecureContext> = {};
    const folder = this.settings.certificatesFolder;

    if (this.settings.httpsPort === false) {
      return;
    }

    if (this.settings.enableDebug) {
      console.log(`Loading certificates from ${folder}`);
    }

    const localCerts = !existsSync(folder)
      ? []
      : await readdir(folder, {
          withFileTypes: true,
        });

    const folders = localCerts.filter((entry) => entry.isDirectory()).map((dir) => dir.name);

    for (const rootDomain of folders) {
      certs[rootDomain] = await this.loadCertificate(rootDomain);
    }

    this.certs = certs;
  }

  protected setExtraHeaders(req: ClientRequest, headersString: string) {
    headersString.split('|').forEach((header) => {
      const [key, value] = header.split(':', 2);
      req.setHeader(key.trim(), value.trim());
    });
  }

  protected findProxyEntry(url: URL) {
    const { hostname, pathname } = url;
    const requestParentDomain = hostname.split('.').slice(1).join('.');

    // test example.com (exact match) or *.example.com for <anything>.example.com
    const byDomain = this.proxies.filter(
      (p) =>
        p.domain === hostname ||
        (p.domain.startsWith('*.') &&
          p.domain.slice(2) === requestParentDomain &&
          p.domain.slice(2) !== hostname),
    );

    if (byDomain.length === 1) {
      return byDomain[0];
    }

    // with path /api
    //    example.com/api      => [target]
    //    example.com/api/foo  => [target]/foo
    // without path
    //    example.com          => [target]

    return (
      byDomain.find((p) => p.path && (pathname === p.path || pathname.startsWith(p.path + '/'))) ||
      byDomain.find((p) => !p.path) ||
      null
    );
  }

  protected getSslOptions(): HttpsServerOptions {
    const server = this;

    return {
      SNICallback(domain, cb) {
        const rootDomain = server.findRootDomain(domain);

        if (rootDomain) {
          server.emit('sni', rootDomain);
          return cb(null, rootDomain);
        }

        cb(new Error('Not found'), null);
      },
    };
  }

  protected findRootDomain(domain: string) {
    const parts = domain.split('/')[0].split('.');
    const certs = this.certs;

    while (parts.length) {
      const rootDomain = parts.join('.');

      if (certs[rootDomain]) {
        return certs[rootDomain];
      }

      parts.shift();
    }

    return null;
  }

  protected setHeaders(from: IncomingMessage, to: ServerResponse | ClientRequest) {
    const headers = Object.entries(from.headers);
    const connectionHeaders = new Set(
      typeof from.headers.connection === 'string'
        ? from.headers.connection.split(',').map((header) => header.trim().toLowerCase())
        : [],
    );

    for (const header of headers) {
      const name = header[0].toLowerCase();
      if (HOP_BY_HOP_HEADERS.has(name) || connectionHeaders.has(name)) continue;
      to.setHeader(header[0], header[1]);
    }
  }

  protected setCorsHeaders(req: IncomingMessage, res: ServerResponse) {
    const headers = req.headers;
    const origin = req.headers.origin;
    if (!origin) return false;

    let corsOrigin: string;
    let hostname: string;
    try {
      const url = new URL(origin);
      if (url.protocol !== 'http:' && url.protocol !== 'https:') return false;
      corsOrigin = url.origin;
      hostname = url.hostname;
    } catch {
      return false;
    }

    const managedDomains = this.proxies.map((proxy) => proxy.domain.replace(/^\*\./, '').toLowerCase());
    const allowed = managedDomains.some(
      (domain) => hostname === domain || hostname.endsWith(`.${domain}`),
    );
    if (!allowed) return false;

    const allowedMethod = headers['access-control-request-method'] || 'GET,HEAD,PUT,PATCH,POST,DELETE';
    const allowedHeaders = headers['access-control-request-headers'] || '*';

    res.setHeader('Vary', 'Origin');
    res.setHeader('Access-Control-Allow-Origin', corsOrigin);
    res.setHeader('Access-Control-Allow-Headers', allowedHeaders);
    res.setHeader('Access-Control-Allow-Methods', allowedMethod);
    res.setHeader('Access-Control-Allow-Credentials', 'true');
    return true;
  }

  protected handleError(error: any, res: ServerResponse) {
    if (this.settings.enableDebug) {
      console.error(error);
    }

    this.emit('proxyerror', error);

    if (res.writableEnded || res.destroyed) return;

    if (res.headersSent) {
      if (res.writable) res.end();
      return;
    }

    if (error?.code === 'ETIMEDOUT') {
      res.writeHead(504);
      res.end();
      return;
    }

    if (error?.code === 'ECONNREFUSED' || error?.code === 'ECONNRESET') {
      res.writeHead(502);
      res.end();
      return;
    }

    if (!res.headersSent) {
      res.writeHead(500);
      res.end();
    }
  }

  protected handleServerError(error: unknown) {
    if (this.settings.enableDebug) console.error(error);
    this.emit('proxyerror', error);
  }

  protected handleReloadError(error: unknown) {
    this.handleServerError(error);
  }

  protected notFound(res: ServerResponse) {
    res.writeHead(404, 'Not found');
    res.end();
  }
}

export async function loadConfig(path?: string, optional = false): Promise<ProxySettings> {
  if (!path) {
    const candidates = [
      join(process.cwd(), 'proxy.config.mjs'),
      join(process.cwd(), 'proxy.config.js'),
      join(process.cwd(), 'proxy.config.json'),
    ];

    path = candidates.find((path) => existsSync(path));
  }

  if (!path || !existsSync(path)) {
    if (optional) {
      return null;
    }

    throw new Error('Configuration not found');
  }

  if (path.endsWith('.json')) {
    return new ProxySettings(JSON.parse(await readFile(path, 'utf-8')));
  }

  const mod = await import(path);
  return mod.default;
}

export function defineConfig(config: ProxySettings) {
  return new ProxySettings(config);
}
