# @cloud-cli/proxy

HTTP(S) Proxy server

## Settings

**certificatesFolder:**

The server automatically loads SSL certificates from a folder, where each subfolder is a domain name.
Sub-domains are automatically resolved to their parent domain when requested.
`sub.example.com` will use the certificate from `example.com` if available.

For example, loads certs for `*.foo.com` and `*.example.com`:

```js
certificatesFolder = "/var/ssl";
```

And in that folder, have "foo.com" and "example.com" as subfolders.

**certificateFile/keyFile:**

Names of the files from where certificates are loaded. Defaults are:

```js
certificateFile = "fullchain.pem";
keyFile = "privkey.pem";
```

**httpPort/httpsPort:**

Allow you to change the http ports. Defaults are `80` and `443`;

## API

```ts
import { ProxyServer, ProxySettings, ProxyEntry } from '@cloud-cli/proxy';

const settings = new ProxySettings({
  certificatesFolder: '/path/to/ssl',
});

const server = new ProxyServer(settings);

server.start();

server.add(new ProxyEntry({
  domain: 'example.com',
  redirectToDomain: 'www.example.com',
}));

server.add(new ProxyEntry({
  domain: 'old.example.com',
  redirectToUrl: 'https://www.example.com/',
}));

server.add(new ProxyEntry({
  domain: 'www.example.com',
  target: 'http://localhost:1234/',
}));

```

## Environment variables

| var | description |
|-|-|
| DEBUG | Enable debug logging |
| PROXY_CERTS_FOLDER | Path to a folder where SSL certificates are stored |
