import { createServer } from 'node:http';
import { ProxyServer, ProxySettings } from '.';

let port: number;
let server: any;

const getPort = () => 1000 + Math.floor(Math.random() * 55000);

beforeAll(() => {
  server && server.close();
  server = createServer((req, res) => {
    console.log(req.url);
    res.write(req.method + ' ' + req.url);

    Object.entries(req.headers).forEach(([key, value]) => res.write(`${key}: ${value}`));

    res.write('\n\n');
    req.on('data', (c) => res.write(c));
    res.end('\n\n>> OK');
  });
  port = getPort();
  server.listen(port);
});

afterAll(() => {
  server && server.close();
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
  function setup() {
    const settings = new ProxySettings({
      certificatesFolder: process.cwd() + '/certs',
      httpPort: getPort(),
      httpsPort: getPort(),
    });

    const server = new ProxyServer(settings);
    const httpRequest = async (path = '') => {
      const url = `http://localhost:${settings.httpPort}${path}`;
      const r = await globalThis.fetch(url);
      return r.ok ? await r.text() : r.status + ' FAIL';
    };

    return { server, settings, httpRequest };
  }

  it('should proxy an HTTP request', async () => {
    const { server, settings, httpRequest } = setup();
    server.start();
    server.add({ domain: 'foo.local', target: 'http://localhost:' + settings.httpPort });

    const response = await httpRequest('/test');
    expect(response).not.toContain('FAIL');
    expect(response).toContain('GET /test');
    expect(response.includes()).toBe(true);
    expect(response.includes('x-forwarded-for: localhost')).toBe(true);
    expect(response.includes('x-forwarded-proto: http')).toBe(true);
  });
});
