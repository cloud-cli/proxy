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
  readonly httpPort: number = Number(process.env.HTTP_PORT) || 80;
  readonly httpsPort: number = Number(process.env.HTTPS_PORT) || 443;
  readonly autoReload: number = 1000 * 60 * 60 * 24; // 1 day
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
  proxyEntry: ProxyEntry;
};

export class ProxyServer extends EventEmitter {
  protected certs: Record<string, SecureContext> = {};
  protected proxies: Array<MinimalProxyEntry> = [];
  protected servers: Array<ReturnType<typeof createHttpServer>> = [];
  protected settings: ProxySettings;
  protected autoReload: any;

  constructor(settings: ProxySettings) {
    super();
    this.settings = settings;
    this.reset();
  }

  get ports() {
    const { httpPort, httpsPort } = this.settings;
    return { httpPort, httpsPort };
  }

  createServers() {
    const { httpPort, httpsPort } = this.settings;
    const ssl = this.getSslOptions();

    this.servers = [
      httpPort && this.setupServer(createHttpServer(), false).listen(httpPort),
      httpsPort && this.setupServer(createHttpsServer(ssl), true).listen(httpsPort),
    ].filter(Boolean);
  }

  async start() {
    await this.reload();

    if (this.settings.autoReload) {
      this.autoReload = setInterval(() => this.reload(), this.settings.autoReload);
    }

    this.createServers();

    if (this.settings.proxies) {
      for (const p of this.settings.proxies) this.add(p);
    }

    return this;
  }

  reset() {
    this.servers.forEach((server: any) => server.close());
    this.proxies = [];
    this.certs = {};
    clearInterval(this.autoReload);

    return this;
  }

  async reload() {
    await this.loadCertificates();
    return this;
  }

  add(proxy: MinimalProxyEntry) {
    this.proxies.push(proxy);
    return this;
  }

  onRequest(_req: IncomingMessage, res: ServerResponse, isSsl: boolean) {
    const req = this.matchProxy(_req);
    const { proxyEntry } = req;
    const proxyRequest = this.createRequest(req, res, isSsl);

    if (!proxyRequest) {
      return;
    }

    req.on('data', (chunk) => proxyRequest.write(chunk));
    req.on('end', () => proxyRequest.end());

    proxyRequest.on('error', (error) => this.handleError(error, res));
    proxyRequest.on('response', (proxyRes) => {
      this.setHeaders(proxyRes, res);

      const isCorsSimple = req.method !== 'OPTIONS' && proxyEntry.cors && req.headers.origin;
      if (isCorsSimple) {
        this.setCorsHeaders(req, res);
      }

      res.writeHead(proxyRes.statusCode, proxyRes.statusMessage);

      proxyRes.on('data', (chunk) => res.write(chunk));
      proxyRes.on('end', () => res.end());
    });
  }

  onUpgrade(_req: IncomingMessage, socket: Socket, head: any, isSsl: boolean) {
    const notValid =
      _req.method !== 'GET' || !_req.headers.upgrade || _req.headers.upgrade.toLowerCase() !== 'websocket';
    const req = this.matchProxy(_req);

    if (notValid || !req.proxyEntry) {
      socket.destroy();
      return;
    }

    const proxyReq = this.createRequest(req, socket as any, isSsl);

    socket.setTimeout(0);
    socket.setNoDelay(true);
    socket.setKeepAlive(true, 0);

    if (head && head.length) {
      socket.unshift(head);
    }

    proxyReq.on('error', (error) => this.emit('proxyerror', error));
    proxyReq.on('upgrade', (proxyRes, proxySocket, proxyHead) => {
      proxySocket.on('error', (error) => this.emit('proxyerror', error));

      socket.on('error', (error) => {
        this.emit('proxyerror', error);
        proxySocket.end();
      });

      if (proxyHead && proxyHead.length) {
        proxySocket.unshift(proxyHead);
      }

      socket.write(this.createWebSocketResponseHeaders(proxyRes.headers));

      proxySocket.pipe(socket).pipe(proxySocket);
    });

    return proxyReq.end();
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
    const originHost = [req.headers['x-forwarded-for'], req.headers.host].filter(Boolean)[0];
    const originlUrl = originHost ? new URL('http://' + originHost) : null;
    const proxyEntry = originlUrl ? this.findProxyEntry(originlUrl.hostname, req.url) : null;

    Object.assign(req, { originHost, originlUrl, proxyEntry });

    return req as ProxyIncomingMessage;
  }

