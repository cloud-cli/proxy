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
  readonly redirectToHttps: boolean = false;
  readonly redirectToUrl: string = '';
  readonly redirectToDomain: string = '';
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
  readonly httpPort: number = 80;
  readonly httpsPort: number = 443;
  readonly autoReload: number = 1000 * 60 * 60 * 24; // 1 day

  constructor(p: Partial<ProxySettings> = {}) {
    Object.assign(this, p);
  }
}

const debugEnabled = !!process.env.DEBUG;

export class ProxyServer extends EventEmitter {
  protected certs: Record<string, SecureContext> = {};
  protected proxies: Record<string, MinimalProxyEntry> = {};
  protected servers: Array<ReturnType<typeof createHttpServer>> = [];
  protected settings: ProxySettings;
  protected autoReload: any;

  constructor(settings: ProxySettings) {
    super();
    this.settings = settings;
    this.reset();
  }

  createServers() {
    const { httpPort, httpsPort } = this.settings;
    const ssl = this.getSslOptions();

    this.servers = [
      createHttpServer((req, res) => this.handleRequest(req, res, false)).listen(httpPort),
      createHttpsServer(ssl, (req, res) => this.handleRequest(req, res, true)).listen(httpsPort),
    ];
  }

  async start() {
    this.reset();
    await this.reload();

    if (this.settings.autoReload) {
      this.autoReload = setInterval(() => this.reload(), this.settings.autoReload);
    }

    return this;
  }

  reset() {
    this.servers.forEach((server: any) => server.close());
    this.proxies = {};
    this.certs = {};
    clearInterval(this.autoReload);

    return this;
  }

  async reload() {
    await this.loadCertificates();
    return this;
  }

  add(proxy: MinimalProxyEntry) {
    this.proxies[proxy.domain] = proxy;
    return this;
  }

  protected async loadCertificate(folder: string) {
    const { certificatesFolder, certificateFile, keyFile } = this.settings;

    createSecureContext({
      cert: await readFile(join(certificatesFolder, folder, certificateFile), 'utf8'),
      key: await readFile(join(certificatesFolder, folder, keyFile), 'utf8'),
    });

    if (debugEnabled) {
      console.log(`.. ${folder}`);
    }
  }

  protected async loadCertificates() {
    const certs = (this.certs = {});
    const folder = this.settings.certificatesFolder;

    if (debugEnabled) {
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

  handleRequest(req: IncomingMessage, res: ServerResponse, isSsl?: boolean) {
    const host = [req.headers['x-forwarded-for'], req.headers.host].filter(Boolean)[0];
    const origin = host ? new URL('http://' + host) : null;
    const proxyEntry = this.proxies[origin?.hostname];

    if (debugEnabled) {
      console.log(
        '[%s] %s %s [from %s] => %s',
        new Date().toISOString().slice(0, 10),
        req.method,
        req.url,
        host,
        proxyEntry?.target,
      );
    }

    if (!(origin && proxyEntry)) {
      res.writeHead(404, 'Not found');
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
    const url = new URL(req.url, target);
    const proxyRequest = (url.protocol === 'https:' ? httpsRequest : httpRequest)(url, { method: req.method });
    this.setHeaders(req, proxyRequest);
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
    if (debugEnabled) {
      console.error(error);
    }

    this.emit('error', error);

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
