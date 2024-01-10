import { existsSync } from "node:fs";
import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { ProxyServer, ProxySettings, ProxyEntry } from "./index.js";

interface ProxyConfigFile extends Partial<ProxySettings> {
  proxies?: ProxyEntry[];
}

async function getConfig(): Promise<ProxyConfigFile> {
  const configModuleFile = join(process.cwd(), "proxy.config.mjs");
  const configJsonFile = join(process.cwd(), "proxy.config.json");

  if (existsSync(configModuleFile)) {
    return await import(configModuleFile);
  }

  if (existsSync(configJsonFile)) {
    return JSON.parse(await readFile(configJsonFile, "utf-8"));
  }

  return {};
}

(async () => {
  const { proxies = [], ...config } = await getConfig();
  const settings = new ProxySettings(config);
  const server = new ProxyServer(settings);

  server.start();

  for (const entry of proxies) {
    server.add(new ProxyEntry(entry));
  }

  console.log('Proxy started on ports %d and %d', settings.httpPort, settings.httpsPort);
})();
