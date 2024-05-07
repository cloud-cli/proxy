import {
  createServer as createHttpServer,
  request as httpRequest,
  IncomingMessage,
  ClientRequest,
  ServerResponse,
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

  constructor(p: Partial<ProxyEntry>) {
    Object.assign(this, p);
  }
}

export type MinimalProxyEntry = Partial<ProxyEntry> & Pick<ProxyEntry, 'domain'>;

export class ProxySettings {
  readonly certificatesFolder: string = String(process.env.PROXY_CERTS_FOLDER);
  readonly certificateFile: string = 'fullchain.pem';
  readonly keyFile: string = 'privkey.pem';
  readonly httpPort: number = Number(process.env.HTTP_PORT) || 80;
  readonly httpsPort: number = Number(process.env.HTTPS_PORT) || 443;
  readonly autoReload: number = 1000 * 60 * 60 * 24; // 1 day
  readonly host = '0.0.0.0';
  readonly enableDebug = !!process.env.DEBUG;

  constructor(p: Partial<ProxySettings> = {}) {
    Object.assign(this, p);
  }
}

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
      httpPort && createHttpServer((req, res) => this.handleRequest(req, res, false)).listen(httpPort),
      httpsPort && createHttpsServer(ssl, (req, res) => this.handleRequest(req, res, true)).listen(httpsPort),
    ].filter(Boolean);
  }

  async start() {
    await this.reload();

    if (this.settings.autoReload) {
      this.autoReload = setInterval(() => this.reload(), this.settings.autoReload);
    }

    this.createServers();

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

  handleRequest(req: IncomingMessage, res: ServerResponse, isSsl?: boolean) {
    const host = [req.headers['x-forwarded-for'], req.headers.host].filter(Boolean)[0];
    const origin = host ? new URL('http://' + host) : null;
    const proxyEntry = this.findProxyEntry(origin?.hostname, req.url);

    if (this.settings.enableDebug) {
      const _end = res.end;
      res.end = (...args) => {
        console.log(
          '[%s] %s %s [%s] => %d %s',
          new Date().toISOString().slice(0, 19),
          req.method,
          req.url,
          host,
          res.statusCode,
          proxyEntry?.target || '(none)',
        );

        return _end.apply(res, args);
      };
    }

    if (!(origin && proxyEntry)) {
      res.writeHead(404, 'Not found');
      res.end();
      return;
    }

    if (
      proxyEntry.authorization &&
      proxyEntry.authorization.toLowerCase() !== req.headers.authorization.toLowerCase()
    ) {
      res.writeHead(401);
      res.end();
      return;
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
      const newURL = new URL(req.url, `https://${req.headers.host}`);
      res.setHeader('Location', String(newURL));
      res.writeHead(301, 'HTTPS is better');
      res.end();
      return;
    }

    const isCorsPreflight = req.method === 'OPTIONS' && proxyEntry.cors && req.headers.origin;
    if (isCorsPreflight) {
      this.setCorsHeaders(req, res);
      res.writeHead(204, { 'Content-Length': '0' });
      res.end();
      return;
    }

    const target = proxyEntry.target;
    // URL always starts with /, which defeats the purpose of a target with a path
    // removing the first bar allows for a relative path
    const url = new URL(req.url.slice(1), target);

    if (proxyEntry.path) {
      url.pathname = url.pathname.replace(proxyEntry.path, '');
    }

    const proxyRequest = (url.protocol === 'https:' ? httpsRequest : httpRequest)(url, { method: req.method });
    this.setHeaders(req, proxyRequest);

    if (proxyEntry.headers) {
      this.setExtraHeaders(proxyRequest, proxyEntry.headers);
    }

    proxyRequest.setHeader('host', this.getHostnameFromUrl(String(target)));
    proxyRequest.setHeader('x-forwarded-for', req.headers.host);
    proxyRequest.setHeader('x-forwarded-proto', isSsl ? 'https' : 'http');
    proxyRequest.setHeader('forwarded', 'host=' + req.headers.host + ';proto=' + (isSsl ? 'https' : 'http'));

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

  protected findProxyEntry(domain: string, incomingUrl: string) {
    const urlPath = new URL(incomingUrl, 'http://localhost').pathname;
    const byDomain = this.proxies.filter((p) => p.domain === domain);

    if (byDomain.length === 1) {
      return byDomain[0];
    }

    return byDomain.find((p) => p.path && urlPath.startsWith(p.path)) || null;
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

  protected getHostnameFromUrl(string: string) {
    const url = new URL(string);
    return url.hostname + (url.port ? ':' + url.port : '');
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
}
