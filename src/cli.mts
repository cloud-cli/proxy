import { ProxyServer, ProxySettings, ProxyEntry, loadConfig } from "./index.js";

(async () => {
  try {
    const { proxies = [], ...config } = await loadConfig();
    const settings = new ProxySettings(config);
    const server = new ProxyServer(settings);

    server.start();

    for (const entry of proxies) {
      server.add(new ProxyEntry(entry));
    }

    console.log(
      "Proxy started on ports %d (http) and %d (https)",
      settings.httpPort,
      settings.httpsPort
    );
  } catch (error) {
    console.error(error);
    console.log("See https://github.com/cloud-cli/proxy/blob/main/README.md");
    process.exit(1);
  }
})();