  protected createRequest(req: ProxyIncomingMessage, res: ServerResponse, isSsl: boolean) {
    const { originHost, originlUrl, proxyEntry } = req;

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

    if (proxyEntry.authorization) {
      const incomingHeader = (req.headers.authorization || '').replace('Basic', '').trim();

      if (incomingHeader !== proxyEntry.authorization) {
        res.setHeader('WWW-Authenticate', 'Basic realm="Y u no password"');
        res.writeHead(401);
        res.end();

        return;
      }
    }

    if (proxyEntry.redirectToDomain) {
      const newURL = new URL(req.url, `https://${proxyEntry.redirectToDomain}`);
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
      const newURL = new URL(req.url, `https://${originHost}`);
      res.setHeader('Location', String(newURL));
      res.writeHead(301, 'HTTPS is better');
      res.end();
      return;
    }

    const isCorsPreflight = Boolean(req.method === 'OPTIONS' && proxyEntry.cors && req.headers.origin);
    if (isCorsPreflight) {
      this.setCorsHeaders(req, res);
      res.writeHead(204, { 'Content-Length': '0' });
      res.end();
      return;
    }

    const targetAddress = proxyEntry.target;
    // URL always starts with /, which defeats the purpose of a target with a path
    // removing the first slash allows for a relative path
    const targetUrl = new URL(req.url.slice(1), targetAddress);

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
      proxyRequest.setHeader('host', req.headers.host);
      proxyRequest.setHeader('x-forwarded-for', req.headers.host);
      proxyRequest.setHeader('x-forwarded-proto', isSsl ? 'https' : 'http');
      proxyRequest.setHeader('forwarded', 'host=' + req.headers.host + ';proto=' + (isSsl ? 'https' : 'http'));
    } else {
      const host = targetUrl.hostname + (targetUrl.port ? ':' + targetUrl.port : '');
      proxyRequest.setHeader('host', host);
    }

    return proxyRequest;
  }

  protected setupServer(server: any, isSsl: boolean) {
    server.on('request', (req, res) => this.onRequest(req, res, isSsl));
    server.on('upgrade', (req, socket, head) => this.onUpgrade(req, socket, head, isSsl));

    return server;
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
    const certs = (this.certs = {});
    const folder = this.settings.certificatesFolder;

    if (!this.settings.httpsPort) {
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
  }

  protected setExtraHeaders(req: ClientRequest, headersString: string) {
    headersString.split('|').forEach((header) => {
      const [key, value] = header.split(':', 2);
      req.setHeader(key.trim(), value.trim());
    });
  }

  protected findProxyEntry(domainFromRequest: string, incomingUrl: string) {
    const requestPath = new URL(incomingUrl, 'http://localhost').pathname;
    const requestParentDomain = domainFromRequest.split('.').slice(1).join('.');

    // test example.com (exact match) or *.example.com for <anything>.example.com
    const byDomain = this.proxies.filter(
      (p) =>
        p.domain === domainFromRequest ||
        (p.domain.startsWith('*.') &&
          (p.domain.slice(2) === requestParentDomain || p.domain.slice(2) === domainFromRequest)),
    );

    if (byDomain.length === 1) {
      return byDomain[0];
    }

    // with path /api
    // example.com/api      => [target]
    // example.com/api/foo  => [target]/foo

    // without path
    // example.com          => [target]

    return (
      byDomain.find((p) => p.path && (requestPath === p.path || requestPath.startsWith(p.path + '/'))) ||
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

    for (const header of headers) {
      to.setHeader(header[0], header[1]);
    }
  }

  protected setCorsHeaders(req: IncomingMessage, res: ServerResponse) {
    const headers = req.headers;
    const corsOrigin = new URL(req.headers.origin).origin;
    const allowedMethod = headers['access-control-request-method'] || 'GET,HEAD,PUT,PATCH,POST,DELETE';
    const allowedHeaders = headers['access-control-request-headers'] || '*';

    res.setHeader('Vary', 'Origin');
    res.setHeader('Access-Control-Allow-Origin', corsOrigin);
    res.setHeader('Access-Control-Allow-Headers', allowedHeaders);
    res.setHeader('Access-Control-Allow-Methods', allowedMethod);
    res.setHeader('Access-Control-Allow-Credentials', 'true');
  }

  protected handleError(error: any, res: ServerResponse) {
    if (this.settings.enableDebug) {
      console.error(error);
    }

    this.emit('proxyerror', error);

    if (error.code === 'ECONNREFUSED' || error.code === 'ECONNRESET') {
      res.writeHead(502);
      res.end();
      return;
    }

    if (!res.headersSent) {
      res.writeHead(500);
      res.end();
    }
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
