# @cloud-cli/proxy

HTTP(S) Proxy server

## Settings

**certificatesFolder:**

The server automatically loads SSL certificates from a folder, where each subfolder is a domain name.
Sub-domains are automatically resolved to their parent domain when requested.
`sub.example.com` will use the certificate from `example.com` if available.

For example, to load certs for `*.foo.com` and `*.example.com`:

```js
const settings = new ProxySettings({
  certificatesFolder: '/var/ssl',
  certificateFile: 'cert.pem',
  keyFile: 'cert.key',
});
```

```sh
$ ls /var/ssl/*

/var/ssl/foo.com:
cert.pem
cert.key

/var/ssl/example.com:
cert.pem
cert.key
```

**certificateFile/keyFile:**

Names of the files from where certificates are loaded.

Defaults:

```js
const settings = new ProxySettings({
  certificateFile = 'fullchain.pem';
  keyFile = 'privkey.pem';
});
```

**httpPort/httpsPort:**

Allow you to change the http ports. Defaults are `80` and `443`.
Set to zero if you want to disable http or https connections.

```js
const settings = new ProxySettings({
  httpPort: 3000,
  httpsPort: 3443,
});
```

**headers:**

Adds headers to the proxy request transparently, so API calls can be proxied without exposing credentials.

Use key/value pairs separated by a bar. Spaces around are ignored.

Example `authentication: bearer abc123 | x-custom-header: 123`

**authorization:**

Add this option to request user authentication on client/side via headers.
This activates the HTTP Basic authentication. The value on this field should be `user:password` encoded as `base64`.

**fallback:**

If you want to use the proxy instance as a middleware, add `fallback` as an option, with a function that can handle a request.
When `server.onRequest` is called, and no proxy entries we matched by a request, the fallback function will be called instead.

## API

```ts
import { ProxyServer, ProxySettings, ProxyEntry } from '@cloud-cli/proxy';

// set up the proxy instance
const settings = new ProxySettings({ ... });

// create a server
const server = new ProxyServer(settings);

// create internal HTTP/HTTPS servers
server.createServers();

// start HTTP/HTTPS servers
server.start();

// add a proxy entry
server.add(new ProxyEntry({...}));

// use it to reset all proxy entries and close running HTTP ports
server.reset();

// reload certificates for all proxy entries.
// each server reloads all certificates once per day
server.reload();

// OPTIONAL: handle a request coming from another http(s) server
server.onRequest(request, response, /* isSSL */ false);

// OPTIONAL: handle a request coming from a websocket upgrade
server.onUpgrade(request, socket, head, /* isSSL */ false);
```

## Example

```ts
import { ProxyServer, ProxySettings, ProxyEntry } from '@cloud-cli/proxy';

const settings = new ProxySettings({
  certificatesFolder: '/path/to/ssl',
});

const server = new ProxyServer(settings);
server.start();

// http://example.com => (redirect 302) https://www.example.com/
server.add(
  new ProxyEntry({
    domain: 'example.com',
    redirectToDomain: 'www.example.com',
  }),
);

// http://old.example.com => (redirect 302) https://www.example.com/
server.add(
  new ProxyEntry({
    domain: 'old.example.com',
    redirectToUrl: 'https://www.example.com/',
  }),
);

// http://www.example.com => (forward to) http://localhost:1234/
server.add(
  new ProxyEntry({
    domain: 'www.example.com',
    target: 'http://localhost:1234/',
  }),
);
```

## Environment variables

| var                | description                                        |
| ------------------ | -------------------------------------------------- |
| DEBUG              | Enable debug logging                               |
| PROXY_CERTS_FOLDER | Path to a folder where SSL certificates are stored |
| HTTP_PORT          | Number. Same as `ProxySettings#httpPort`           |
| HTTPS_PORT         | Number. Same as `ProxySettings#httpsPort`          |

## http-proxy

This module also provides an executable to run as a standalone server.

Options can be either provided as a JSON file (`proxy.config.json`) or an ES module (`proxy.config.mjs`).
The format is defined in [src/cli.mts](src/cli.mts). It is the same as `ProxySettings` + an array of `ProxyEntry`;

To run the proxy, just call `http-proxy` in the same folder as the configuration file:

```
$ http-proxy
```

## Full configuration

```json
{
  "httpPort": 80,
  "httpsPort": 443,
  "autoReload": 3600,
  "certificatesFolder": "/etc/ssl",
  "certificateFile": "fullchain.pem",
  "keyFile": "privkey.pem",
  "proxies": [
    {
      "domain": "example.com",
      "redirectToDomain": "www.example.com"
    },
    {
      "domain": "old.example.com",
      "redirectToUrl": "https://www.example.com"
    },
    {
      "domain": "www.example.com",
      "headers": "x-key: deadbeef",
      "target": "http://localhost:1234/"
    }
  ]
}
```

## Configuration from file

```ts
import { loadConfig } from '@cloud-cli/proxy';

loadConfig('./proxy.config.json')
```
