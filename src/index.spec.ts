import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { ProxyServer, ProxySettings, loadConfig } from '.';
import { IncomingMessage, ServerResponse, createServer } from 'node:http';

const port = 2000 + ~~(Math.random() * 1000);
const serverTarget = 'http://localhost:' + port;

let targetServer;

beforeAll(() => {
  targetServer = createServer((req, res) => {
    res.writeHead(200);
    Object.entries(req.headers).forEach(([key, value]) => res.write(`${key}: ${value}\n`));
    res.end('\n\n' + req.method + ' ' + req.url);
  }).listen(port);
});

afterAll(() => {
  targetServer.close();
});

describe('ProxySettings', () => {
  it('should have default values', () => {
    process.env.PROXY_CERTS_FOLDER = '/var/run/ssl';

    const settings = new ProxySettings();
    expect(settings.certificatesFolder).toBe('/var/run/ssl');
    expect(settings.certificateFile).toBe('fullchain.pem');
    expect(settings.keyFile).toBe('privkey.pem');
    expect(settings.httpPort).toBe(80);
    expect(settings.httpsPort).toBe(443);
  });
});

describe('ProxyServer', () => {
  interface ResponseExtras {
    body: any;
    headers: any;
  }

  function setup(moreSettings = {}) {
    const getPort = () => Math.floor(2000 + Math.random() * 5000);
    const settings = new ProxySettings({
      certificatesFolder: process.cwd() + '/certs',
      certificateFile: 'cert.crt',
      keyFile: 'key.crt',
      httpPort: getPort(),
      httpsPort: getPort(),
      autoReload: 0,
      ...moreSettings,
    });

    const server = new ProxyServer(settings);

    function createRequest(method: string, url: URL, headers = {}) {
      let resolve: any;
      const events: any = {
        data() {},
        end() {},
      };

      const req: Partial<IncomingMessage> = {
        method,
        url: url.pathname,
        headers: {
          host: url.hostname,
          ...headers,
        },
        on: (e, f) => (events[e] = f),
      };

      const res: Partial<ServerResponse> & ResponseExtras = {
        body: '',
        headers: {},
        setHeader: (k, v) => (res.headers[k] = v) as any,
        writeHead: vi.fn(() => res) as any,
        write: vi.fn((c) => (res.body += c)),
        end: vi.fn(() => resolve()),
      };

      const promise = new Promise((r) => (resolve = r));

      return {
        req: req as unknown as IncomingMessage,
        res: res as unknown as ServerResponse & ResponseExtras,
        events,
        promise,
      };
    }

    return { server, settings, createRequest };
  }

  it('should respond with 404', async () => {
    const { server, createRequest } = setup();
    const { req, res, promise } = createRequest('GET', new URL('http://example.com/notFound'));

    await server.start();
    server.handleRequest(req, res, false);

    await promise;

    expect(res.writeHead).toHaveBeenCalledWith(404, 'Not found');
    expect(res.end).toHaveBeenCalledWith();
    expect(res.body).toBe('');

    server.reset();
  });

  it('should add extra headers to request', async () => {
    const { server } = setup();

    await server.start();
    server.add({
      domain: 'localhost',
      target: serverTarget,
      headers: 'x-key:    value |    authorization: key',
    });

    const f = await fetch('http://localhost:' + server.ports.httpPort);
    const response = await f.text();

    expect(response).toContain('x-key: value');
    expect(response).toContain('authorization: key');

    server.reset();
  });

  it('should ask for authentication', async () => {
    const { server, createRequest } = setup();
    const { req, res, promise } = createRequest('GET', new URL('http://example.com/test'));

    await server.start();
    server.add({
      domain: 'example.com',
      target: serverTarget,
      redirectToHttps: false,
      authorization: 'dGVzdDp0ZXN0',
    });

    server.handleRequest(req, res, false);
    await promise;

    expect(res.writeHead).toHaveBeenCalledWith(401);
    expect(res.headers['WWW-Authenticate']).toBe('Basic realm="Y u no password"');

    server.reset();
  });

  it('should allow requests that need authentication', async () => {
    const { server, createRequest } = setup();
    const { req, res, promise } = createRequest('GET', new URL('http://example.com/test'), { 'authorization': 'Basic dGVzdDp0ZXN0' });

    await server.start();
    server.add({
      domain: 'example.com',
      target: serverTarget,
      redirectToHttps: false,
      authorization: 'dGVzdDp0ZXN0',
    });

    server.handleRequest(req, res, false);
    await promise;

    expect(res.headers['WWW-Authenticate']).not.toBeDefined();

    server.reset();
  });

  it('should proxy an HTTP request', async () => {
    const { server, createRequest } = setup();
    const { req, res, events, promise } = createRequest('GET', new URL('http://example.com/test'));

    await server.start();
    server.add({
      domain: 'example.com',
      target: serverTarget,
      redirectToHttps: false,
    });

    server.handleRequest(req, res, false);

    events.data('OK');
    events.end();

    await promise;

    expect(res.writeHead).toHaveBeenCalledWith(200, 'OK');
    expect(res.end).toHaveBeenCalledWith();

    expect(res.body).toContain('x-forwarded-for: example.com');
    expect(res.body).toContain('x-forwarded-proto: http');
    expect(res.body).toContain('GET /test');

    server.reset();
  });

  it('should redirect to HTTPS', async () => {
    const { server, createRequest } = setup();
    const { req, res, promise } = createRequest('GET', new URL('http://example.com/redirectHttps'));

    await server.start();
    server.add({
      domain: 'example.com',
      target: serverTarget,
      redirectToHttps: true,
    });

    server.handleRequest(req, res, false);

    await promise;

    expect(res.writeHead).toHaveBeenCalledWith(301, 'HTTPS is better');
    expect(res.end).toHaveBeenCalledWith();
    expect(res.body).toBe('');

    server.reset();
  });

  it('should redirect to another domain, keeping the same protocol and URL', async () => {
    const { server, createRequest } = setup();
    const { req, res, events, promise } = createRequest('GET', new URL('http://example.com/redirectDomain'));

    await server.start();

    server.add({
      domain: 'example.com',
      redirectToDomain: 'redirect.com',
    });

    server.handleRequest(req, res, false);

    events.data('OK');
    events.end();

    await promise;

    expect(res.writeHead).toHaveBeenCalledWith(302, 'Moved somewhere else');
    expect(res.headers.Location).toBe('https://redirect.com/redirectDomain');
    expect(res.end).toHaveBeenCalledWith();
    expect(res.body).toBe('');

    server.reset();
  });

  it('should redirect to another URL', async () => {
    const { server, createRequest } = setup();
    const { req, res, events, promise } = createRequest('GET', new URL('http://example.com/redirectUrl'));

    await server.start();
    server.add({
      domain: 'example.com',
      redirectToUrl: 'http://another.example.com/foo',
    });

    server.handleRequest(req, res, false);

    events.data('OK');
    events.end();

    await promise;

    expect(res.writeHead).toHaveBeenCalledWith(302, 'Moved somewhere else');
    expect(res.headers.Location).toBe('http://another.example.com/foo');
    expect(res.end).toHaveBeenCalledWith();
    expect(res.body).toBe('');

    server.reset();
  });

  it('should set CORS headers and finish request', async () => {
    const { server, createRequest } = setup();
    const { req, res, promise } = createRequest('OPTIONS', new URL('http://example.com/cors'), {
      origin: 'http://example.com/',
    });

    await server.start();
    server.add({
      domain: 'example.com',
      target: serverTarget,
      cors: true,
    });

    server.handleRequest(req, res, false);
    await promise;

    expect(res.writeHead).toHaveBeenCalledWith(204, { 'Content-Length': '0' });
    expect(res.end).toHaveBeenCalledWith();
    expect(res.body).toBe('');

    server.reset();
  });

  it('should set CORS headers and finish request', async () => {
    const fallback = vi.fn((_req, res) => res.writeHead(200).end());
    const { server, createRequest } = setup({ fallback });
    const { req, res, promise } = createRequest('GET', new URL('http://example.com/test'));

    await server.start();
    server.add({
      domain: 'example.com',
      target: serverTarget,
      cors: true,
    });

    server.handleRequest(req, res, false);
    await promise;

    expect(res.writeHead).toHaveBeenCalledWith(204, { 'Content-Length': '0' });
    expect(res.end).toHaveBeenCalledWith();
    expect(fallback).toHaveBeenCalledWith(req, res);

    server.reset();
  });
});

it('should load config from a file', async () => {
  const configEsm = await loadConfig('./proxy.config.mjs');
  const configJson = await loadConfig('./proxy.config.json');

  expect(configEsm.autoReload).toBe(123);
  expect(configJson.autoReload).toBe(456);
})