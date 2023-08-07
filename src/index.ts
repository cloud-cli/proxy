import {
  createServer as createHttpServer,
  request as httpRequest,
  IncomingMessage,
  ClientRequest,
  ServerResponse,
} from 'http';
import { createServer as createHttpsServer, request as httpsRequest, ServerOptions as HttpsServerOptions } from 'https';
import { createSecureContext, SecureContext } from 'tls';

export class ProxyEntry {
  domain: string;
  target: string;
  redirectToHttps: boolean;
  redirectToUrl: string;
  cors: boolean;

  constructor(p: Partial<ProxyEntry>) {
    Object.assign(this,  p);
  }
}

export class ProxyServer {
  protected certs: Record<string, SecureContext> = {};
  protected targets: Record<string, ProxyEntry> = {};
  protected servers: any = [];

  start() {
    this.reload();
    this.servers.forEach((server: any) => server.close());

    this.servers = [
      createHttpServer((req, res) => this.serveRequest(req, res, true)).listen(80),
      createHttpsServer(this.getSslOptions(), (req, res) => this.serveRequest(req, res)).listen(443),
    ];
  }

  reload() {
    this.loadCertificates();
    this.loadTargets();
  }

  protected async loadCertificates() {
    const certs = (this.certs = {});

    const localCerts = await readdir(certificatesFolder, { withFileTypes: true });
    const folders = localCerts.filter((entry) => entry.isDirectory()).map((dir) => dir.name);

    for (const rootDomain of folders) {
      if (process.env.DEBUG) {
        console.log(`Loading certificate for ${rootDomain}`);
      }

      certs[rootDomain] = createSecureContext({
        cert: await readFile(join(certificatesFolder, rootDomain, certificateFile), 'utf8'),
        key: await readFile(join(certificatesFolder, rootDomain, keyFile), 'utf8'),
      });
    }
  }

  protected async loadTargets() {
    const targets = await Resource.find(ProxyEntry, new Query());
    this.targets = {};
    targets.forEach((entry) => (this.targets[entry.domain] = entry));
  }

  protected serveRequest(req: IncomingMessage, res: ServerResponse, insecure = false) {
    const origin = this.getOrigin(req);
    const proxyEntry = this.targets[origin?.hostname];

    if (!origin.hostname || !proxyEntry) {
      res.writeHead(404, 'Not found');
      res.end();
      return;
    }

    if (proxyEntry.redirectUrl) {
      res.setHeader('Location', String(proxyEntry.redirectUrl));
      res.writeHead(302, 'Moved somewhere else');
      res.end();
      return;
    }

    if (proxyEntry.redirect && insecure) {
      const newURL = new URL(req.url, `https://${req.headers.host}`);
      res.setHeader('Location', String(newURL));
      res.writeHead(301, 'HTTPS is better');
      res.end();
      return;
    }

    const target = proxyEntry.target;
    const url = new URL(req.url, target);

    const isCorsPreflight = req.method === 'OPTIONS' && proxyEntry.cors;
    if (isCorsPreflight) {
      this.setCorsHeaders(req, res);
      res.writeHead(204, { 'Content-Length': '0' });
      res.end();
      return;
    }

    const proxyRequest = (url.protocol === 'https:' ? httpsRequest : httpRequest)(url, { method: req.method });
    this.setHeaders(req, proxyRequest);
    proxyRequest.setHeader('host', this.getHost(target));
    proxyRequest.setHeader('x-forwarded-for', req.headers.host);
    proxyRequest.setHeader('x-forwarded-proto', insecure ? 'http' : 'https');
    proxyRequest.setHeader('forwarded', 'host=' + req.headers.host + ';proto=' + (insecure ? 'http' : 'https'));

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
          return cb(null, rootDomain);
        }

        cb(new Error('Not found', { cause: 404 }), null);
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

  protected getOrigin(req: IncomingMessage): URL {
    const host = req.headers['x-forwarded-for'] || req.headers.host || '';
    return (host && new URL('http://' + host)) || null;
  }

  protected getHost(string: string) {
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
    console.error(error);

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