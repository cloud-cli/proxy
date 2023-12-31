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
  certificatesFolder = "/var/ssl",
  certificateFile = "cert.pem",
  keyFile = "cert.key",
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
certificateFile = 'fullchain.pem';
keyFile = 'privkey.pem';
```

**httpPort/httpsPort:**

Allow you to change the http ports. Defaults are `80` and `443`;

## Usage

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
server.handleRequest(request, response, /* isSSL */ false);
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
