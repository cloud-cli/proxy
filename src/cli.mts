import { ProxyServer, ProxySettings, ProxyEntry, loadConfig } from "./index.js";

(async () => {
  try {
    const { proxies = [], ...config } = await loadConfig();
    const settings = new ProxySettings(config);
    const server = new ProxyServer(settings);

    for (const entry of proxies) {
      server.add(new ProxyEntry(entry));
    }

    await server.start();

    if (process.env.DEBUG) {
      console.log(
        "Proxy started on ports %d (http) and %d (https)",
        settings.httpPort,
        settings.httpsPort
      );
    }
  } catch (error) {
    if (process.env.DEBUG) {
      console.error(String(error));
      console.log("See https://github.com/cloud-cli/proxy?tab=readme-ov-file#http-proxy");
    }
    process.exit(1);
  }
})();
