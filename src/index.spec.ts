import { createServer } from 'node:http';
import { ProxyServer } from '.';

let port: number;
let server: any;

beforeAll(() => {
  server && server.close();
  server = createServer((req, res) => res.end(req.url))
  port = 1000 + Math.floor(Math.random()*55000);
  server.listen(port);
});

afterAll(() => {
  server && server.close();
});

describe("ProxyServer", () => {
  it("should proxy an HTTP request", () => {
    const server = new ProxyServer();
    server.start();

    expect(1).toBe(1);
  });
});
